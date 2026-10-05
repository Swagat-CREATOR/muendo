// Bridge for the brief window. It can list folders, protect and copy a brief, and hide itself: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('brief', {
  folders: call('briefFolders'),
  create: call('briefCreate'),
  hide: call('briefHide'),
  onOpen(fn) { ipcRenderer.on('brief:open', () => fn()); },
});
