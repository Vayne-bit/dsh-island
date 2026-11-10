import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
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
// 浮层 → 宿主：气泡决定与前台状态。沿用本项目文件式传输（同 state 文件），
// 避免浮层自己去猜宿主 webServer 的 host/port。
const ANSWERS_FILE = path.join(DSH_HOME, 'dsh-island-answers.json')
const FOREGROUND_FILE = path.join(DSH_HOME, 'dsh-island-foreground.json')

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

// 气泡优先期：审批/提问进来后，这段时间里只等悬浮球里的气泡作答；超时未答
// 才交给官方卡片兜底（waterfall next()）。之前是 20s/60s，太短会让“用户在气
// 泡里点了却因超时被抢走而不生效”。窗口拉长到 30 分钟，保证气泡在屏期间
// 用户随时点都生效；只有 30 分钟都没人理气泡才转官方兜底/取消。
// 自检/排错时可用 DSH_ISLAND_BUBBLE_MS（毫秒）临时改小。
const BUBBLE_MS = Number(process.env.DSH_ISLAND_BUBBLE_MS) || 30 * 60 * 1000

// 浮层可见性心跳：浮层每 5 秒重报一次「我可见」。超过这个时间没报就当它没了，
// 审批立刻交回官方卡片。没有这条，浮层崩溃后宿主会一直以为它还在屏幕上。
const VISIBLE_TTL = 20000

export default {
  name: 'dsh-island-overlay',
  apply(root) {
    const items = new Map() // sid -> { id, title, state, detail, since }
    const timers = new Map()
    const disposers = []
    let child = null
    let beat = null
    // DSH 主窗口是否在前台。浮层通过 dsh-island-foreground.json 上报；
    // 前台时审批/提问不抢气泡、直接委托给官方卡片。
    let foreground = false
    // 浮层自己是否真的可见（全屏应用/心跳过期时会 hide）。浮层不可见时绝不能
    // 拦审批——否则气泡画在隐藏窗口里，用户既看不到气泡、官方卡片也不出现，
    // 一直卡到 BUBBLE_MS（30 分钟）超时才算失败。默认 false：浮层没起来/没上报
    // 之前一律不拦截，宁可走官方卡片。
    let overlayVisible = false
    // 最后一次上报可见性的时刻：浮层崩了/被 kill 就不会再报，
    // 光看 overlayVisible 会把审批永远扣在一个已经不存在的窗口上。
    let visibleAt = 0
    let overlayTokenSeen = false
    // 浮层上报的 token：随每个 pending 下发，answers 必须原样带回才被接受。
    // 防止任意同用户进程往 answers 文件里塞一条就能批准待执行的命令。
    let overlayToken = ''

    // ── 审批 / 提问气泡的宿主应答者 ──────────────────────────────────
    // 我们以 waterfall 应答者身份挂到 approval/request 与 user-questions/request
    // 上：请求进来先写进状态文件让浮层在胶囊旁出气泡；用户在气泡里点选后，
    // 走 POST 路由把决定回填，我们把结果返回给 waterfall。气泡超时未作答则
    // next() 委托给官方卡片兜底（不抢）。
    const pendings = new Map() // id -> { view, resolve, reject, next, timer, settled }
    let pendingSeq = 0

    function sidOf(agent) {
      try {
        if (!agent) return ''
        const s = agent.session || agent
        return s && s.id ? String(s.id) : String(agent.id ?? '')
      } catch (err) { return '' }
    }

    // 结算一个 pending：把用户在气泡里作出的决定填进 waterfall 的 resolve。
    // 供气泡回写路由与应答者内部共用（幂等：已结算/已删除则忽略）。
    // value 对审批是 'allowed-once'/'rejected'（或 next() 委托的结果），
    // 对提问是 { answers:[...] }。
    //
    // 关键：waterfall 的 next() 返回 Promise（官方默认应答者就是
    // () => Promise.resolve('unavailable') / () => Promise.reject(...)）。
    // 直接 rec.resolve(next()) 会把一个未决 Promise 当值交给 DSH，日志里
    // JSON.stringify(Promise) 表现成 {}，DSH 也拿不到真正的决定。
    // 这里统一把 value then 化；允许传 thunk，连 next() 的同步抛错一起兜住。
    function answer(id, value) {
      try {
        const rec = pendings.get(id)
        if (!rec || rec.settled) { log('answer IGNORED ' + id + ' rec=' + (rec ? 'settled' : 'null')); return false }
        rec.settled = true
        clearTimeout(rec.timer)
        pendings.delete(id)
        const sid = rec.view.sessionId
        // 气泡作答/委托后，把会话状态收回“思考”
        if (sid) touch(sid, { state: 'thinking', detail: '' })
        flush()
        Promise.resolve()
          .then(() => (typeof value === 'function' ? value() : value))
          .then((finalValue) => {
            let dump
            try { dump = JSON.stringify(finalValue) } catch (err) { dump = String(finalValue) }
            log('answer OK ' + id + ' value=' + dump.slice(0, 200))
            rec.resolve(finalValue)
          })
          .catch((err) => {
            log('answer FAIL ' + id + ' ' + ((err && err.message) || err))
            if (typeof rec.reject === 'function') rec.reject(err)
            else rec.resolve('cancelled')
          })
        return true
      } catch (err) {
        log('answer THREW ' + id + ' ' + ((err && err.message) || err))
        return false
      }
    }

    // ── 读回浮层写的文件 ──────────────────────────────────────────────
    // 浮层把气泡决定（answers）和 DSH 前台状态（foreground）各自写到独立
    // 小文件，宿主 watchFile 到更新就读进来。answers 用单调递增的 seq 去重，
    // 已处理的条目会从文件里删掉（只删本次处理掉的，不整文件覆盖，避免把
    // 浮层在我们处理期间新追加的决定一起冲掉）。
    let answerSeq = 0 // 已处理到的最大 seq（水位线；seq 用时间戳兜底，跨重启不回退）
    function ingestAnswers() {
      try {
        const raw = fs.readFileSync(ANSWERS_FILE, 'utf8').replace(/^\uFEFF/, '')
        const arr = JSON.parse(raw)
        if (!Array.isArray(arr)) return
        let maxSeq = answerSeq
        const handled = new Set() // 本次可以从文件里删掉的 seq
        for (const entry of arr) {
          const seq = Number(entry && entry.seq)
          if (!Number.isFinite(seq)) { handled.add(seq); continue }
          if (seq <= answerSeq) { handled.add(seq); continue } // 真去重：已处理过
          const id = entry && entry.id
          const rec = id && pendings.get(id)
          // 排错关键：把原始 entry 打出来，一眼看清 answers 到底长什么样
          log('ingestAnswers seq=' + seq + ' id=' + id + ' rec=' + (rec ? 'yes(' + rec.kind + ')' : 'null') +
            ' entry=' + JSON.stringify(entry).slice(0, 300))
          // token 校验：pending 里有 token 时，条目必须原样带回。
          // 挡的是「随便一个同用户进程往文件里塞一条 allowed-once 就批准」。
          if (rec && rec.view.token && entry.token !== rec.view.token) {
            log('ingestAnswers REJECT bad token id=' + id)
            handled.add(seq)
            continue
          }
          let consumed = false
          if (rec) {
            if (entry && entry.action === 'delegate') {
              // 用户点“跳过/转官方” → 委托给官方卡片兜底（next() 是 thunk，由 answer 统一 await）
              answer(id, rec.next ? () => rec.next() : 'cancelled')
              consumed = true
            } else if (rec.kind === 'approval') {
              if (entry.outcome === 'allowed-once' || entry.outcome === 'rejected') { answer(id, entry.outcome); consumed = true }
            } else if (rec.kind === 'ask') {
              if (Array.isArray(entry.answers) && entry.answers.length) { answer(id, { answers: entry.answers }); consumed = true }
            }
            if (!consumed) continue // rec 还在但内容不合法（如空 answers）：保留，等用户改完重提交
          }
          // consumed 或 rec 已不在（被超时/官方接管/abort 结算）：清掉该条目
          handled.add(seq)
          if (consumed && seq > answerSeq) maxSeq = Math.max(maxSeq, seq)
        }
        answerSeq = Math.max(answerSeq, maxSeq)
        if (handled.size) {
          // 重新读一次再按 seq 过滤：浮层可能刚追加了新决定，整文件覆盖会把它丢掉
          let cur = []
          try { cur = JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch (err) {}
          if (!Array.isArray(cur)) cur = []
          const next = cur.filter((e) => !handled.has(Number(e && e.seq)))
          // 与浮层写各自的 tmp，避免两个进程抢同一个中转文件
          const tmp = ANSWERS_FILE + '.host.tmp'
          fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
          fs.renameSync(tmp, ANSWERS_FILE)
        }
      } catch (err) {
        // 首次启动还没有 answers 文件是正常情况，不用刷日志
        if (!err || err.code !== 'ENOENT') log('ingestAnswers FAIL ' + ((err && err.message) || err))
      }
    }

    function ingestForeground() {
      try {
        const raw = fs.readFileSync(FOREGROUND_FILE, 'utf8')
        const fg = JSON.parse(raw)
        const obj = (fg && typeof fg === 'object') ? fg : { fg }
        if (typeof obj.fg === 'boolean') foreground = obj.fg
        // 浮层可见性：只有浮层明确说「我在屏幕上」才允许拦审批。
        // 缺这个字段（旧浮层）按不可见处理——宁可走官方卡片，也不要假死。
        if (typeof obj.visible === 'boolean') {
          overlayVisible = obj.visible
          // 记下它是什么时候说的：浮层崩溃/被 kill 之后不会再说一次，
          // 光看这个布尔值会把审批永远扣在一个已经不存在的窗口上。
          visibleAt = Date.now()
        }
        if (typeof obj.token === 'string') overlayTokenSeen = obj.token === overlayToken
      } catch (err) {}
    }

    // 浮层还在呼吸吗？VISIBLE_TTL 内没再上报就当它没了。
    function overlayAlive() {
      return overlayVisible && (Date.now() - visibleAt) < VISIBLE_TTL
    }

    // 生成一个“气泡优先、超时/中止转官方卡片兜底”的 waterfall 应答者。
    // makeView(req) 构造要写进状态文件的气泡视图（须含唯一的 view.id）；
    // 用户在气泡里作出决定后，浮层写 answers 文件，宿主读回并结算 rec.resolve。
    // 气泡超时未作答 → 把 next() 的结果（Promise）交给 answer 统一 then 化后委托官方卡片；
    // 请求 signal 中止 → 结算为 'cancelled'，与审批服务的取消语义一致。
    function answerer(makeView, enabled) {
      return (req, next) => {
        // DSH 在前台：不拦审批/提问，直接交给官方卡片（气泡不出现）
        if (foreground) { log('answerer skip: foreground before view'); return next() }
        // 浮层不可见（全屏应用/心跳过期被隐藏/还没起来）：也不拦。
        // 这一条是硬要求：气泡画在隐藏窗口里 = 用户看不到、官方卡片也不出现，
        // 一直卡到 30 分钟超时才失败。宁可当场交给官方卡片。
        if (!overlayAlive()) { log('answerer skip: overlay not visible'); return next() }
        // 用户关掉了对应气泡类型：也直接交给官方卡片
        if (enabled && !enabled()) { log('answerer skip: disabled'); return next() }
        let view
        try { view = makeView(req) } catch (err) { return next() }
        const id = view.id
        view.token = ensureToken() // 浮层带回这个 token 才认它的决定
        log('answerer create ' + id + ' kind=' + view.kind + ' tool=' + view.toolName + ' pendingsSize=' + pendings.size)
        let settleResolve, settleReject
        const p = new Promise((res, rej) => { settleResolve = res; settleReject = rej })
        const rec = { view, kind: view.kind, resolve: settleResolve, reject: settleReject, timer: null, settled: false, next }
        pendings.set(id, rec)
        const sid = view.sessionId || ''
        if (sid) touch(sid, { state: view.kind === 'approval' ? 'approval' : 'ask', detail: view.kind === 'approval' ? (view.toolName || '需要授权') : '等待你的回答' })
        flush()
        rec.timer = setTimeout(() => { log('answerer TIMEOUT ' + id); answer(id, () => next()) }, BUBBLE_MS)
        if (req && req.signal && typeof req.signal.addEventListener === 'function') {
          req.signal.addEventListener('abort', () => { log('answerer ABORT ' + id); answer(id, 'cancelled') }, { once: true })
        }
        return p
      }
    }

    // 审批应答者：气泡里出“允许一次 / 拒绝”。返回值为 waterfall 结果词汇。
    const approvalAnswerer = answerer((req) => ({
      id: 'ap' + (++pendingSeq) + '-' + Date.now().toString(36),
      kind: 'approval',
      sessionId: sidOf(req.agent),
      toolName: String(req.toolName || ''),
      callId: req.callId,
      reason: String(req.reason ?? req.displayReason ?? ''),
    }), () => readConfig().bubble.approval)

    // 提问应答者：气泡里出选项/自定义回答。返回 { answers:[{id,selected,custom?}] }。
    const questionAnswerer = answerer((req) => ({
      id: 'q' + (++pendingSeq) + '-' + Date.now().toString(36),
      kind: 'ask',
      sessionId: sidOf(req.agent),
      callId: (req.wait && req.wait.callId) || undefined,
      waitTimed: !!(req.wait && req.wait.timed),
      questions: Array.isArray(req.questions) ? req.questions : [],
    }), () => readConfig().bubble.ask)

    // ── 浮层上报的可见性 + token ─────────────────────────────────────
    // 浮层在 foreground 文件里一并写 { fg, visible, token }。
    // visible=false（全屏应用/心跳过期被隐藏）时宿主不拦审批，直接交给官方卡片。
    // token 由宿主在浮层首次上报时生成并回写到同一个文件，浮层把它带在每个
    // answers 条目里；宿主只接受 token 匹配的条目，挡住文件投毒式批准。
    function ensureToken() {
      if (!overlayToken) overlayToken = crypto.randomBytes(16).toString('hex')
      return overlayToken
    }
    function writeToken() {
      try {
        const t = ensureToken()
        let cur = {}
        try { cur = JSON.parse(fs.readFileSync(FOREGROUND_FILE, 'utf8')) || {} } catch (err) {}
        if (typeof cur === 'boolean') cur = { fg: cur }
        if (cur.token === t) return
        cur.token = t
        const tmp = FOREGROUND_FILE + '.host.tmp'
        fs.writeFileSync(tmp, JSON.stringify(cur), 'utf8')
        fs.renameSync(tmp, FOREGROUND_FILE)
      } catch (err) {}
    }

    function flush() {
      try {
        fs.mkdirSync(DSH_HOME, { recursive: true })
        const tmp = STATE_FILE + '.tmp'
        const pends = []
        for (const rec of pendings.values()) pends.push(rec.view)
        // 每个 item 带 stateAt：浮层据此判断「这条 done 是不是早该消失了」。
        // 宿主侧 TTL 定时器一旦因为写失败/进程被挂起而没跑成，浮层还能靠它自愈。
        const now = Date.now()
        const list = []
        for (const it of items.values()) list.push(Object.assign({}, it, { stateAt: it.stateAt || now }))
        fs.writeFileSync(tmp, JSON.stringify({ v: 2, at: now, items: list, pending: pends, cfg: readConfig() }), 'utf8')
        fs.renameSync(tmp, STATE_FILE)
      } catch (err) {
        // 以前这里静默吞掉：Windows 上 renameSync 撞到浮层正在读文件会抛 EPERM，
        // 写失败后磁盘上留着上一次的内容（里面可能还有已过期的 done），浮层就一直
        // 显示那条「完成」直到下次 flush 成功 —— 用户报的「完成气泡卡住不下去」。
        log('flush FAIL ' + ((err && err.code) || '') + ' ' + ((err && err.message) || err))
      }
    }

    function touch(sid, patch) {
      try {
        const cur = items.get(sid) || { id: sid, title: '', state: 'thinking', detail: '', since: Date.now() }
        Object.assign(cur, patch)
        // stateAt：状态进入时刻。浮层用它做「done/failed 超龄就丢弃」的兜底，
        // 不依赖宿主那个可能没跑成的 setTimeout。
        if (patch.state) cur.stateAt = Date.now()
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
    let lastSpawnAt = 0
    let spawnBackoffUntil = 0
    function startOverlay() {
      try {
        if (!IS_ELECTRON || !fs.existsSync(OVERLAY_DIR)) { log('skip: isElectron=' + IS_ELECTRON); return }
        // 退避：浮层是 detached 的，DSH 重启不会带走它。新宿主每 3 秒拉起一个
        // Electron，抢单实例锁失败 → app.exit(0) → child=null → 下一个心跳再拉，
        // 于是持续刷屏 spawn。刚拉起来就 exit 0 说明「已有实例在服务」，推迟 60 秒再看。
        if (Date.now() < spawnBackoffUntil) return
        const exe = ensureRuntime()
        const env = {}
        for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
        // 宿主带着它，子进程会退化成纯 node（键名大小写不保证，按不区分大小写删）
        for (const k of Object.keys(env)) if (/^electron_run_as_node$/i.test(k)) delete env[k]
        log('spawn ' + exe)
        lastSpawnAt = Date.now()
        child = spawn(exe, [OVERLAY_DIR], { detached: true, stdio: 'ignore', windowsHide: true, env })
        child.on('error', (e) => { log('spawn error: ' + ((e && e.message) || e)); child = null })
        child.on('exit', (code) => {
          log('overlay exited code=' + code + ' after ' + (Date.now() - lastSpawnAt) + 'ms')
          child = null
          // 秒退 + code 0 = 单实例锁被占（已有浮层在跑），别再拉
          if (Date.now() - lastSpawnAt < 5000 && code === 0) {
            spawnBackoffUntil = Date.now() + 60000
            log('overlay backoff 60s (another instance is serving)')
          }
        })
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
      // 审批 / 提问应答者：后台时走气泡优先；前台或超时由官方卡片兜底。
      // 这里按 waterfall 语义注册；是否实际参与取决于宿主把这些事件以
      // waterfall 分发给插件根上下文（DSH 自带 dsh-user-approval /
      // dsh-user-questions 正是这样做的）。
      try {
        disposers.push(root.on('approval/request', approvalAnswerer))
        disposers.push(root.on('user-questions/request', questionAnswerer))
      } catch (err) { log('answerer register failed: ' + ((err && err.message) || err)) }
      flush()
      // 设置页改了配置 → 立刻推给浮层（浮层 400ms 轮询状态文件，这里只要重写一次）
      try { fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => { try { flush() } catch (err) {} }) } catch (err) {}
      // 浮层写回的答案/前台状态 → 立刻结算给应答者
      try { writeToken(); ingestAnswers(); ingestForeground() } catch (err) {}
      try { fs.watchFile(ANSWERS_FILE, { interval: 1000 }, () => { try { ingestAnswers() } catch (err) {} }) } catch (err) {}
      try { fs.watchFile(FOREGROUND_FILE, { interval: 1000 }, () => { try { ingestForeground() } catch (err) {} }) } catch (err) {}
      if (process.env.DSH_ISLAND_NO_OVERLAY !== '1') startOverlay()
      beat = setInterval(() => {
        try { flush() } catch (err) {}
        try { ingestAnswers() } catch (err) {}   // 兜底：文件事件偶尔丢失
        try { ingestForeground() } catch (err) {}
        // 浮层 token 可能被浮层重写文件时冲掉，定期补一次
        try { writeToken() } catch (err) {}
        // 浮层被关掉/崩了但有状态要显示时，自己再拉一个回来
        try { if (process.env.DSH_ISLAND_NO_OVERLAY !== '1' && !child && items.size > 0) startOverlay() } catch (err) {}
      }, HEARTBEAT_MS)
      if (beat.unref) beat.unref()
    } catch (err) {}

    try {
      root.effect(() => () => {
        try { if (beat) clearInterval(beat) } catch (err) {}
        try { fs.unwatchFile(CONFIG_FILE) } catch (err) {}
        try { fs.unwatchFile(ANSWERS_FILE) } catch (err) {}
        try { fs.unwatchFile(FOREGROUND_FILE) } catch (err) {}
        try { for (const t of timers.values()) clearTimeout(t) } catch (err) {}
        try { for (const d of disposers) d() } catch (err) {}
        stopOverlay()
      })
    } catch (err) {}
  }
}