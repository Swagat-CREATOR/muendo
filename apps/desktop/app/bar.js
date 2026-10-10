// The Mewndo bar (spec §23.5 to §23.7, design spec §11.8): the floating pill and dock. One window, frameless,
// transparent, always on top, never takes focus, no taskbar entry, shown without stealing focus.
//
// Placement (design spec §11.8): it can be dragged anywhere and sticks to the nearest edge of the display it is
// dropped on; left and right edges stand it up as a dock, top and bottom lay it down as a pill. The window is a
// fixed-size transparent canvas (dock-place.js); its size changes only when the orientation does, on a drop, never
// on hover. Mouse input reaches it only while the pointer is over the visible surface (bar:mouse).
//
// The drag lives here, not in the renderer: the renderer says when it starts (with where the pointer is inside the
// window) and when it ends; in between this reads the cursor every 8 ms and moves the window in whole pixels, only
// when the position changed. No mouse positions cross IPC during a drag, which is what made the old bar jitter.
//
// Hidden while a full-screen app is in front (fullScreen(), asked every 2 s) unless there's an alert. Kept out of
// every screen capture (setContentProtection), so people watching a screen share never see it.
// What it can't do: Windows can only exclude it from captures on Windows 10 version 2004 and later.
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, screen, ipcMain, systemPreferences } = require('electron');
const { place, drop, displayFor, snapPath, surfaceCentre } = require('./dock-place');

const DRAG_TICK_MS = 8;
const DRAG_SAFETY_MS = 10_000; // a drag whose end never arrives ends by itself
const TOP_EVERY_MS = 1000; // re-assert always-on-top at most this often (§11.8 step 6)
// The living face's cursor feed (§11.9): 30 Hz while the cursor is within NEAR px of the dock or a drag is on, otherwise
// a cheap look 4 times a second to notice it coming closer. Nothing is sent while it's far.
const NEAR = 300;
const NEAR_MS = 33;
const FAR_MS = 250;
const FACE = path.join(__dirname, 'assets', 'cat', 'cat-face-live.svg');

// positions: what savePositions last stored; the dock's own spot is positions.dock = { displayId, edge, fraction }.
// onAction(name, arg?) for the bar's buttons · onVoice(wav Buffer) for the mic · fullScreen() -> Promise<boolean>.
function createBar({ positions = {}, savePositions, onAction, onVoice, fullScreen, log }) {
  let win = null;
  let layout = null; // dock-place.js place(): { bounds, edge, orientation, anchor, saved }
  let state = {};
  let enabled = false;
  let coveredByFullScreen = false;
  let drag = null; // { offsetX, offsetY, last, timer, safety }
  let snapping = null;
  let toppedAt = 0;
  let over = false; // the pointer is over the visible surface (bar:mouse)
  let near = false; // the cursor is near enough for the eyes to follow it
  let cursorTimer = null;

  const alive = () => win && !win.isDestroyed();
  const visible = () => enabled && (!coveredByFullScreen || state.alert);
  const reducedMotion = () => {
    try { return systemPreferences.getAnimationSettings?.().prefersReducedMotion === true; } catch { return false; }
  };

  function current() {
    return place(displayFor(screen.getAllDisplays(), positions.dock, screen.getPrimaryDisplay()), positions.dock);
  }

  function send() {
    if (!alive() || win.webContents.isLoading()) return;
    win.webContents.send('bar:state', {
      ...state, edge: layout.edge, orientation: layout.orientation, anchor: layout.anchor, dragging: !!drag,
    });
  }

  // Move without resizing. On Windows at 125 % or 150 % scaling, setPosition on a transparent window lets its size
  // creep by a pixel or more per call (seen in the real app: 650 x 700 grew to 700 x 755 over one drag), so every
  // move restates the size.
  function moveWin(x, y) {
    win.setBounds({ x, y, width: layout.bounds.width, height: layout.bounds.height });
  }

  // Click-through except over the surface or during a drag. Re-applied after every move that resizes the window:
  // on Windows, forwarding (forward: true) stopped delivering pointer moves after a snap changed the size, which left
  // the dock deaf to hover and clicks until something else reset it.
  function applyMouse() {
    if (alive()) win.setIgnoreMouseEvents(!(drag || over), { forward: true });
  }

  function watchCursor() {
    cursorTimer = setTimeout(watchCursor, near ? NEAR_MS : FAR_MS);
    if (!alive() || !win.isVisible() || win.webContents.isLoading() || reducedMotion()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const c = surfaceCentre(b, layout.edge, layout.anchor);
    const now = !!drag || Math.hypot(p.x - c.x, p.y - c.y) <= NEAR;
    if (now) win.webContents.send('bar:cursor', { x: p.x - b.x, y: p.y - b.y });
    else if (near) win.webContents.send('bar:cursor', null); // gone: look toward the middle of the screen
    near = now;
  }

  function keepOnTop() {
    if (!alive() || Date.now() - toppedAt < TOP_EVERY_MS) return;
    toppedAt = Date.now();
    win.setAlwaysOnTop(true, 'screen-saver');
  }

  function make() {
    layout = current();
    win = new BrowserWindow({
      ...layout.bounds,
      show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Mewndo bar',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, 'bar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver'); // once at creation, above the taskbar's own level
    toppedAt = Date.now();
    win.setContentProtection(true);
    applyMouse();
    win.loadFile(path.join(__dirname, 'renderer', 'bar.html'));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('The Mewndo bar crashed; reloading it', details);
      if (alive()) win.reload();
    });
    win.webContents.on('did-finish-load', () => {
      send();
      if (visible()) win.showInactive();
    });
    win.on('blur', keepOnTop);
    if (!cursorTimer) watchCursor();
  }

  // Display added, removed or rescaled, or the taskbar moved: put the dock back where it belongs (§11.8 Memory).
  function replace() {
    if (!alive() || drag || snapping) return;
    layout = current();
    win.setBounds(layout.bounds);
    applyMouse();
    send();
    toppedAt = 0;
    keepOnTop();
  }
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => replace());

  // Glide to the new spot (§11.8 step 4). A new orientation is a new canvas size: it changes once, at the start, while
  // the renderer cross-fades the surface into its new shape.
  function snapTo(next) {
    if (!alive()) return;
    clearInterval(snapping);
    const [x, y] = win.getPosition();
    layout = next;
    moveWin(x, y); // a new orientation is a new canvas size
    send();
    const path = reducedMotion() ? [{ x: next.bounds.x, y: next.bounds.y }] : snapPath({ x, y }, next.bounds);
    let i = 0;
    snapping = setInterval(() => {
      if (!alive() || i >= path.length) {
        clearInterval(snapping);
        snapping = null;
        if (alive()) win.setBounds(next.bounds); // exact, in case the display moved under the glide
        applyMouse();
        toppedAt = 0;
        keepOnTop();
        return;
      }
      moveWin(path[i].x, path[i].y);
      i += 1;
    }, DRAG_TICK_MS);
  }

  function startDrag(offsetX, offsetY) {
    if (!alive() || drag) return;
    clearInterval(snapping);
    snapping = null;
    drag = { offsetX: Math.round(offsetX), offsetY: Math.round(offsetY), last: null };
    applyMouse(); // keep the mouse for the whole drag
    drag.timer = setInterval(() => {
      if (!alive()) return endDrag();
      const p = screen.getCursorScreenPoint();
      const x = Math.round(p.x - drag.offsetX);
      const y = Math.round(p.y - drag.offsetY);
      if (drag.last && drag.last.x === x && drag.last.y === y) return;
      drag.last = { x, y };
      moveWin(x, y);
    }, DRAG_TICK_MS);
    drag.safety = setTimeout(endDrag, DRAG_SAFETY_MS);
    send();
  }

  function endDrag() {
    if (!drag) return;
    clearInterval(drag.timer);
    clearTimeout(drag.safety);
    drag = null;
    if (!alive()) return;
    const pointer = screen.getCursorScreenPoint();
    const next = drop(screen.getDisplayNearestPoint(pointer), pointer);
    positions = { ...positions, dock: next.saved };
    savePositions(positions);
    snapTo(next);
  }

  // Back to bottom right of the primary display (double-click the face, §11.8 step 7) or onto a chosen edge
  // (Settings → General → Dock position).
  function moveTo(edge) {
    if (!alive()) return;
    const primary = screen.getPrimaryDisplay();
    const next = place(primary, edge ? { edge, fraction: edge === 'bottom' ? 0.92 : 0.5 } : undefined);
    positions = { ...positions, dock: next.saved };
    savePositions(positions);
    snapTo(next);
  }

  function applyVisibility() {
    if (!alive()) return;
    if (visible() && !win.isVisible() && !win.webContents.isLoading()) win.showInactive();
    else if (!visible() && win.isVisible()) win.hide();
  }

  const ours = (e) => alive() && e.sender === win.webContents;
  ipcMain.on('bar:mouse', (e, flag) => {
    if (!ours(e)) return;
    over = flag === true;
    if (!drag) applyMouse();
  });
  ipcMain.on('bar:action', (e, name, arg) => {
    if (!ours(e) || typeof name !== 'string') return;
    if (name === 'dock-reset') return moveTo(null);
    // The open panel may take focus, but only once the user clicks inside it (spec §23.8): focusable, never focused.
    if (name === 'panel-open' || name === 'panel-close') win.setFocusable(name === 'panel-open');
    onAction(name, typeof arg === 'string' ? arg : undefined);
  });
  ipcMain.on('bar:voice', (e, wav) => {
    if (ours(e) && wav instanceof Uint8Array && wav.length < 20 * 1024 * 1024) onVoice(Buffer.from(wav));
  });
  ipcMain.on('dock:drag-start', (e, msg) => {
    if (ours(e) && msg && Number.isFinite(msg.offsetX) && Number.isFinite(msg.offsetY)) startDrag(msg.offsetX, msg.offsetY);
  });
  ipcMain.on('dock:drag-end', (e) => { if (ours(e)) endDrag(); });
  ipcMain.handle('bar:face', (e) => (ours(e) ? fs.readFileSync(FACE, 'utf8') : ''));

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
      send();
      applyVisibility();
    },
    setEnabled(on) {
      enabled = on;
      if (on && !alive()) make();
      applyVisibility();
    },
    // Settings → General → Dock position: 'bottom' | 'right' | 'left' | 'top'.
    setEdge(edge) { moveTo(edge); },
    destroy() {
      clearInterval(fullScreenTimer);
      clearInterval(snapping);
      clearTimeout(cursorTimer);
      if (drag) { clearInterval(drag.timer); clearTimeout(drag.safety); drag = null; }
      if (alive()) win.destroy();
      win = null;
    },
  };
}

module.exports = { createBar };
