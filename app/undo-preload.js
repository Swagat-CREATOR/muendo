// Bridge for the one-key undo window. It can ask what to undo, run it, and hide itself: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('undo', {
  folders: call('undoFolders'),
  target: call('undoTarget'),
  run: call('undoRun'),
  hide: call('undoHide'),
  onOpen(fn) { ipcRenderer.on('undo:open', () => fn()); },
});
