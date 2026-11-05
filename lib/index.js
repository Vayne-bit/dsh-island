import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(HERE, '..')
const OVERLAY_DIR = path.join(PKG, 'overlay')
// 宿主进程自己就是 DeepSeek Harness.exe（以 ELECTRON_RUN_AS_NODE 模式跑），拿它当 Electron 用。
// 但安装目录里有 resources/app.asar，Electron 会优先加载它、忽略命令行给的 app 目录，
// 所以要把运行时镜像一份到别处（不带 app.asar），浮层才跑得起来。
const ELECTRON_EXE = process.execPath
const IS_ELECTRON = /deepseek harness|electron/i.test(path.basename(ELECTRON_EXE))
const RUNTIME_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.dsh'), 'dsh-island-runtime')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'dsh-island-state.json')
const LOG_FILE = path.join(DSH_HOME, 'dsh-island-plugin.log')

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`) } catch (err) {}
}

// 把 DSH 的 Electron 运行时镜像到 RUNTIME_DIR（同盘用硬链接，不占空间），
// 关键是不带 resources/app.asar —— 有它 Electron 就会去加载 DSH 自己。
function ensureRuntime() {
  const exe = path.join(RUNTIME_DIR, path.basename(ELECTRON_EXE))
  const marker = path.join(RUNTIME_DIR, 'resources', 'default_app.asar')
  if (fs.existsSync(exe) && fs.existsSync(marker)) return exe

  const src = path.dirname(ELECTRON_EXE)
  fs.mkdirSync(path.join(RUNTIME_DIR, 'resources'), { recursive: true })
  const put = (s, d) => {
    try { fs.linkSync(s, d) } catch (err) { try { fs.copyFileSync(s, d) } catch (e) {} }
  }
  for (const name of fs.readdirSync(src)) {
    if (name === 'resources') continue
    const s = path.join(src, name)
    const d = path.join(RUNTIME_DIR, name)
    if (fs.existsSync(d)) continue
    try {
      if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true })
      else put(s, d)
    } catch (err) {}
  }
  put(path.join(src, 'resources', 'default_app.asar'), marker)
  log('runtime prepared: ' + RUNTIME_DIR)
  return exe
}

const HEARTBEAT_MS = 3000
const DONE_TTL = 3000
const FAIL_TTL = 6000

const FAIL_KINDS = new Set(['error', 'blocked', 'max-tokens'])
const QUIET_KINDS = new Set(['aborted', 'interrupted', 'forked'])

export default {
  name: 'dsh-island',
  apply(root) {
    const items = new Map() // sid -> { id, title, state, detail, since }
    const timers = new Map()
    const disposers = []
    let child = null
    let beat = null

    function flush() {
      try {
        fs.mkdirSync(DSH_HOME, { recursive: true })
        const tmp = STATE_FILE + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), items: [...items.values()] }), 'utf8')
        fs.renameSync(tmp, STATE_FILE)
      } catch (err) {}
    }

    function touch(sid, patch) {
      try {
        const cur = items.get(sid) || { id: sid, title: '', state: 'thinking', detail: '', since: Date.now() }
        Object.assign(cur, patch)
        items.set(sid, cur)
        if (timers.has(sid)) { clearTimeout(timers.get(sid)); timers.delete(sid) }
        const ttl = patch.state === 'done' ? DONE_TTL : patch.state === 'failed' ? FAIL_TTL : 0
        if (ttl > 0) {
          timers.set(sid, setTimeout(() => {
            try { items.delete(sid); flush() } catch (err) {}
          }, ttl))
        }
        flush()
      } catch (err) {}
    }

    function drop(sid) {
      try {
        if (timers.has(sid)) { clearTimeout(timers.get(sid)); timers.delete(sid) }
        if (items.delete(sid)) flush()
      } catch (err) {}
    }

    function titleOf(session) {
      try {
        const svc = typeof root.get === 'function' ? root.get('sessionTitle') : null
        if (svc && typeof svc.get === 'function' && session) {
          const snap = svc.get(session)
          const t = typeof snap === 'string' ? snap : (snap && (snap.title || snap.text))
          if (t) return String(t).trim().slice(0, 80)
        }
      } catch (err) {}
      try {
        for (const v of [session && session.name, session && session.title, session && session.label]) {
          const s = String(v == null ? '' : v).trim()
          if (s) return s.slice(0, 80)
        }
      } catch (err) {}
      return ''
    }

    function onEvent(session, event) {
      try {
        const sid = session && session.id ? String(session.id) : ''
        if (!sid) return
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}

        if (type === 'session/title') {
          const t = String(data.title == null ? '' : data.title).trim()
          const cur = items.get(sid)
          if (cur && t) { cur.title = t.slice(0, 80); flush() }
          return
        }

        const name = titleOf(session)
        switch (type) {
          case 'turn/start':
            touch(sid, { state: 'thinking', detail: '', since: Date.now(), title: name })
            break
          case 'approval/asked':
            touch(sid, { state: 'approval', detail: String(data.toolName || '需要授权'), since: Date.now(), title: name })
            break
          case 'approval/decided':
            if (items.has(sid)) touch(sid, { state: 'thinking', detail: '', since: Date.now(), title: name })
            break
          case 'tool/call':
            if (String(data.name || '') === 'ask_user_question') {
              touch(sid, { state: 'ask', detail: '等待你的回答', since: Date.now(), title: name })
            }
            break
          case 'tool/result': {
            const cur = items.get(sid)
            if (cur && cur.state === 'ask') touch(sid, { state: 'thinking', detail: '', since: Date.now(), title: name })
            break
          }
          case 'turn/end': {
            const reason = data.reason || {}
            const kind = String(reason.kind || '')
            if (QUIET_KINDS.has(kind)) { drop(sid); break }
            if (FAIL_KINDS.has(kind)) {
              const msg = (reason.error && (reason.error.message || reason.error.detail)) || kind
              touch(sid, { state: 'failed', detail: String(msg).split('\n')[0].slice(0, 60), since: Date.now(), title: name })
            } else {
              touch(sid, { state: 'done', detail: '', since: Date.now(), title: name })
            }
            break
          }
        }
      } catch (err) {}
    }

    // 用 DSH 自己的 Electron 跑浮层（npm 缓存里那份 41.7.1 在本机一启动就 0xC0000005）
    function startOverlay() {
      try {
        if (!IS_ELECTRON || !fs.existsSync(OVERLAY_DIR)) { log('skip: isElectron=' + IS_ELECTRON); return }
        const exe = ensureRuntime()
        const env = {}
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
        // 宿主带着它，子进程会退化成纯 node（键名大小写不保证，按不区分大小写删）
        for (const k of Object.keys(env)) if (/^electron_run_as_node$/i.test(k)) delete env[k]
        log('spawn ' + exe)
        child = spawn(exe, [OVERLAY_DIR], { detached: true, stdio: 'ignore', windowsHide: true, env })
        child.on('error', (e) => { log('spawn error: ' + ((e && e.message) || e)); child = null })
        child.on('exit', (code) => { log('overlay exited code=' + code); child = null }) // 挂了要能被心跳重新拉起来
        child.unref()
      } catch (err) { log('startOverlay failed: ' + ((err && err.message) || err)); child = null }
    }

    function stopOverlay() {
      try {
        if (!child || !child.pid) return
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
        child = null
      } catch (err) {}
    }

    try {
      disposers.push(root.on('session/event', onEvent))
      disposers.push(root.on('session/disposed', (s) => {
        try { if (s && s.id) drop(String(s.id)) } catch (err) {}
      }))
      flush()
      if (process.env.DSH_ISLAND_NO_OVERLAY !== '1') startOverlay()
      beat = setInterval(() => {
        try { flush() } catch (err) {}
        // 浮层被关掉/崩了但有状态要显示时，自己再拉一个回来
        try { if (process.env.DSH_ISLAND_NO_OVERLAY !== '1' && !child && items.size > 0) startOverlay() } catch (err) {}
      }, HEARTBEAT_MS)
      if (beat.unref) beat.unref()
    } catch (err) {}

    try {
      root.effect(() => () => {
        try { if (beat) clearInterval(beat) } catch (err) {}
        try { for (const t of timers.values()) clearTimeout(t) } catch (err) {}
        try { for (const d of disposers) d() } catch (err) {}
        stopOverlay()
      })
    } catch (err) {}
  }
}
