// 开发用：渲染 README 里的截图。用法（在插件目录下）：
//   "…\DeepSeek Harness.exe" <本目录>            ← 直接把 docs 当 app 目录跑
// 输出到 docs/shots/。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const PAGE = path.join(__dirname, '..', 'island-demo.html')
const OUT = path.join(__dirname, 'shots')
const STATES = ['thinking', 'approval', 'done', 'failed', 'idle']

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // 必须 show：隐藏窗口不重绘，截出来永远是第一帧
  const win = new BrowserWindow({ width: 900, height: 420, frame: false, backgroundColor: '#0b0d10', webPreferences: { backgroundThrottling: false } })
  await win.loadFile(PAGE)
  await new Promise((r) => setTimeout(r, 800))

  for (const s of STATES) {
    await win.webContents.executeJavaScript(
      `if (document.querySelector('.badge')) document.getElementById('multi').click(); document.querySelector('[data-s="${s}"]').click(); void 0`
    )
    await new Promise((r) => setTimeout(r, 900))
    const img = await win.capturePage({ x: 190, y: 0, width: 520, height: 96 })
    fs.writeFileSync(path.join(OUT, s + '.png'), img.toPNG())
    console.log('shot', s)
  }

  await win.webContents.executeJavaScript(
    `document.querySelector('[data-s="thinking"]').click(); document.getElementById('multi').click(); void 0`
  )
  await new Promise((r) => setTimeout(r, 900))
  const img = await win.capturePage({ x: 190, y: 0, width: 520, height: 96 })
  fs.writeFileSync(path.join(OUT, 'multi.png'), img.toPNG())
  console.log('shot multi')

  app.quit()
})
