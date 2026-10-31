const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('pluma', {
  call: (method, ...args) => ipcRenderer.invoke('pluma:call', method, args),
  onEvent: (fn) => { const h = (e, msg) => fn(msg); ipcRenderer.on('pluma:event', h); return () => ipcRenderer.off('pluma:event', h) }
})
