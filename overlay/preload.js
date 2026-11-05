const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('islandApi', {
  onState: (cb) => ipcRenderer.on('state', (_e, payload) => cb(payload)),
  hover: (on) => ipcRenderer.send('hover', !!on),
  activate: () => ipcRenderer.send('activate'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
})
