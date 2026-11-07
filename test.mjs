// 自检：跑一遍状态机，断言写出的 JSON 符合预期。
// node --test 太重，直接 node dsh-island/test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-'))
process.env.DSH_HOME = tmp
process.env.DSH_ISLAND_NO_OVERLAY = '1'

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
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const fire = (type, data, id = 's1') =>
  handlers['session/event'].forEach(fn => fn({ id }, { type, data }))
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } }

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

cleanup()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK — 状态机自检通过')
