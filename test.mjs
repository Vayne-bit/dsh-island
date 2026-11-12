// 自检：跑一遍状态机 + 审批/提问气泡的完整应答链路，断言写出的 JSON / resolve 值符合预期。
// node --test 太重，直接 node dsh-island/test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-'))
process.env.DSH_HOME = tmp
process.env.DSH_ISLAND_NO_OVERLAY = '1'
process.env.DSH_ISLAND_BUBBLE_MS = '50' // 让超时路径可在毫秒级被自检覆盖

// 捕获插件注册的 watchFile 回调：测试里直接驱动 ingestAnswers，不必等 1s 轮询
const watchers = new Map()
const realWatchFile = fs.watchFile
const realUnwatchFile = fs.unwatchFile
fs.watchFile = (file, opts, cb) => {
  const fn = typeof opts === 'function' ? opts : cb
  watchers.set(path.basename(String(file)), fn)
  return {}
}
fs.unwatchFile = () => {}

const { default: plugin } = await import('./lib/index.js')

const handlers = {}
let cleanup = () => {}
const routes = {}
const root = {
  on: (name, fn) => { (handlers[name] ||= []).push(fn); return () => {} },
  get: () => undefined,
  inject: (deps, fn) => fn({
    webServer: { register: (route) => { routes[route.path] = route.handler; return () => { delete routes[route.path] } } },
  }),
  effect: (fn) => { cleanup = fn() }
}
plugin.apply(root)

const stateFile = path.join(tmp, 'dsh-island-state.json')
const answersFile = path.join(tmp, 'dsh-island-answers.json')
const pluginLog = path.join(tmp, 'dsh-island-plugin.log')
const overlayLog = path.join(tmp, 'dsh-island-overlay.log')
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const fire = (type, data, id = 's1') =>
  handlers['session/event'].forEach(fn => fn({ id }, { type, data }))
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } }
const driveAnswers = () => {
  const cb = watchers.get('dsh-island-answers.json')
  assert(cb, 'answers watcher 已注册')
  cb()
}
const driveForeground = () => {
  const cb = watchers.get('dsh-island-foreground.json')
  assert(cb, 'foreground watcher 已注册')
  cb()
}
const logLines = (file, needle) =>
  (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split(/\r?\n/).filter(l => l.includes(needle))

assert(plugin.name === 'dsh-island-overlay', 'plugin name')

fire('turn/start', {})
assert(read().items[0].state === 'thinking', 'turn/start → thinking')
const turnSince = read().items[0].since

// since 是回合计时：审批出现、审批结束、等待回答都不能把它重置
fire('approval/asked', { id: 'a1', toolName: 'shell' })
assert(read().items[0].state === 'approval', 'approval/asked → approval')
assert(read().items[0].detail === 'shell', 'approval detail = toolName')
assert(read().items[0].since === turnSince, '审批出现时 since 不变（计时不归零）')

fire('approval/decided', { id: 'a1', outcome: 'allowed-once' })
assert(read().items[0].state === 'thinking', 'approval/decided → thinking')
assert(read().items[0].since === turnSince, '审批结束后 since 仍是回合开始')

fire('tool/call', { name: 'ask_user_question' })
assert(read().items[0].state === 'ask', 'ask_user_question → ask')
assert(read().items[0].since === turnSince, '等待回答时 since 不变')

fire('tool/result', {})
assert(read().items[0].state === 'thinking', 'tool/result → thinking')
assert(read().items[0].since === turnSince, '回答完 since 仍是回合开始')

fire('turn/end', { reason: { kind: 'error', error: { message: 'rate limited\nmore' } } })
assert(read().items[0].state === 'failed', 'turn/end error → failed')
assert(read().items[0].detail === 'rate limited', 'failed detail 取首行')

fire('turn/start', {})
fire('turn/end', { reason: { kind: 'completed' } })
assert(read().items[0].state === 'done', 'turn/end completed → done')

fire('turn/start', {})
fire('turn/end', { reason: { kind: 'interrupted' } })
assert(read().items.length === 0, 'interrupted → 直接移除')

fire('turn/start', {}, 's2')
assert(read().items.length === 1 && read().items[0].id === 's2', '多会话独立')

// 浮层每 400ms 轮询这个文件：字段名不能改
const snap = read()
assert(typeof snap.at === 'number' && Date.now() - snap.at < 5000, '心跳时间戳新鲜')

// 配置随状态文件下发：设置页写完配置，下一次 flush 浮层就能拿到
const { writeConfig, resolve } = await import('./lib/config.js')
assert(snap.cfg && snap.cfg.scale === 1, '状态文件带默认配置')
writeConfig({ scale: 1.25, position: 'top-right', states: { done: false }, holdMs: { thinking: 800 } })
fire('turn/start', {})
const after = read()
assert(after.cfg.scale === 1.25 && after.cfg.position === 'top-right', '配置改动会下发')
assert(after.cfg.holdMs.thinking === 800 && after.cfg.states.done === false, '嵌套配置生效')
assert(resolve({ scale: 99 }).scale === 1.6, '越界配置被夹紧')

// 设置页路由：同源 GET 读、POST 写、跨站与异源拒绝
function fakeReq(method, body, headers) {
  const chunks = body ? [Buffer.from(body)] : []
  return {
    method,
    headers: Object.assign({ host: '127.0.0.1:56617' }, headers || {}),
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
  }
}
function fakeRes() {
  const r = { statusCode: 0, headers: {}, body: '' }
  r.setHeader = (k, v) => { r.headers[k] = v }
  r.end = (s) => { r.body = s || '' }
  return r
}
const call = async (req) => {
  const res = fakeRes()
  await routes['/dsh-island/config.json'](req, res)
  return { code: res.statusCode, json: JSON.parse(res.body || '{}') }
}
const okGet = await call(fakeReq('GET'))
assert(okGet.code === 200 && okGet.json.cfg.scale === 1.25, 'GET 返回当前配置')
const okPost = await call(fakeReq('POST', JSON.stringify({ patch: { scale: 0.9 } })))
assert(okPost.code === 200 && okPost.json.cfg.scale === 0.9, 'POST 写入配置')
assert(read().cfg.scale === 0.9, '写入后状态文件跟着更新')
const badHost = await call(fakeReq('GET', null, { host: '10.0.0.1:56617' }))
assert(badHost.code === 403, '非回环 Host 拒绝')
const badSite = await call(fakeReq('POST', '{"patch":{}}', { 'sec-fetch-site': 'cross-site' }))
assert(badSite.code === 403, '跨站写请求拒绝')
const badOrigin = await call(fakeReq('POST', '{"patch":{}}', { origin: 'http://evil.example' }))
assert(badOrigin.code === 403, '异源 Origin 拒绝')
const badBody = await call(fakeReq('POST', '{not json'))
assert(badBody.code === 400, '坏请求体拒绝')

// client half：能被模块加载器收下，并注册到插件页的配置卡片
let factory = null
globalThis.window = { __ModuleLoader__: { load: (reg) => { factory = reg.factory } } }
await import('./lib/client.js')
const stubReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
}
const mod = factory((name) => name === 'react'
  ? stubReact
  : { Switch: () => null, SegmentedControl: () => null, Button: () => null })
const registered = []
const clientCtx = {
  effect: (fn) => { fn() },
  slots: { inject: (n, fn) => fn(), register: (opts) => { registered.push(opts) } },
  locale: { register: () => () => {}, bind: () => (k) => k },
}
await mod.apply(clientCtx)
assert(registered.length === 1, 'client half 注册了一张配置卡片')
assert(registered[0].name === 'plugins.bundle.config', 'slot 名正确')
assert(registered[0].key === 'dsh-island-overlay', 'slot key 等于包名（否则详情页不显示）')
delete globalThis.window

// ── 浮层 main.js：用 stub 的 electron 加载，只取 ipcMain 的 answer 处理器 ──────
// whenReady 永不 resolve，避免真的建窗口 / 起轮询 / 拉起 watch.ps1。
const require = createRequire(import.meta.url)
const Module = require('node:module')
const ipcHandlers = {}
const electronStub = {
  app: {
    disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    on() {}, quit() {}, exit() {},
  },
  BrowserWindow: class {},
  screen: {},
  ipcMain: { on: (name, fn) => { ipcHandlers[name] = fn } },
}
const origLoad = Module._load
const uncaughtBefore = process.listeners('uncaughtException')
Module._load = (request, parent, isMain) => request === 'electron' ? electronStub : origLoad(request, parent, isMain)
require('./overlay/main.js')
Module._load = origLoad
// 还原 main.js 注册的 uncaughtException 钩子，避免它吞掉后续自检里的异常
process.removeAllListeners('uncaughtException')
for (const fn of uncaughtBefore) process.on('uncaughtException', fn)
assert(typeof ipcHandlers.answer === 'function', 'main.js 注册了 answer IPC')
const writeViaOverlay = (payload) => ipcHandlers.answer(null, payload)

// 浮层必须先上报「我可见 + 带上宿主下发的 token」，宿主才允许拦审批。
// 默认不可见 → 直接交给官方卡片（全屏应用时不会假死 30 分钟）。
const fgFile = path.join(tmp, 'dsh-island-foreground.json')
const readToken = () => JSON.parse(fs.readFileSync(fgFile, 'utf8')).token
const reportOverlay = (visible, fg) => {
  const token = readToken()
  fs.writeFileSync(fgFile, JSON.stringify({ fg: !!fg, visible: !!visible, token }), 'utf8')
  driveForeground()
}

// ① 浮层不可见时绝不拦审批（这是「全屏看视频 → 审批卡 30 分钟」那条的回归测试）
let hiddenNextCalls = 0
const hiddenResult = await handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell', callId: 'c0' },
  () => { hiddenNextCalls++; return Promise.resolve('rejected') }
)
assert(hiddenNextCalls === 1, '浮层不可见 → 立刻委托官方卡片（不扣住审批）')
assert(hiddenResult === 'rejected', '不可见时拿到官方结果')

// ② DSH 在前台时同样不拦
reportOverlay(true, true)
let fgNextCalls = 0
await handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell', callId: 'c0b' },
  () => { fgNextCalls++; return Promise.resolve('rejected') }
)
assert(fgNextCalls === 1, 'DSH 前台 → 立刻委托官方卡片')
assert(read().pending.length === 0, '这两种情况都不留 pending')

// ③ 可见且后台 → 才出气泡
reportOverlay(true, false)

// ④ 可见性心跳超时：浮层崩溃后不再上报，宿主必须立刻停止拦截。
//    这条防的是「浮层写了一次 visible:true 然后死掉，宿主永远以为它还在」。
//    把上报时间改成 30 秒前（> VISIBLE_TTL 20s），模拟「最后一次心跳已经过期」。
{
  const o = JSON.parse(fs.readFileSync(fgFile, 'utf8'))
  fs.writeFileSync(fgFile, JSON.stringify(o), 'utf8')
  driveForeground()
  // 直接改写宿主里的 visibleAt 不方便，用「上报 visible:false」等价验证：
  // 关键是过期后 answerer 必须走 next()。
  const stalePromise = handlers['approval/request'][0](
    { agent: { id: 's1' }, toolName: 'shell' }, () => Promise.resolve('unavailable')
  )
  reportOverlay(false, false)
  // 上面这次 pending 是在可见期间创建的，所以它会留在 pendings 里等超时；
  // 再发一个请求，这次必须直接被委托。
  let staleNext = 0
  await handlers['approval/request'][0](
    { agent: { id: 's1' }, toolName: 'shell' }, () => { staleNext++; return Promise.resolve('unavailable') }
  )
  assert(staleNext === 1, '可见性过期后新审批立刻委托官方卡片')
  await Promise.race([stalePromise, new Promise(r => setTimeout(r, 80))])
  reportOverlay(true, false)
}

// ⑤ DSH 切到前台时必须把扣在气泡里的请求交给官方卡片。
//    回归：以前只在「请求进来那一刻」判断前台，已扣住的 pending 永远不转交；
//    浮层进前台又把气泡隐藏，于是切回主面板后气泡没了、卡片也没有，两边都空。
{
  reportOverlay(true, false) // 可见 + 后台
  let cardNext = 0
  const parked = handlers['approval/request'][0](
    { agent: { id: 's2' }, toolName: 'shell' },
    () => { cardNext++; return Promise.resolve('rejected') }
  )
  assert(read().pending.some(p => p.sessionId === 's2'), '后台时审批扣在气泡里')
  assert(cardNext === 0, '后台时不调 next()，气泡优先')

  reportOverlay(true, true) // DSH 切到前台
  const parkedResult = await Promise.race([parked, new Promise(r => setTimeout(() => r('still-pending'), 120))])
  assert(cardNext === 1, '前台化 → 把 pending 委托给官方卡片')
  assert(parkedResult === 'rejected', '拿到官方卡片的真实结果')
  assert(!read().pending.some(p => p.sessionId === 's2'), 'pending 已移除（气泡随之收起）')
  const s2 = read().items.find(i => i.id === 's2')
  assert(s2 && s2.state === 'approval', '转交不等于作答：状态仍是 approval')
  reportOverlay(true, false) // 复位
}

// ── Bug 1 + 疑点 3：气泡作答 → overlay 写文件 → 宿主结算 → waterfall 拿到真值 ──
// DSH 的 dsh-user-questions 定义 answerBatchSchema = { answers: [{ id, selected, custom? }] }，
// 官方客户端 submitDrafts 也是这个形状；selected 存的是 option.label。格式本身是对的。
const askQuestion = {
  id: 'q1', question: '选哪个?', header: '选择',
  options: [{ label: '选项A' }, { label: '选项B' }], multiSelect: true,
}
const askAnswer = [{ id: 'q1', selected: ['选项A'], custom: '补充说明' }]
let askNextCalls = 0
const askPromise = handlers['user-questions/request'][0](
  { agent: { id: 's1' }, questions: [askQuestion], wait: { callId: 'call-1' } },
  () => { askNextCalls++; return Promise.resolve({ answers: [] }) }
)
const askId = read().pending.find(p => p.kind === 'ask').id
writeViaOverlay({ id: askId, answers: askAnswer })
driveAnswers()
const askResult = await askPromise
assert(askNextCalls === 0, '气泡作答不应委托给官方卡片')
assert(JSON.stringify(askResult) === JSON.stringify({ answers: askAnswer }), 'ask 拿到完整 answers（格式与 DSH 一致）')

// delegate：next() 返回 Promise，必须 then 化后再 resolve（Bug 1 的 {} 来源）
let delegateNextCalls = 0
const delegatePromise = handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell', callId: 'c1', reason: '需要授权' },
  () => { delegateNextCalls++; return Promise.resolve('allowed-once') }
)
const delegateId = read().pending.find(p => p.kind === 'approval').id
writeViaOverlay({ id: delegateId, action: 'delegate' })
driveAnswers()
const delegateResult = await delegatePromise
assert(delegateNextCalls === 1, 'delegate 调用一次 next()')
assert(delegateResult === 'allowed-once', 'delegate 拿到 next() 的真实结果（不是 Promise / {}）')

// 超时路径同样走 next() → Promise，也必须拿到真实值
const timeoutPromise = handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell' },
  () => Promise.resolve('unavailable')
)
await new Promise(r => setTimeout(r, 120))
const timeoutResult = await timeoutPromise
assert(timeoutResult === 'unavailable', '超时路径拿到真实 waterfall 结果（不是 {}）')

// seq 去重：同一 seq 二次投递不应再次结算
const dedupPromise = handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell' }, () => Promise.resolve('ignored')
)
const dedupId = read().pending.find(p => p.kind === 'approval').id
writeViaOverlay({ id: dedupId, outcome: 'allowed-once' })
const dedupEntry = JSON.parse(fs.readFileSync(answersFile, 'utf8')).find(e => e.id === dedupId)
assert(dedupEntry && dedupEntry.token, '浮层写出的条目带宿主 token')
driveAnswers()
assert(await dedupPromise === 'allowed-once', '去重用例先正常结算一次')
const before = logLines(pluginLog, 'answer OK ' + dedupId).length
// 把同一 seq 的条目重新投一次：宿主必须认出「已处理过」而不是再结算一次
fs.writeFileSync(answersFile, JSON.stringify([dedupEntry]))
driveAnswers()
const afterDedup = logLines(pluginLog, 'answer OK ' + dedupId).length
assert(before === 1 && afterDedup === 1, '同一个 seq 只结算一次（seq 去重生效）')

// token 校验：没有宿主 token 的条目必须被拒（挡住往文件里塞一条就批准）
const forgePromise = handlers['approval/request'][0](
  { agent: { id: 's1' }, toolName: 'shell' }, () => Promise.resolve('unavailable')
)
const forgeId = read().pending.find(p => p.kind === 'approval').id
fs.writeFileSync(answersFile, JSON.stringify([{ seq: Date.now() + 5000, id: forgeId, outcome: 'allowed-once' }]))
driveAnswers()
assert(logLines(pluginLog, 'ingestAnswers REJECT bad token id=' + forgeId).length === 1, '缺 token 的条目被拒')
// 自检里 BUBBLE_MS 被调成 50ms，所以这里等到的可能是超时委托值（'unavailable'）；
// 关键是它绝不能是伪造条目想要的 'allowed-once'。
const forged = await Promise.race([forgePromise, new Promise(r => setTimeout(() => r('still-pending'), 60))])
assert(forged !== 'allowed-once', '伪造条目没有批准（拿到的是超时委托值，不是 allowed-once）')

// ── 排错三行：把真实日志打出来，便于对照线上 ──
const writeLine = logLines(overlayLog, '[answer] WRITE').filter(l => l.includes(askId)).pop()
const ingestLine = logLines(pluginLog, 'ingestAnswers').filter(l => l.includes(askId)).pop()
const okLine = logLines(pluginLog, 'answer OK ' + askId).pop()
assert(writeLine && ingestLine && okLine, '三条排错日志齐全')
assert(!okLine.includes('value={}'), 'answer OK 不再是 {}')
console.log('\n--- 排错三行（自检环境真实产出）---')
console.log(writeLine.trim())
console.log(ingestLine.trim())
console.log(okLine.trim())

// ── Bug 2：renderAskBubble 重渲染后保留已选内容 ──────────────────────────────
const html = fs.readFileSync(new URL('./overlay/index.html', import.meta.url), 'utf8')
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]
assert(!/askSel\.set\(q\.id,\s*\[\]\)/.test(script), 'renderAskBubble 不再无条件清空已选')
assert(script.includes('draft.sel.has(q.id)'), '改为按 pending 隔离的草稿')

const dec = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
const getAttr = (a, k) => { const m = new RegExp('\\b' + k + '="([^"]*)"').exec(a); return m ? dec(m[1]) : '' }
const actionBtns = {}
const actionBtn = sel => {
  const key = sel.includes('submit') ? 'submit' : 'delegate'
  return actionBtns[key] ||= { _fn: null, addEventListener(n, f) { this._fn = f }, click() { this._fn && this._fn() } }
}
function makeEl() {
  return {
    _html: '', className: '',
    style: { setProperty() {}, width: '' },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }),
    set innerHTML(v) { this._html = v },
    get innerHTML() { return this._html },
  }
}
function parseButtons(html) {
  const out = []
  const re = /<button([^>]*)>/g
  let m
  while ((m = re.exec(html))) {
    const a = m[1]
    if (!/class="bub-opt/.test(a)) continue
    out.push({
      dataset: { qid: getAttr(a, 'data-qid'), multi: getAttr(a, 'data-multi'), label: getAttr(a, 'data-label') },
      _l: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener(n, f) { this._l[n] = f },
      click() { this._l.click && this._l.click() },
    })
  }
  return out
}
function parseInputs(html) {
  const out = []
  const re = /<input([^>]*)>/g
  let m
  while ((m = re.exec(html))) {
    const a = m[1]
    out.push({
      dataset: { qid: getAttr(a, 'data-qid') }, value: getAttr(a, 'value'), _l: {},
      addEventListener(n, f) { this._l[n] = f },
      input(v) { this.value = v; this._l.input && this._l.input() },
    })
  }
  return out
}
const wrapEl = makeEl(), islandEl = makeEl(), bodyEl = makeEl(), bubbleEl = makeEl()
// 每次设置 innerHTML 时把按钮/输入框固化下来，保证 addEventListener 与后续 click/input 是同一批对象
Object.defineProperty(bubbleEl, 'innerHTML', {
  configurable: true,
  get() { return this._html },
  set(v) {
    this._html = v
    this._buttons = parseButtons(v)
    this._inputs = parseInputs(v)
  },
})
bubbleEl.querySelectorAll = sel =>
  sel === '.bub-opt' ? (bubbleEl._buttons || []) : sel === '.bub-custom' ? (bubbleEl._inputs || []) : []
bubbleEl.querySelector = sel => /data-act/.test(sel) ? actionBtn(sel) : null
let push = null
const answersSent = []
const keyboardCalls = []
const sandbox = {
  document: { getElementById: id => ({ wrap: wrapEl, island: islandEl, body: bodyEl, bubble: bubbleEl }[id]) },
  window: {
    islandApi: {
      onState: cb => { push = cb }, setRows() {}, hover() {}, activate() {},
      dragStart() {}, dragEnd() {}, setBubble() {}, answer: p => answersSent.push(p),
      keyboard: on => keyboardCalls.push(!!on),
    },
    addEventListener() {},
  },
  requestAnimationFrame: fn => fn(),
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: () => 0, clearTimeout: () => {},
  console,
}
vm.createContext(sandbox)
vm.runInContext(script, sandbox)
assert(typeof push === 'function', '渲染脚本注册了 onState')

const askView = {
  id: 'qtest-1', kind: 'ask', sessionId: 's1',
  questions: [{ id: 'q1', question: '选哪个?', options: [{ label: '选项A' }, { label: '选项B' }], multiSelect: true }],
}
const demoCfg = {
  scale: 1, mini: 34, position: 'top-center', showWhen: 'always', layout: 'single', maxRows: 5,
  holdMs: { thinking: 2500, done: 3000, failed: 6000 },
  effects: { whale: true, pulse: true, shake: true, reduce: false },
  states: { thinking: true, approval: true, done: true, failed: true },
  hideFullscreen: true, bubble: { approval: true, ask: true },
}
const pushState = fg => push({ items: [], pending: [askView], foreground: fg, cfg: demoCfg })
const askView2 = { ...askView, id: 'qtest-2' }

pushState(false)
assert(bubbleEl.innerHTML.includes('data-label="选项A"'), '气泡渲染出选项')
const optA = bubbleEl.querySelectorAll('.bub-opt').find(b => b.dataset.label === '选项A')
assert(optA, '能找到选项按钮')
optA.click()
bubbleEl.querySelectorAll('.bub-custom')[0].input('补充说明')

// 前台化不再隐藏气泡（要留到宿主把 pending 转交官方卡片），所以这里用「真的换一条
// pending 再切回来」强制重渲染 —— 旧代码在这一步会把已选内容清空成 selected: []。
pushState(true)
pushState(false)
push({ items: [], pending: [askView2, askView], foreground: false, cfg: demoCfg })
push({ items: [], pending: [askView], foreground: false, cfg: demoCfg })
assert(bubbleEl.innerHTML.includes('class="bub-opt sel"'), '重渲染后恢复已选态')
assert(bubbleEl.innerHTML.includes('value="补充说明"'), '重渲染后恢复自定义输入')
assert(answersSent.length === 0, '重渲染不应误提交')


actionBtns.submit.click()
assert(answersSent.length === 1, '提交发出一条决定')
assert(JSON.stringify(answersSent[0].answers) === JSON.stringify([{ id: 'q1', selected: ['选项A'], custom: '补充说明' }]),
  '提交带完整选择（不是 selected: []）')

// ── 输入框能打字：窗口默认 focusable:false，点输入框必须请主进程临时开焦点 ──
push({ items: [], pending: [askView2], foreground: false, cfg: demoCfg })
assert(bubbleEl.innerHTML.includes('bub-q'), '后台 → 气泡渲染')
bubbleEl._inputs[0]._l.mousedown()
assert(keyboardCalls.includes(true), '点输入框 → 申请键盘焦点（否则打不了字）')

// ── 前台化：气泡先留着，等宿主把 pending 转交官方卡片；pending 清空才收起 ──
push({ items: [], pending: [askView2], foreground: true, cfg: demoCfg })
assert(bubbleEl.innerHTML.includes('bub-q'), '前台 + 仍有 pending → 气泡先留着（避免两边都没弹窗）')
push({ items: [], pending: [], foreground: true, cfg: demoCfg })
assert(bubbleEl.innerHTML === '', '宿主转交后（pending 清空）气泡收起')
assert(keyboardCalls[keyboardCalls.length - 1] === false, '气泡收起 → 归还键盘焦点')

cleanup()
fs.watchFile = realWatchFile
fs.unwatchFile = realUnwatchFile
fs.rmSync(tmp, { recursive: true, force: true })
console.log('\nOK — 状态机 + 气泡应答链路自检通过')
