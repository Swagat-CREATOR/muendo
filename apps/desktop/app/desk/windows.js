// The Agent Desk windows: the card stack, the Talk box and the lanes (spec §33.10 Part E step 2, §38.3
// cards-window.ts / lanes-window.ts). The dock itself is the v0 pill's window, which stands up as the side dock
// (app/bar.js with dock-place.js), because the pill and the dock are one component tree (§33.1).
//
// Every window is created once, at start-up, hidden: `show: false`, `paintWhenInitiallyHidden: true` and
// `backgroundThrottling: false`, so showing one later is instant and nothing is ever created on demand
// (§33.10 speed rules). They are kept out of screen captures (setContentProtection), like the bar.
//
// Focus: new cards appear with `showInactive()` and take no focus at all; only answer mode calls `focus()`
// (§33.3 step 3). The Talk box always takes focus, because the user is about to type or dictate into it.
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const COMMON = {
  show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
  fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, paintWhenInitiallyHidden: true,
};

const prefs = (preload) => ({
  preload: path.join(__dirname, '..', preload), contextIsolation: true, nodeIntegration: false, sandbox: true,
  backgroundThrottling: false,
});

// on: { key, click, graceEnd, text, talk, chip, closeTalk, lane } — what the renderers send back. log: the app's log.
function createDeskWindows({ log, on = {} }) {
  const windows = {};

  function make(name, { preload, html, bounds, focusable, title }) {
    const w = new BrowserWindow({ ...COMMON, ...bounds, focusable, title, webPreferences: prefs(preload) });
    w.setContentProtection(true);
    w.loadFile(path.join(__dirname, '..', 'renderer', html));
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('render-process-gone', (_e, details) => {
      log?.error?.(`The Mewndo ${name} window crashed; reloading it`, details);
      if (!w.isDestroyed()) w.reload();
    });
    w.on('close', (e) => { e.preventDefault(); w.hide(); }); // created once, hidden, never destroyed until quit
    windows[name] = w;
    return w;
  }

  // The card stack: 420 px cards beside the dock, toward the middle of the screen (main.js placeDeskWindows).
  // Focusable, but focused only in answer mode.
  make('cards', { preload: 'cards-preload.js', html: 'cards.html', focusable: true, title: 'Mewndo: Agent Inbox', bounds: { width: 452, height: 600, x: 0, y: 0 } });
  // The Talk box: a 480 px pill beside the dock, toward the middle of the screen.
  make('talk', { preload: 'talk-preload.js', html: 'talk.html', focusable: true, title: 'Mewndo: Talk', bounds: { width: 496, height: 96, x: 0, y: 0 } });
  // Lanes: the list of lanes and one terminal view. A normal window, so it can be resized and moved.
  const lanes = new BrowserWindow({
    show: false, width: 900, height: 600, minWidth: 520, minHeight: 320, title: 'Mewndo: lanes', skipTaskbar: false,
    paintWhenInitiallyHidden: true, backgroundColor: '#11131a', webPreferences: prefs('lanes-preload.js'),
  });
  lanes.loadFile(path.join(__dirname, '..', 'renderer', 'lanes.html'));
  lanes.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  lanes.webContents.on('will-navigate', (e) => e.preventDefault());
  lanes.on('close', (e) => { e.preventDefault(); lanes.hide(); });
  windows.lanes = lanes;

  const alive = (name) => windows[name] && !windows[name].isDestroyed();
  const from = (sender) => Object.entries(windows).find(([, w]) => !w.isDestroyed() && w.webContents === sender)?.[0];

  // Renderer -> main. The renderers never decide anything: they report the key or click and redraw what comes back.
  ipcMain.on('desk:key', (e, key, cardId) => { if (from(e.sender) === 'cards') on.key?.(String(key ?? ''), cardId ? String(cardId) : null); });
  ipcMain.on('desk:click', (e, action, cardId, arg) => { if (from(e.sender) === 'cards') on.click?.(String(action ?? ''), cardId ? String(cardId) : null, arg); });
  ipcMain.on('desk:grace-end', (e, cardId) => { if (from(e.sender) === 'cards') on.graceEnd?.(String(cardId ?? '')); });
  ipcMain.on('desk:text', (e, cardId, text, via) => { if (from(e.sender) === 'cards') on.text?.(String(cardId ?? ''), String(text ?? ''), via === 'voice' ? 'voice' : 'key'); });
  ipcMain.on('talk:submit', (e, text) => { if (from(e.sender) === 'talk') on.talk?.(String(text ?? '')); });
  ipcMain.on('talk:chip', (e, n) => { if (from(e.sender) === 'talk') on.chip?.(Number(n)); });
  ipcMain.on('talk:close', (e) => { if (from(e.sender) === 'talk') on.closeTalk?.(); });
  ipcMain.on('lanes:action', (e, action, laneId, arg) => { if (from(e.sender) === 'lanes') on.lane?.(String(action ?? ''), laneId ? String(laneId) : null, arg); });

  function send(name, channel, payload) {
    if (alive(name) && !windows[name].webContents.isLoading()) windows[name].webContents.send(channel, payload);
    else if (alive(name)) windows[name].webContents.once('did-finish-load', () => windows[name].webContents.send(channel, payload));
  }

  return {
    windows,
    send,
    place(name, bounds) { if (alive(name)) windows[name].setBounds(bounds); },

    // A new card never takes focus: the user keeps typing in whatever app they were in (§33.3).
    showCards({ focus = false } = {}) {
      if (!alive('cards')) return;
      const w = windows.cards;
      if (focus) {
        w.show();
        w.focus();
      } else if (!w.isVisible()) {
        w.showInactive();
      }
      w.setAlwaysOnTop(true, 'screen-saver');
    },
    hideCards() { if (alive('cards') && windows.cards.isVisible()) windows.cards.hide(); },
    cardsVisible: () => alive('cards') && windows.cards.isVisible(),

    showTalk() {
      if (!alive('talk')) return;
      windows.talk.show();
      windows.talk.focus();
      send('talk', 'talk:open', {});
    },
    hideTalk() { if (alive('talk') && windows.talk.isVisible()) windows.talk.hide(); },

    showLanes(laneId) {
      if (!alive('lanes')) return;
      windows.lanes.show();
      windows.lanes.focus();
      if (laneId) send('lanes', 'lanes:open', String(laneId));
    },

    destroy() {
      for (const channel of ['desk:key', 'desk:click', 'desk:grace-end', 'desk:text', 'talk:submit', 'talk:chip', 'talk:close', 'lanes:action']) {
        ipcMain.removeAllListeners(channel);
      }
      for (const w of Object.values(windows)) if (!w.isDestroyed()) { w.removeAllListeners('close'); w.destroy(); }
    },
  };
}

module.exports = { createDeskWindows };
