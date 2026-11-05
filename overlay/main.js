const { app, BrowserWindow, screen, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile, spawn } = require('child_process')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(DSH_HOME, 'dsh-island-state.json')
const POS_FILE = path.join(DSH_HOME, 'dsh-island-pos.json')
const DEAD_MS = 30000
const LOG_FILE = path.join(DSH_HOME, 'dsh-island-overlay.log')

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`) } catch (err) {}
}
process.on('uncaughtException', (e) => log('fatal: ' + ((e && e.stack) || e)))

app.disableHardwareAcceleration() // 透明窗口在部分显卡驱动上会闪

// 开两个 DSH 实例（或多 profile）会各拉起一个浮层，叠在屏幕同一个位置。
// 只留第一个，后来的直接退出；状态文件是共享的，旧的那个照样能显示新状态。
if (!app.requestSingleInstanceLock()) app.exit(0)

const BASE_W = 480
const BASE_H = 88
const DEFAULTS = {
  scale: 1, mini: 34, position: 'top-center', showWhen: 'always',
  holdMs: { thinking: 2500, done: 3000, failed: 6000 },
  effects: { whale: true, pulse: true, shake: true, reduce: false },
  states: { thinking: true, approval: true, done: true, failed: true },
  hideFullscreen: true,
}

let win = null
let last = ''
let cfg = null
let dragOrigin = null
let dragTimer = null
let watchProc = null
let hiddenByFs = false
let dshForeground = false

const cfgOf = (st) => (st && st.cfg) || DEFAULTS

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

// 窗口比胶囊大一圈：缩放后的胶囊要放得下，还要留出呼吸/涟漪的溢出空间
function winSize(s) {
  return { w: Math.round(BASE_W * s), h: Math.round(BASE_H * s) }
}

// 记下的位置可能落在已经拔掉/改分辨率的屏幕上，落在哪块屏就夹到那块屏里
function place(c) {
  const { w, h } = winSize(c.scale)
  if (c.position === 'custom') {
    const saved = readPos()
    if (saved) {
      const wa = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y }).workArea
      return {
        x: Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - w),
        y: Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - h),
      }
    }
  }
  const wa = screen.getPrimaryDisplay().workArea
  const y = wa.y + 2
  return c.position === 'top-right'
    ? { x: wa.x + wa.width - w - 12, y }
    : { x: Math.round(wa.x + (wa.width - w) / 2), y }
}

function create() {
  const c = cfg || DEFAULTS
  const { w, h } = winSize(c.scale)
  const pos = place(c)
  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
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
  win.once('ready-to-show', () => win.showInactive())

  // 诊断：之前浮层会莫名其妙消失且日志里什么都没留下，这里把每种死法都记下来
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone: ' + JSON.stringify(d)))
  win.webContents.on('unresponsive', () => log('unresponsive'))
  win.webContents.on('responsive', () => log('responsive'))
  app.on('child-process-gone', (_e, d) => log('child-process-gone: ' + JSON.stringify(d)))
  win.on('hide', () => log('window hidden'))
  win.on('show', () => log('window shown'))
  win.on('closed', () => log('window closed'))

  // 别的置顶窗口偶尔会把我们压下去，定期重新抬一次
  setInterval(() => {
    try {
      if (!win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver')
    } catch (err) {}
  }, 2000)
}

// 位置/尺寸/显示时机都来自配置，配置变了就地调整，不用重启浮层
function applyCfg(next) {
  const prev = cfg
  cfg = next
  if (!win || win.isDestroyed()) return
  if (prev && next.position === prev.position && next.scale === prev.scale) return
  const { w, h } = winSize(next.scale)
  const pos = place(next)
  try {
    win.setSize(w, h)
    win.setPosition(pos.x, pos.y)
    if (next.position !== 'custom') savePos()
  } catch (err) {}
}

// 前台窗口铺满整块屏幕（看视频/游戏）时整只隐藏；showWhen=background 时 DSH 在前台也隐藏。
// 最大化不算全屏：它只盖工作区，还有任务栏露着。
function watch() {
  try {
    watchProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'watch.ps1')], { windowsHide: true })
    let buf = ''
    watchProc.stdout.on('data', (d) => {
      buf += String(d)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) {
        const [fg, full] = line.trim().split(' ').map((v) => v === '1')
        if (fg === undefined || full === undefined) continue
        dshForeground = fg
        hiddenByFs = full
        decideVisibility()
      }
    })
    watchProc.on('error', (e) => { log('watch error: ' + ((e && e.message) || e)); watchProc = null })
    watchProc.on('exit', (code) => {
      log('watch exited code=' + code)
      watchProc = null
      // 脚本挂了就别一直隐藏着：当成非全屏，5 秒后重开
      hiddenByFs = false
      decideVisibility()
      setTimeout(() => { if (!watchProc) watch() }, 5000)
    })
  } catch (err) { log('watch spawn failed: ' + ((err && err.message) || err)) }
}

// 点击胶囊 → 让常驻的 watch.ps1 去抢前台（走 stdin，省掉每次冷启动 PowerShell 的 1 秒）
function activate() {
  try {
    if (watchProc && watchProc.stdin && !watchProc.stdin.destroyed) watchProc.stdin.write('activate\n')
    else execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'activate.ps1')], () => {})
  } catch (err) {}
}

// 窗口该不该露脸：状态过期（stale）、全屏应用在前台、或设置里选了「仅 DSH 不在前台」。
// 用 win.isVisible() 判断当前状态而不是自己记标志位——以前自己记 hiddenByFg，
// 结果 stale 隐藏后恢复时「以为已经显示」就再也没 showInactive 回来（浮层永久消失）。
function decideVisibility() {
  try {
    if (!win || win.isDestroyed()) return
    const c = cfg || DEFAULTS
    const wantHide = staleSince !== 0
      || (c.hideFullscreen && hiddenByFs)
      || (c.showWhen === 'background' && dshForeground)
    if (wantHide) { if (win.isVisible()) win.hide() }
    else { if (!win.isVisible()) win.showInactive() }
  } catch (err) {}
}

let lastGood = Date.now()
let staleSince = 0
let aliveLogAt = 0
function tick() {
  let raw = ''
  // 读失败（宿主正在原子替换文件）就跳过这一帧——以前这里直接当成「宿主已死」把窗口关了
  try { raw = fs.readFileSync(STATE_FILE, 'utf8') } catch (err) { return }

  let st = null
  try { st = JSON.parse(raw) } catch (err) { return }
  if (!st || !st.at) return

  const age = Date.now() - Number(st.at)
  if (age <= DEAD_MS) {
    lastGood = Date.now()
    // 心跳断过一阵又回来了：上面把它藏了，这里显回来。
    // 以前这里只看自己记的标志位，藏了之后没人再 show —— 浮层就这样永久消失了。
    if (staleSince) { staleSince = 0; log('stale: heartbeat back'); decideVisibility() }
  } else {
    // 心跳断几秒不算死：先藏起来别显示过期状态，5 分钟都没恢复才真退出。
    if (!staleSince) { staleSince = Date.now(); log('stale: heartbeat lost, hiding'); decideVisibility() }
    if (Date.now() - staleSince > 300000) {
      log('quit: host heartbeat gone for 5min')
      app.quit()
    }
    return
  }

  const c = cfgOf(st)
  applyCfg(c)
  decideVisibility()

  const states = c.states || DEFAULTS.states
  const items = (Array.isArray(st.items) ? st.items : []).filter((it) => it && states[it.state] !== false)
  const body = JSON.stringify([items, c])
  if (body !== last) {
    last = body
    try { win.webContents.send('state', { items, cfg: c }) } catch (err) {}
  }
}

ipcMain.on('hover', (_e, on) => {
  if (dragOrigin) return
  try { win.setIgnoreMouseEvents(!on, { forward: true }) } catch (err) {}
})

ipcMain.on('activate', () => activate())

// 拖拽：窗口宽度有限，靠 mousemove 跟手会丢事件，
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
  // 拖完立刻恢复鼠标穿透，否则松手瞬间窗口会继续拦点击
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch (err) {}
  if (!dragOrigin) return
  dragOrigin = null
  savePos()
})

app.whenReady().then(() => {
  log('start v0.2.0')
  create()
  tick()
  setInterval(tick, 400)
  watch()
  // 每 60 秒留一条活口，日志里能看出它到底活到什么时候
  setInterval(() => log('alive'), 60000)
})

process.on('exit', (code) => log('exit code=' + code))
app.on('before-quit', () => {
  log('before-quit')
  try { if (watchProc) watchProc.kill() } catch (err) {}
})
app.on('will-quit', () => log('will-quit'))
