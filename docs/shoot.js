// 开发用：渲染 README 里的截图（真实浮层 UI，不是 demo 页）。
// 用法（在插件目录下）：
//   unset ELECTRON_RUN_AS_NODE; "%LOCALAPPDATA%\dsh-island-runtime\DeepSeek Harness.exe" docs
// 输出到 docs/shots/。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OVERLAY = path.join(__dirname, '..', 'overlay', 'index.html')
const STUB = path.join(__dirname, 'shoot-preload.js')
const OUT = path.join(__dirname, 'shots')

const CFG = (o) => Object.assign({
  scale: 1, mini: 34, position: 'top-center', showWhen: 'always',
  layout: 'single', maxRows: 5,
  holdMs: { thinking: 600000, done: 600000, failed: 600000 },
  effects: { whale: true, pulse: true, shake: true, reduce: false },
  states: { thinking: true, approval: true, done: true, failed: true },
  hideFullscreen: true, bubble: { approval: true, ask: true },
}, o || {})

// stateAt 必须是「推给浮层的那一刻」，否则 done(3s)/failed(6s) 的 TTL 会把它们滤掉。
// since 用相对偏移，保证计时器上的秒数每次都一样，截图可复现。
const it = (id, title, state, agoMs, extra) => Object.assign({
  id, title, state, detail: '',
  since: Date.now() - (agoMs || 60000),
  stateAt: Date.now(),
}, extra || {})

const APPROVAL = {
  id: 'ap-demo', kind: 'approval', toolName: 'shell',
  reason: '要在 npmjs 上发布 dsh-island-overlay@0.3.0，需要执行 npm publish',
}
const ASK = {
  id: 'q-demo', kind: 'ask',
  questions: [{
    id: 'q1', question: '这次发布用哪个 tag？', header: '选择',
    options: [{ label: 'latest' }, { label: 'next' }], multiSelect: false,
  }],
}

// 每个用例：{ name, items, pending, cfg, hover }
const CASES = [
  {
    name: 'thinking',
    items: () => [it('a', 'dsh 灵动岛状态提示方案', 'thinking', 83000)],
    pending: [], cfg: CFG(),
  },
  {
    name: 'approval',
    items: () => [it('a', 'npm 发布', 'approval', 1261000, { detail: 'shell' })],
    pending: [], cfg: CFG(),
  },
  {
    name: 'done',
    items: () => [it('a', '重构浮层多任务布局', 'done', 500)],
    pending: [], cfg: CFG(),
  },
  {
    name: 'failed',
    items: () => [it('a', '修复登录超时', 'failed', 500, { detail: 'ECONNREFUSED 127.0.0.1:3425' })],
    pending: [], cfg: CFG(),
  },
  {
    name: 'idle',
    items: () => [it('a', 'dsh 灵动岛', 'thinking', 83000)],
    pending: [], cfg: CFG({ holdMs: { thinking: 400, done: 400, failed: 400 } }),
  },
  {
    name: 'multi',
    items: () => [
      it('a', 'npm 发布', 'approval', 1261000, { detail: 'shell' }),
      it('b', '修复登录超时', 'failed', 180000, { detail: 'ECONNREFUSED' }),
      it('c', 'dsh 灵动岛方案', 'thinking', 480000),
      it('d', '构建产物', 'done', 1000),
    ],
    pending: [], cfg: CFG(),
  },
  {
    // 多行布局，maxRows=3，4 个会话 → 第 3 行行尾 +1
    name: 'multi-rows',
    items: () => [
      it('a', 'npm 发布', 'approval', 1261000, { detail: 'shell' }),
      it('b', '修复登录超时', 'failed', 180000, { detail: 'ECONNREFUSED' }),
      it('c', 'dsh 灵动岛方案', 'thinking', 480000),
      it('d', '构建产物', 'done', 1000),
    ],
    pending: [], cfg: CFG({ layout: 'multi', maxRows: 3 }),
  },
  {
    // 审批气泡：DSH 在后台时，胶囊下方直接点「允许一次 / 拒绝」
    name: 'bubble-approval',
    items: () => [it('a', 'npm 发布', 'approval', 1261000, { detail: 'shell' })],
    pending: [APPROVAL], cfg: CFG(),
  },
  {
    // 提问气泡：选项 + 自定义输入 + 改用官方卡片
    name: 'bubble-ask',
    items: () => [it('a', '发布前确认', 'ask', 120000, { detail: '等待你的回答' })],
    pending: [ASK], cfg: CFG(),
  },
  {
    // 多行 + 气泡：最占空间的组合，用来判断小屏够不够放
    name: 'multi-bubble',
    items: () => [
      it('a', 'npm 发布', 'approval', 1261000, { detail: 'shell' }),
      it('b', '修复登录超时', 'failed', 180000, { detail: 'ECONNREFUSED' }),
      it('c', 'dsh 灵动岛方案', 'thinking', 480000),
    ],
    pending: [APPROVAL], cfg: CFG({ layout: 'multi', maxRows: 3 }),
  },
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // 必须 show：隐藏窗口不重绘，截出来永远是第一帧
  const win = new BrowserWindow({
    width: 620, height: 460, show: true, frame: false, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: STUB, contextIsolation: false, backgroundThrottling: false },
  })
  await win.loadFile(OVERLAY)
  await new Promise((r) => setTimeout(r, 600))

  for (const c of CASES) {
    await win.webContents.executeJavaScript(
      `window.__islandPush(${JSON.stringify({ items: typeof c.items === "function" ? c.items() : c.items, pending: c.pending, foreground: false, cfg: c.cfg })}); void 0`
    )
    await new Promise((r) => setTimeout(r, c.name === 'idle' ? 1200 : 900))
    // 只截内容：wrap 是 position:fixed 满宽，量它没用；量「胶囊 + 气泡」的实际并集
    const r = await win.webContents.executeJavaScript(`(() => {
      const boxes = [document.getElementById('island')]
      const b = document.getElementById('bubble')
      if (b && !b.classList.contains('hidden')) boxes.push(b)
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (const el of boxes) {
        const q = el.getBoundingClientRect()
        if (q.width <= 0 || q.height <= 0) continue
        x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y)
        x2 = Math.max(x2, q.x + q.width); y2 = Math.max(y2, q.y + q.height)
      }
      if (!isFinite(x1)) return { x: 0, y: 0, w: 1, h: 1 }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    })()`
    )
    const pad = 8
    const x = Math.max(0, Math.floor(r.x - pad))
    const y = Math.max(0, Math.floor(r.y - pad))
    const img = await win.capturePage({
      x, y,
      width: Math.min(620 - x, Math.ceil(r.w + pad * 2)),
      height: Math.min(460 - y, Math.ceil(r.h + pad * 2)),
    })
    fs.writeFileSync(path.join(OUT, c.name + '.png'), img.toPNG())
    console.log('shot', c.name, Math.round(r.w) + 'x' + Math.round(r.h))
  }

  app.quit()
})
