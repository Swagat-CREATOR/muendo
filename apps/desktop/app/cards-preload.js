// Bridge for the Agent Inbox card window (spec §33.2, §33.10 Part E). It reports keys, clicks, the end of the grace
// bar, typed text and the card mic's recording, and hears the stack: nothing else. Every decision is made in the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  key: (key, cardId) => ipcRenderer.send('desk:key', key, cardId),
  click: (action, cardId, arg) => ipcRenderer.send('desk:click', action, cardId, arg),
  graceEnd: (cardId) => ipcRenderer.send('desk:grace-end', cardId),
  text: (cardId, text, via) => ipcRenderer.send('desk:text', cardId, text, via),
  // The card's mic: the recorded WAV (or null when nothing usable was recorded), turned into text by speech.js.
  dictate: (cardId, wav) => ipcRenderer.send('desk:dictate', cardId, wav ?? null),
  // The reply box got focus: the core keeps the agent's Stop hook waiting longer (inbox.hold).
  hold: (cardId) => ipcRenderer.send('desk:hold', cardId),
  onState(fn) { ipcRenderer.on('cards:state', (_e, s) => fn(s)); },
});
