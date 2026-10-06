// Bridge for the Mewndo bar. It can say whether the pointer is over the pill, drag itself, press its buttons, and
// hear the state: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar', {
  mouse: (over) => ipcRenderer.send('bar:mouse', over === true),
  drag: (msg) => ipcRenderer.send('bar:drag', msg),
  action: (name) => ipcRenderer.send('bar:action', name),
  onState(fn) { ipcRenderer.on('bar:state', (_e, s) => fn(s)); },
});
