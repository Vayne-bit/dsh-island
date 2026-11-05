// 开发用：渲染 README 里的截图（真实浮层 UI，不是 demo 页）。用法（在插件目录下）：
//   unset ELECTRON_RUN_AS_NODE; "%LOCALAPPDATA%\dsh-island-runtime\DeepSeek Harness.exe" docs
// 输出到 docs/shots/。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const OVERLAY = path.join(__dirname, '..', 'overlay', 'index.html')
const STUB = path.join(__dirname, 'shoot-preload.js')
const OUT = path.join(__dirname, 'shots')
const now = Date.now()
const CFG = { scale: 1, mini: 34, position: 'top-center', showWhen: 'always', holdMs: { thinking: 60000, done: 60000, failed: 60000 }, effects: { whale: true, pulse: true, shake: true, reduce: false }, states: { thinking: true, approval: true, done: true, failed: true }, hideFullscreen: true }

const CASES = {
  thinking: [{ id: 'a', title: 'dsh 灵动岛状态提示方案', state: 'thinking', since: now - 83000 }],
  approval: [{ id: 'a', title: 'npm 发布', state: 'approval', detail: 'shell', since: now - 4000 }],
  done: [{ id: 'a', title: '重构浮层多任务布局', state: 'done', since: now - 500 }],
  failed: [{ id: 'a', title: '修复登录超时', state: 'failed', detail: 'ECONNREFUSED', since: now - 500 }],
  idle: [{ id: 'a', title: 'dsh 灵动岛', state: 'thinking', since: now - 83000 }], // 收起后的迷你态
  multi: [
    { id: 'a', title: 'npm 发布', state: 'approval', detail: 'shell', since: now - 4000 },
    { id: 'b', title: '修复登录超时', state: 'failed', detail: 'ECONNREFUSED', since: now - 3000 },
    { id: 'c', title: 'dsh 灵动岛方案', state: 'thinking', since: now - 83000 },
    { id: 'd', title: '构建产物', state: 'done', since: now - 1000 },
  ],
}

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // 必须 show：隐藏窗口不重绘，截出来永远是第一帧
  const win = new BrowserWindow({
    width: 480, height: 88, show: true, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: STUB, contextIsolation: false, backgroundThrottling: false },
  })
  await win.loadFile(OVERLAY)
  await new Promise((r) => setTimeout(r, 600))

  for (const [name, items] of Object.entries(CASES)) {
    // idle 用 400ms 收起，其余保持展开
    const cfg = name === 'idle' ? Object.assign({}, CFG, { holdMs: { thinking: 400, done: 400, failed: 400 } }) : CFG
    await win.webContents.executeJavaScript(`__islandPush(${JSON.stringify({ items, cfg })}); void 0`)
    await new Promise((r) => setTimeout(r, name === 'idle' ? 1200 : 900))
    // 只截胶囊那一块，别留大片空白
    const r = await win.webContents.executeJavaScript(
      `(() => { const b = document.getElementById('island').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`
    )
    const pad = 8
    const img = await win.capturePage({
      x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)),
      width: Math.min(480 - Math.max(0, Math.floor(r.x - pad)), Math.ceil(r.w + pad * 2)),
      height: Math.min(88 - Math.max(0, Math.floor(r.y - pad)), Math.ceil(r.h + pad * 2)),
    })
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG())
    console.log('shot', name)
  }

  app.quit()
})
