import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
export const CONFIG_FILE = path.join(DSH_HOME, 'dsh-island-config.json')

// 浮层读的是状态文件里解析好的 cfg，所以默认值只有这一份，不会和渲染端走样
export const DEFAULTS = {
  scale: 1, // 胶囊整体缩放 0.8 ~ 1.4
  mini: 34, // 迷你态直径（px，未缩放）
  position: 'top-center', // top-center | top-right | custom(拖拽记住的位置)
  showWhen: 'always', // always | background（只在 DSH 不在前台时显示）
  holdMs: { thinking: 2500, done: 3000, failed: 6000 },
  effects: { whale: true, pulse: true, shake: true, reduce: false },
  states: { thinking: true, approval: true, done: true, failed: true },
  hideFullscreen: true,
}

const clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) ? Math.min(Math.max(Number(n), lo), hi) : dflt)
const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt)

/** 把用户写的（可能是残缺/手改坏的）配置收敛成一份完整、类型正确的配置 */
export function resolve(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const hold = r.holdMs && typeof r.holdMs === 'object' ? r.holdMs : {}
  const eff = r.effects && typeof r.effects === 'object' ? r.effects : {}
  const st = r.states && typeof r.states === 'object' ? r.states : {}
  return {
    scale: clamp(r.scale, 0.7, 1.6, DEFAULTS.scale),
    mini: clamp(r.mini, 24, 64, DEFAULTS.mini),
    position: pick(r.position, ['top-center', 'top-right', 'custom'], DEFAULTS.position),
    showWhen: pick(r.showWhen, ['always', 'background'], DEFAULTS.showWhen),
    holdMs: {
      thinking: clamp(hold.thinking, 0, 60000, DEFAULTS.holdMs.thinking),
      done: clamp(hold.done, 0, 60000, DEFAULTS.holdMs.done),
      failed: clamp(hold.failed, 0, 60000, DEFAULTS.holdMs.failed),
    },
    effects: {
      whale: eff.whale !== false,
      pulse: eff.pulse !== false,
      shake: eff.shake !== false,
      reduce: eff.reduce === true,
    },
    states: {
      thinking: st.thinking !== false,
      approval: st.approval !== false,
      done: st.done !== false,
      failed: st.failed !== false,
    },
    hideFullscreen: r.hideFullscreen !== false,
  }
}

export function readConfig() {
  try {
    return resolve(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch (err) {
    return resolve(null)
  }
}

export function writeConfig(patch) {
  const next = resolve({ ...readConfig(), ...(patch || {}) })
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    const tmp = CONFIG_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, CONFIG_FILE)
  } catch (err) {}
  return next
}
