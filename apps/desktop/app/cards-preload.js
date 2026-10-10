// Bridge for the Agent Inbox card window (spec §33.2, §33.10 Part E). It reports keys, clicks, the end of the grace
// bar and typed text, and hears the stack: nothing else. Every decision is made in the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  key: (key, cardId) => ipcRenderer.send('desk:key', key, cardId),
  click: (action, cardId, arg) => ipcRenderer.send('desk:click', action, cardId, arg),
  graceEnd: (cardId) => ipcRenderer.send('desk:grace-end', cardId),
  text: (cardId, text, via) => ipcRenderer.send('desk:text', cardId, text, via),
  onState(fn) { ipcRenderer.on('cards:state', (_e, s) => fn(s)); },
});
