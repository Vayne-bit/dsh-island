import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readConfig, writeConfig, CONFIG_FILE, DEFAULTS, resolve } from './config.js'

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

// 设置页的两条路由。宿主 webServer.register 不自带鉴权（只有 /api 前缀有栅栏，
// 而 exact 路由优先于前缀、会绕过它），所以这里自己做一层最小校验：
// 只认回环 Host、拒绝跨站标记、Origin 必须同源、写请求必须来自本机。
function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return !!m && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

function reject(req) {
  try {
    const h = (req && req.headers) || {}
    let host = null
    try { host = new URL('http://' + String(h.host || '')) } catch (err) { return 403 }
    if (!isLoopback(host.hostname)) return 403
    if (String(h['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = h.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let o = null
      try { o = new URL(origin) } catch (err) { return 403 }
      if (o.host.toLowerCase() !== host.host.toLowerCase()) return 403
    }
    return null
  } catch (err) { return 403 }
}

function sendJson(res, code, body) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch (err) {}
}

const HEARTBEAT_MS = 3000
const DONE_TTL = 3000
const FAIL_TTL = 6000

const FAIL_KINDS = new Set(['error', 'blocked', 'max-tokens'])
const QUIET_KINDS = new Set(['aborted', 'interrupted', 'forked'])

export default {
  name: 'dsh-island-overlay',
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
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), items: [...items.values()], cfg: readConfig() }), 'utf8')
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
        // since = 这一回合的开始时间，只有 turn/start 能改它。
        // 以前 approval/asked、approval/decided、tool/call 都把它重置成 now，
        // 于是「思考 20 分钟 → 弹审批 → 继续思考」的计时会从 0 重新数。
        switch (type) {
          case 'turn/start':
            touch(sid, { state: 'thinking', detail: '', since: Date.now(), title: name })
            break
          case 'approval/asked':
            touch(sid, { state: 'approval', detail: String(data.toolName || '需要授权'), title: name })
            break
          case 'approval/decided':
            if (items.has(sid)) touch(sid, { state: 'thinking', detail: '', title: name })
            break
          case 'tool/call':
            if (String(data.name || '') === 'ask_user_question') {
              touch(sid, { state: 'ask', detail: '等待你的回答', title: name })
            }
            break
          case 'tool/result': {
            const cur = items.get(sid)
            if (cur && cur.state === 'ask') touch(sid, { state: 'thinking', detail: '', title: name })
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

    // 设置页：GET 读配置，POST 写配置。只给本机同源页面用。
    try {
      root.inject(['webServer'], (ctx) => {
        try {
          root.effect(() => ctx.webServer.register({
            kind: 'exact', path: '/dsh-island/config.json',
            handler: async (req, res) => {
              const deny = reject(req)
              if (deny) { sendJson(res, deny, { error: 'forbidden' }); return }
              const method = String((req && req.method) || 'GET').toUpperCase()
              if (method === 'GET') { sendJson(res, 200, { cfg: readConfig() }); return }
              if (method !== 'POST') { sendJson(res, 405, { error: 'method' }); return }
              let body = ''
              try {
                for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('too large') }
                const patch = JSON.parse(body || '{}').patch
                if (!patch || typeof patch !== 'object') throw new Error('bad patch')
                const cfg = writeConfig(patch)
                flush()
                sendJson(res, 200, { cfg })
              } catch (err) {
                sendJson(res, 400, { error: 'bad request' })
              }
            },
          }), 'dsh-island: config route')
          root.effect(() => ctx.webServer.register({
            kind: 'exact', path: '/dsh-island/config.json/defaults',
            handler: async (req, res) => {
              if (reject(req)) { sendJson(res, 403, { error: 'forbidden' }); return }
              sendJson(res, 200, { cfg: writeConfig(resolve(DEFAULTS)) })
              flush()
            },
          }), 'dsh-island: defaults route')
        } catch (err) { log('routes failed: ' + ((err && err.message) || err)) }
      })
    } catch (err) { log('inject failed: ' + ((err && err.message) || err)) }

    try {
      disposers.push(root.on('session/event', onEvent))
      disposers.push(root.on('session/disposed', (s) => {
        try { if (s && s.id) drop(String(s.id)) } catch (err) {}
      }))
      flush()
      // 设置页改了配置 → 立刻推给浮层（浮层 400ms 轮询状态文件，这里只要重写一次）
      try { fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => { try { flush() } catch (err) {} }) } catch (err) {}
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
        try { fs.unwatchFile(CONFIG_FILE) } catch (err) {}
        try { for (const t of timers.values()) clearTimeout(t) } catch (err) {}
        try { for (const d of disposers) d() } catch (err) {}
        stopOverlay()
      })
    } catch (err) {}
  }
}
