// 开发用截图桩：contextIsolation:false，直接把 islandApi 挂到 window 上
let cb = null
window.islandApi = {
  onState: (fn) => { cb = fn },
  hover: () => {},
  activate: () => {},
  dragStart: () => {},
  dragEnd: () => {},
}
window.__islandPush = (payload) => cb && cb(payload)
