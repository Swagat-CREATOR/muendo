// Bridge for the lanes window (spec §33.7). Lanes are not connected to the core yet; the window says so.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanes', {
  action: (action, laneId, arg) => ipcRenderer.send('lanes:action', action, laneId, arg),
  onOpen(fn) { ipcRenderer.on('lanes:open', (_e, id) => fn(id)); },
});
