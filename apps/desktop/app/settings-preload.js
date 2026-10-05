// Bridge for the settings window. It can read and change Mewndo's settings: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(`settings:${name}`, ...args);

contextBridge.exposeInMainWorld('settings', {
  get: call('getSettings'),
  suspendShortcuts: call('suspendShortcuts'),
  resumeShortcuts: call('resumeShortcuts'),
  setShortcut: call('setShortcut'),
  testShortcut: call('testShortcut'),
  setBurst: call('setBurst'),
  setBudget: call('setBudget'),
  setFolder: call('setFolder'),
  setAgents: call('setAgents'),
  setRules: call('setRules'),
  setOpenAtLogin: call('setOpenAtLogin'),
  openDataFolder: call('openDataFolder'),
  openLog: call('openLog'),
  openLimits: call('openLimits'),
  resetAll: call('resetAll'),
});
