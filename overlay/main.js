const { app, BrowserWindow, screen, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile, spawn } = require('child_process')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'dsh-island-state.json')
const POS_FILE = path.join(DSH_HOME, 'dsh-island-pos.json')
const DEAD_MS = 15000
const LOG_FILE = path.join(DSH_HOME, 'dsh-island-overlay.log')

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`) } catch (err) {}
}
process.on('uncaughtException', (e) => log('fatal: ' + ((e && e.stack) || e)))

app.disableHardwareAcceleration() // 透明窗口在部分显卡驱动上会闪

let win = null
let last = ''
let dragOrigin = null
let dragTimer = null
let fsProc = null
let hiddenByFs = false

function readPos() {
  try {
    const p = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'))
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) return p
  } catch (err) {}
  return null
}

function savePos() {
  try {
    const [x, y] = win.getPosition()
    fs.writeFileSync(POS_FILE, JSON.stringify({ x, y }), 'utf8')
  } catch (err) {}
}

function create() {
  const wa = screen.getPrimaryDisplay().workArea
  const W = 480
  const H = 88
  const saved = readPos()
  win = new BrowserWindow({
    width: W,
    height: H,
    x: saved ? saved.x : Math.round(wa.x + (wa.width - W) / 2),
    y: saved ? saved.y : wa.y + 2,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => win.show())

  // 别的置顶窗口偶尔会把我们压下去，定期重新抬一次
  setInterval(() => {
    try {
      if (!win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver')
    } catch (err) {}
  }, 2000)
}

let lastGood = Date.now()
function tick() {
  let raw = ''
  // 读失败（宿主正在原子替换文件）就跳过这一帧——以前这里直接当成「宿主已死」把窗口关了
  try { raw = fs.readFileSync(STATE_FILE, 'utf8') } catch (err) { return }

  let st = null
  try { st = JSON.parse(raw) } catch (err) { return }
  if (!st || !st.at) return

  if (Date.now() - Number(st.at) <= DEAD_MS) lastGood = Date.now()
  else if (Date.now() - lastGood > DEAD_MS) { // 心跳断了 15 秒，宿主多半没了
    log('quit: host heartbeat gone')
    app.quit()
    return
  }

  const body = JSON.stringify(st.items || [])
  if (body !== last) {
    last = body
    try { win.webContents.send('state', JSON.parse(body)) } catch (err) {}
  }
}

// 前台窗口铺满整块屏幕（看视频/游戏）时整只隐藏。
// 最大化不算：它只盖工作区，还有任务栏露着。
function watchFullscreen() {
  try {
    fsProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fullscreen.ps1')], { windowsHide: true })
    let buf = ''
    fsProc.stdout.on('data', (d) => {
      buf += String(d)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) {
        const full = line.trim() === '1'
        if (full === hiddenByFs) continue
        hiddenByFs = full
        try {
          if (!win || win.isDestroyed()) return
          if (full) win.hide()
          else win.showInactive()
        } catch (err) {}
      }
    })
    fsProc.on('error', () => { fsProc = null })
    fsProc.on('exit', () => { fsProc = null })
  } catch (err) {}
}

ipcMain.on('hover', (_e, on) => {
  if (dragOrigin) return
  try { win.setIgnoreMouseEvents(!on, { forward: true }) } catch (err) {}
})

ipcMain.on('activate', () => {
  try {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'activate.ps1')], () => {})
  } catch (err) {}
})

// 拖拽：窗口宽度只有 480，靠 mousemove 跟手会丢事件，
// 所以主进程每 16ms 读一次光标位置，窗口跟着光标走。
ipcMain.on('drag-start', () => {
  try {
    const c = screen.getCursorScreenPoint()
    const p = win.getPosition()
    dragOrigin = { wx: p[0], wy: p[1], cx: c.x, cy: c.y }
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragOrigin) { clearInterval(dragTimer); dragTimer = null; return }
      const cur = screen.getCursorScreenPoint()
      try {
        win.setPosition(
          Math.round(dragOrigin.wx + (cur.x - dragOrigin.cx)),
          Math.round(dragOrigin.wy + (cur.y - dragOrigin.cy))
        )
      } catch (err) {}
    }, 16)
  } catch (err) {}
})

ipcMain.on('drag-end', () => {
  clearInterval(dragTimer)
  dragTimer = null
  if (!dragOrigin) return
  dragOrigin = null
  savePos()
})

app.whenReady().then(() => {
  log('start')
  create()
  tick()
  setInterval(tick, 400)
  watchFullscreen()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  try { if (fsProc) fsProc.kill() } catch (err) {}
})
