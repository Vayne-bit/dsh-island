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
const root = {
  on: (name, fn) => { (handlers[name] ||= []).push(fn); return () => {} },
  get: () => undefined,
  effect: (fn) => { cleanup = fn() }
}
plugin.apply(root)

const stateFile = path.join(tmp, 'dsh-island-state.json')
const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const fire = (type, data, id = 's1') =>
  handlers['session/event'].forEach(fn => fn({ id }, { type, data }))
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } }

assert(plugin.name === 'dsh-island', 'plugin name')

fire('turn/start', {})
assert(read().items[0].state === 'thinking', 'turn/start → thinking')

fire('approval/asked', { id: 'a1', toolName: 'shell' })
assert(read().items[0].state === 'approval', 'approval/asked → approval')
assert(read().items[0].detail === 'shell', 'approval detail = toolName')

fire('approval/decided', { id: 'a1', outcome: 'allowed-once' })
assert(read().items[0].state === 'thinking', 'approval/decided → thinking')

fire('tool/call', { name: 'ask_user_question' })
assert(read().items[0].state === 'ask', 'ask_user_question → ask')

fire('tool/result', {})
assert(read().items[0].state === 'thinking', 'tool/result → thinking')

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

cleanup()
fs.rmSync(tmp, { recursive: true, force: true })
console.log('OK — 状态机自检通过')
