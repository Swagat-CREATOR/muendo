// Bridge for the Talk box (spec §33.5, §33.10 Part H): send the text, pick a chip, close. The core's Router decides.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talk', {
  submit: (text) => ipcRenderer.send('talk:submit', text),
  chip: (n) => ipcRenderer.send('talk:chip', n),
  close: () => ipcRenderer.send('talk:close'),
  onOpen(fn) { ipcRenderer.on('talk:open', () => fn()); },
  onChips(fn) { ipcRenderer.on('talk:chips', (_e, c) => fn(c)); },
});
