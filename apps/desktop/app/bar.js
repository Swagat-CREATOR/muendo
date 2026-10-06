// The Mewndo bar (spec §23.5 to §23.7): a small dark pill floating above the taskbar, one per display. Frameless,
// transparent, always on top, never takes focus, no taskbar entry, shown without stealing focus. The window is a
// little bigger than the pill: its transparent part lets clicks through to the app below, and the renderer turns
// mouse input on only while the pointer is over the pill (bar:mouse). Dragged by hand (bar:drag), docks to a side
// edge it is dropped near, and each display remembers its spot (bar-layout.js).
// Hidden while a full-screen app is in front (fullScreen(), asked every 2 s) unless there's an alert. Screen
// sharing: the bar is kept out of every capture (setContentProtection), so the people watching never see it while
// it stays on your own screen.
// What it can't do: Windows can only exclude it from captures on Windows 10 version 2004 and later; on older
// versions it shows in screen shares. A bar dragged onto another display snaps back onto its own.
const path = require('node:path');
const { BrowserWindow, screen, ipcMain } = require('electron');
const { placeBar, dropBar } = require('./bar-layout');

// positions: { [display id]: saved spot } · savePositions(positions) · onAction(name, arg?) for the bar's buttons ·
// onVoice(wav Buffer) for the mic · fullScreen() -> Promise<boolean> · log.
function createBar({ positions = {}, savePositions, onAction, onVoice, fullScreen, log }) {
  const windows = new Map(); // display id -> window
  let state = {};
  let enabled = false;
  let coveredByFullScreen = false;
  let drag = null; // { win, x, y } where the drag started

  const visible = () => enabled && (!coveredByFullScreen || state.alert);
  const each = (fn) => { for (const w of windows.values()) if (!w.isDestroyed()) fn(w); };
  const sideOf = (id) => (positions[id]?.dock === 'left' ? 'left' : 'right');

  function make(display) {
    const w = new BrowserWindow({
      ...placeBar(display, positions[display.id]),
      show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Mewndo bar',
      webPreferences: {
        preload: path.join(__dirname, 'bar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    });
    w.displayId = display.id;
    w.setAlwaysOnTop(true, 'screen-saver'); // above other always-on-top windows, like the taskbar's own
    w.setContentProtection(true);
    w.setIgnoreMouseEvents(true, { forward: true }); // click-through until the pointer is over the pill
    w.loadFile(path.join(__dirname, 'renderer', 'bar.html'));
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.on('render-process-gone', (_e, details) => {
      log.error('A Mewndo bar crashed; reloading it', details);
      if (!w.isDestroyed()) w.reload();
    });
    w.webContents.on('did-finish-load', () => {
      w.webContents.send('bar:state', { ...state, side: sideOf(display.id) });
      if (visible()) w.showInactive();
    });
    windows.set(display.id, w);
  }

  // One bar per display: new displays get one, removed ones lose theirs, the rest move with their work area.
  function sync() {
    if (!enabled) return;
    const displays = screen.getAllDisplays();
    for (const [id, w] of windows) {
      if (!displays.some((d) => d.id === id)) { w.destroy(); windows.delete(id); }
    }
    for (const d of displays) {
      const w = windows.get(d.id);
      if (!w) make(d);
      else w.setBounds(placeBar(d, positions[d.id]));
    }
  }
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => sync());

  function applyVisibility() {
    each((w) => {
      if (visible() && !w.isVisible() && !w.webContents.isLoading()) w.showInactive();
      else if (!visible() && w.isVisible()) w.hide();
    });
  }

  const fromSender = (sender) => [...windows.values()].find((w) => !w.isDestroyed() && w.webContents === sender);
  ipcMain.on('bar:mouse', (e, over) => fromSender(e.sender)?.setIgnoreMouseEvents(over !== true, { forward: true }));
  ipcMain.on('bar:action', (e, name, arg) => {
    const w = fromSender(e.sender);
    if (!w || typeof name !== 'string') return;
    // The open panel may take focus, but only once the user clicks inside it (spec §23.8): focusable, never focused.
    if (name === 'panel-open' || name === 'panel-close') w.setFocusable(name === 'panel-open');
    onAction(name, typeof arg === 'string' ? arg : undefined);
  });
  ipcMain.on('bar:voice', (e, wav) => {
    if (fromSender(e.sender) && wav instanceof Uint8Array && wav.length < 20 * 1024 * 1024) onVoice(Buffer.from(wav));
  });
  ipcMain.on('bar:drag', (e, msg) => {
    const w = fromSender(e.sender);
    if (!w || !msg || typeof msg !== 'object') return;
    const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
    if (msg.phase === 'start') {
      const [x, y] = w.getPosition();
      drag = { win: w, x, y };
    } else if (msg.phase === 'move' && drag?.win === w) {
      w.setPosition(drag.x + n(msg.dx), drag.y + n(msg.dy));
    } else if (msg.phase === 'end' && drag?.win === w) {
      drag = null;
      const display = screen.getAllDisplays().find((d) => d.id === w.displayId) ?? screen.getPrimaryDisplay();
      const [x, y] = w.getPosition();
      const dropped = dropBar(display, { x, y });
      positions = { ...positions, [display.id]: dropped.saved };
      w.setBounds(dropped.bounds);
      w.webContents.send('bar:state', { ...state, side: sideOf(display.id) });
      savePositions(positions);
    }
  });

  // Full-screen apps: Windows says when one is in front (mewndo-core's screen_state).
  const fullScreenTimer = setInterval(async () => {
    if (!enabled) return;
    const now = await fullScreen().catch(() => false);
    if (now !== coveredByFullScreen) { coveredByFullScreen = now; applyVisibility(); }
  }, 2000);
  fullScreenTimer.unref?.();

  return {
    // { status: protected | drift | braked | paused | off, label, agents: [{ name, braked, drift }], alert,
    //   ticker: { root, name, savePoint, deleted, edited, created } | null, shortcuts: { undo, brief } }
    update(next) {
      state = next;
      for (const [id, w] of windows) if (!w.isDestroyed()) w.webContents.send('bar:state', { ...state, side: sideOf(id) });
      applyVisibility();
    },
    setEnabled(on) {
      enabled = on;
      if (on) sync();
      applyVisibility();
    },
    destroy() {
      clearInterval(fullScreenTimer);
      each((w) => w.destroy());
      windows.clear();
    },
  };
}

module.exports = { createBar };
