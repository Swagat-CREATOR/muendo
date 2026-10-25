// Bridge for the Talk box (spec §33.5, §33.10 Part H): send the text, pick a chip, close. The core's Router decides.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talk', {
  submit: (text) => ipcRenderer.send('talk:submit', text),
  chip: (n) => ipcRenderer.send('talk:chip', n),
  close: () => ipcRenderer.send('talk:close'),
  onOpen(fn) { ipcRenderer.on('talk:open', (_e, d) => fn(d ?? {})); },
  onChips(fn) { ipcRenderer.on('talk:chips', (_e, c) => fn(c)); },
  // Words said to the dock's mic, shown as they were heard; and what happened to a message ("Sent to Claude.").
  onDictated(fn) { ipcRenderer.on('talk:dictated', (_e, d) => fn(d)); },
  onStatus(fn) { ipcRenderer.on('talk:status', (_e, s) => fn(s)); },
  // An idle agent's terminal the core can type into: the reason, the exact text, and Type it / Cancel (chips 1, 2).
  onConfirm(fn) { ipcRenderer.on('talk:confirm', (_e, c) => fn(c ?? {})); },
});
