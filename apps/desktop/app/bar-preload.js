// Bridge for the Mewndo bar. It can say whether the pointer is over the pill, drag itself, press its buttons, and
// hear the state: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar', {
  mouse: (over) => ipcRenderer.send('bar:mouse', over === true),
  // The drag runs in the main process (bar.js): only its start, with where the pointer is in the window, and its end.
  dragStart: (offsetX, offsetY) => ipcRenderer.send('dock:drag-start', { offsetX, offsetY }),
  dragEnd: () => ipcRenderer.send('dock:drag-end'),
  action: (name, arg) => ipcRenderer.send('bar:action', name, arg),
  voice: (wav) => ipcRenderer.send('bar:voice', wav),
  onState(fn) { ipcRenderer.on('bar:state', (_e, s) => fn(s)); },
});
