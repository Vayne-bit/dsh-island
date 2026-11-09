const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('islandApi', {
  onState: (cb) => ipcRenderer.on('state', (_e, payload) => cb(payload)),
  setRows: (n) => ipcRenderer.send('set-rows', n),
  hover: (on) => ipcRenderer.send('hover', !!on),
  activate: () => ipcRenderer.send('activate'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  // 气泡里作出审批/提问决定 → 主进程写回宿主（answer 文件）
  answer: (payload) => ipcRenderer.send('answer', payload),
  // 气泡需要更高窗口（气泡内容比胶囊高）→ 通知主进程调整
  setBubble: (px) => ipcRenderer.send('set-bubble', px),
})