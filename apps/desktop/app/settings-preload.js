// Bridge for the settings window. It can read and change Mewndo's settings: nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(`settings:${name}`, ...args);

contextBridge.exposeInMainWorld('settings', {
  get: call('getSettings'),
  version: call('version'),
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
  setEngine: call('setEngine'),
  setGuardFailOpen: call('setGuardFailOpen'),
  openDataFolder: call('openDataFolder'),
  openLog: call('openLog'),
  openLimits: call('openLimits'),
  resetAll: call('resetAll'),
  habits: call('habits'),
  removeHabit: call('removeHabit'),
  setNotify: call('setNotify'),
  connectionsSettings: call('connectionsSettings'), // app/connectors/ipc.js: Worker addresses only, no secrets
  setConnectionUrl: call('setConnectionUrl'),
  // Computer use (app/computer-main.js): the switch, the cua-driver download, agents' MCP settings, Resume.
  computerView: call('computerView'),
  computerSet: call('computerSet'),
  computerDownload: call('computerDownload'),
  computerResume: call('computerResume'),
  computerMcpPlan: call('computerMcpPlan'),
  computerMcpInstall: call('computerMcpInstall'),
  computerMcpRemove: call('computerMcpRemove'),
  onComputer(fn) { ipcRenderer.on('settings:computer-changed', (_e, view) => fn(view)); },
  // Mewndo asked to show a section, e.g. Protection from a low-disk warning in the main window.
  onPage(fn) { ipcRenderer.on('settings-page', (_e, page) => fn(page)); },
});
