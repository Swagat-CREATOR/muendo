// The only bridge between the window and Mewndo. The window gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const EVENTS = new Set(['state-changed', 'progress', 'savepoints-changed', 'restores-changed', 'retry', 'toast']);

contextBridge.exposeInMainWorld('mewndo', {
  state: call('state'),
  chooseFolders: call('chooseFolders'),
  protect: call('protect'),
  unprotect: call('unprotect'),
  finishSetup: call('finishSetup'),
  setOpenAtLogin: call('setOpenAtLogin'),
  togglePause: call('togglePause'),
  savePoints: call('savePoints'),
  createSavePoint: call('createSavePoint'),
  diff: call('diff'),
  plan: call('plan'),
  restore: call('restore'),
  restores: call('restores'),
  undoRestore: call('undoRestore'),
  openPath: call('openPath'),
  ping: call('ping'),
  claudeHooksPlan: call('claudeHooksPlan'),
  claudeHooksInstall: call('claudeHooksInstall'),
  agentHooksPlan: call('agentHooksPlan'),
  agentHooksInstall: call('agentHooksInstall'),
  safetyRules: call('safetyRules'),
  openSettings: call('openSettings'),
  openLimits: call('openLimits'),
  dismissAlert: call('dismissAlert'),
  setSafetyRules: call('setSafetyRules'),
  on(event, fn) {
    if (!EVENTS.has(event)) throw new Error(`unknown event: ${event}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.off(event, listener);
  },
});
