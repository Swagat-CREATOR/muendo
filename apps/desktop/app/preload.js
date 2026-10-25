// The only bridge between the window and Mewndo. The window gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);
const EVENTS = new Set(['state-changed', 'progress', 'savepoints-changed', 'restores-changed', 'retry', 'toast', 'show-diff', 'inbox-changed', 'go', 'chime']);
EVENTS.add('connections-changed'); // app/connectors
EVENTS.add('skills-changed'); // app/computer-main.js: Show Me recording

contextBridge.exposeInMainWorld('mewndo', {
  state: call('state'),
  agentsView: call('agentsView'),
  inboxView: call('inboxView'),
  inboxClick: call('inboxClick'),
  inboxGraceEnd: call('inboxGraceEnd'),
  inboxText: call('inboxText'),
  brakeAgent: call('brakeAgent'),
  resumeAgent: call('resumeAgent'),
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
  agentHooksRemove: call('agentHooksRemove'),
  safetyRules: call('safetyRules'),
  openSettings: call('openSettings'),
  openLimits: call('openLimits'),
  dismissAlert: call('dismissAlert'),
  openStorageSettings: call('openStorageSettings'),
  setSafetyRules: call('setSafetyRules'),
  // Show Me skills (app/computer-main.js)
  skillsView: call('skillsView'),
  skillGet: call('skillGet'),
  skillRecord: call('skillRecord'),
  skillStop: call('skillStop'),
  skillSaveRecording: call('skillSaveRecording'),
  skillDiscardRecording: call('skillDiscardRecording'),
  skillUpdate: call('skillUpdate'),
  skillDelete: call('skillDelete'),
  skillOpenSettings: call('skillOpenSettings'),
  // Connections (app/connectors/ipc.js). A token or secret passed here goes to the main process and nowhere else.
  connectionsView: call('connectionsView'),
  connectionsConnect: call('connectionsConnect'),
  connectionsCancel: call('connectionsCancel'),
  connectionsNotionSecret: call('connectionsNotionSecret'),
  connectionsGithubToken: call('connectionsGithubToken'),
  connectionsGithubRepos: call('connectionsGithubRepos'),
  connectionsGithubSetRepos: call('connectionsGithubSetRepos'),
  connectionsCheck: call('connectionsCheck'),
  connectionsUndo: call('connectionsUndo'),
  connectionsDisconnect: call('connectionsDisconnect'),
  on(event, fn) {
    if (!EVENTS.has(event)) throw new Error(`unknown event: ${event}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.off(event, listener);
  },
});
