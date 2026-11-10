// 开发用截图桩：contextIsolation:false，直接把 islandApi 挂到 window 上。
// 新版浮层还会调 setRows/setBubble/setHit/answer，这里全部吃掉（截图不需要）。
let cb = null
window.islandApi = {
  onState: (fn) => { cb = fn },
  hover: () => {},
  activate: () => {},
  dragStart: () => {},
  dragEnd: () => {},
  setRows: () => {},
  setBubble: () => {},
  setHit: () => {},
  answer: () => {},
}
window.__islandPush = (payload) => cb && cb(payload)
