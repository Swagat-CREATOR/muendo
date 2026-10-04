// Electron main process: runs the engine, the tray and the window. The window has no Node access; it talks to
// this process only through the IPC calls in preload.js, and every call is checked here.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, nativeImage, shell } = require('electron');
const { createMewndo, writeFileAtomic } = require('../engine');

const APP_ID = 'com.mewndo.app';
const HOUR = 60 * 60 * 1000;

// Dev and testing: a throwaway profile instead of the real one.
if (process.env.MEWNDO_USER_DATA) app.setPath('userData', path.resolve(process.env.MEWNDO_USER_DATA));

let mewndo;
let win = null;
let tray = null;
let quitting = false;
let stopped = false;
let settings = { setupDone: false, openAtLogin: true };
const progress = new Map(); // folder -> latest scan/restore progress
const lastChange = new Map(); // folder -> when it last changed
const openable = new Set(); // paths the window may ask to open: restore targets and trash folders
let storage = { at: 0, report: null };

const settingsFile = () => path.join(app.getPath('userData'), 'app-settings.json');
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const notify = (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); };
const folderName = (root) => path.basename(root) || root;

async function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(await fsp.readFile(settingsFile(), 'utf8')) }; } catch { /* first run */ }
}
const saveSettings = () => writeFileAtomic(settingsFile(), JSON.stringify(settings));

function applyOpenAtLogin() {
  // Windows and macOS; a no-op on Linux. Started at login, Mewndo opens hidden in the tray.
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: true, args: ['--hidden'] });
}

// A plain ring-and-dot icon drawn in code, so there is no image file to ship yet. Design comes later.
function icon() {
  const size = 32;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if ((d < 14 && d > 9) || d < 5) px.set([0x9c, 0x6b, 0x1f, 0xff], (y * size + x) * 4); // BGRA: dark teal
    }
  }
  return nativeImage.createFromBuffer(px, { width: size, height: size });
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1150, height: 760, minWidth: 800, minHeight: 500, show, title: 'Mewndo', icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => { // closing keeps Mewndo running in the tray
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function storageReport(maxAgeMs = 30_000) {
  if (!storage.report || Date.now() - storage.at > maxAgeMs) {
    storage = { at: Date.now(), report: await mewndo.storageReport() };
  }
  return storage.report;
}

// Documents and Desktop, if they are real folders. Some systems report the home folder itself for a missing
// Documents folder, which must never be suggested.
async function suggestions() {
  const home = path.resolve(app.getPath('home'));
  const out = [];
  for (const name of ['documents', 'desktop']) {
    const p = path.resolve(app.getPath(name));
    const isDir = await fsp.stat(p).then((s) => s.isDirectory(), () => false);
    if (isDir && p !== home && !out.includes(p) && !mewndo.folders().some((f) => f.root === p)) out.push(p);
  }
  return out;
}

async function state() {
  const report = await storageReport().catch(() => null);
  const bytes = new Map((report?.folders ?? []).map((f) => [f.folder, f.bytes]));
  return {
    setupDone: settings.setupDone,
    openAtLogin: settings.openAtLogin,
    loginSupported: process.platform !== 'linux',
    pausedUntil: mewndo.pausedUntil(),
    suggestions: settings.setupDone ? [] : await suggestions(),
    folders: mewndo.folders().map((f) => ({
      ...f, name: folderName(f.root), storageBytes: bytes.get(f.root) ?? null, progress: progress.get(f.root) ?? null,
    })),
    trashBytes: report?.trashBytes ?? null,
    usedBytes: report?.usedBytes ?? null,
    budgetBytes: report?.budgetBytes ?? null,
  };
}

function stateChanged() {
  updateTray();
  send('state-changed');
}

// --- Actions shared by the window and the tray -------------------------------------------------------------

async function createSavePointEverywhere() {
  const folders = mewndo.folders().filter((f) => f.status !== 'scanning');
  if (!folders.length) return notify('Mewndo', 'No folders are protected yet.');
  for (const f of folders) await mewndo.journalFor(f.root).createSavePoint({ label: 'From the tray', trigger: 'manual' });
  notify('Save point created', `${folders.length} folder${folders.length > 1 ? 's' : ''}: ${folders.map((f) => folderName(f.root)).join(', ')}`);
}

// Undo Last: put the folder that changed most recently back to its latest save point, after asking.
async function undoLast() {
  const folders = mewndo.folders().filter((f) => f.status === 'protected' || f.status === 'paused');
  const root = folders.map((f) => f.root).sort((a, b) => (lastChange.get(b) ?? 0) - (lastChange.get(a) ?? 0))[0];
  if (!root) return notify('Mewndo', 'Nothing to undo: no folders are protected yet.');
  const journal = mewndo.journalFor(root);
  const latest = (await journal.listSavePoints()).at(-1);
  if (!latest) return notify('Mewndo', `Nothing to undo in ${folderName(root)} yet.`);
  const diff = await journal.diffSince(latest.id);
  if (!diff.deleted.length && !diff.edited.length && !diff.moved.length && !diff.created.length) {
    return notify('Mewndo', `Nothing changed in ${folderName(root)} since the last save point.`);
  }
  const plan = await journal.planRestore(latest.id);
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Undo', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Undo last changes',
    message: `Undo the changes in ${folderName(root)} since ${new Date(latest.createdAt).toLocaleString()}?`,
    detail: `${diff.summary}\n\n${confirmText(plan)}`,
  });
  if (response !== 0) return;
  await reportRestore(root, await journal.restore(latest.id));
}

function confirmText(plan) {
  const back = plan.write.length + plan.links.length;
  const lines = [`${back} file${back === 1 ? '' : 's'} will be put back.`];
  if (plan.overwrites.length) {
    lines.push(`${plan.overwrites.length} of them ${plan.overwrites.length === 1 ? 'was' : 'were'} edited after the save point and will be replaced.`);
  }
  if (plan.trash.length) {
    lines.push(`${plan.trash.length} file${plan.trash.length === 1 ? '' : 's'} that didn't exist then will be moved to Mewndo's trash.`);
  }
  lines.push("Everything replaced or removed goes to Mewndo's trash, and a save point is made first, so you can undo this.");
  return lines.join('\n');
}

// Notify, and return the result for the window with trashUsed: whether anything went to the trash.
async function reportRestore(root, result) {
  openable.add(result.folder);
  openable.add(result.trashFolder);
  const failed = result.failures.length ? `, ${result.failures.length} could not be restored` : '';
  notify(result.verified ? 'Restore verified' : 'Restore needs attention',
    `${folderName(root)}: ${result.counts.written} files put back${failed}.`);
  storage.at = 0;
  stateChanged();
  return { ...result, trashUsed: await fsp.stat(result.trashFolder).then(() => true, () => false) };
}

async function togglePause() {
  if (mewndo.pausedUntil()) await mewndo.resumeProtection();
  else await mewndo.pauseProtection(HOUR);
  stateChanged();
}

// Stop the engine, then really quit. Runs once. The final app.quit() waits for a fresh tick: when quitting
// starts from the OS (SIGTERM, logoff) the engine can stop within the same tick as the cancelled
// before-quit, and quitting again from inside that leaves Electron half-quit with the window still open.
let quitPromise = null;
function quit() {
  quitting = true;
  quitPromise ??= (async () => {
    try { await mewndo?.stop(); } finally {
      stopped = true;
      setImmediate(() => app.quit());
    }
  })();
  return quitPromise;
}

function updateTray() {
  if (!tray) return;
  const until = mewndo.pausedUntil();
  tray.setToolTip(until ? `Mewndo: paused until ${new Date(until).toLocaleTimeString()}` : 'Mewndo: protecting your folders');
  const run = (fn) => () => fn().catch((e) => notify('Mewndo', e.message));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Window', click: showWindow },
    { label: 'Create Save Point', click: run(createSavePointEverywhere) },
    { label: 'Undo Last', click: run(undoLast) },
    { label: until ? 'Resume Protection' : 'Pause Protection for 1 Hour', click: run(togglePause) },
    { type: 'separator' },
    { label: 'Quit', click: () => quit() },
  ]));
}

// --- IPC: every argument from the window is checked ---------------------------------------------------------

function str(v, what) {
  if (typeof v !== 'string' || !v) throw new Error(`invalid ${what}`);
  return v;
}
function strList(v, what) {
  if (v === null || v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) throw new Error(`invalid ${what}`);
  return v;
}

const handlers = {
  state,
  async chooseFolders() {
    const r = await dialog.showOpenDialog(win, { title: 'Choose folders to protect', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  // Checks each folder (size, overlap, Mewndo's data), then starts protecting it in the background.
  async protect(roots) {
    const results = [];
    for (const root of strList(roots, 'folders') ?? []) {
      try {
        await mewndo.protect(root, { background: true });
        results.push({ root, ok: true });
      } catch (e) {
        results.push({ root, ok: false, error: e.code === 'ENOENT' ? 'This folder does not exist.' : e.message });
      }
    }
    stateChanged();
    return results;
  },
  async unprotect(root, keepHistory) {
    await mewndo.unprotect(str(root, 'folder'), { keepHistory: keepHistory !== false });
    storage.at = 0;
    stateChanged();
  },
  async finishSetup(openAtLogin) {
    settings.setupDone = true;
    settings.openAtLogin = openAtLogin !== false;
    await saveSettings();
    applyOpenAtLogin();
    stateChanged();
  },
  async setOpenAtLogin(on) {
    settings.openAtLogin = on === true;
    await saveSettings();
    applyOpenAtLogin();
  },
  togglePause,
  async savePoints(root) {
    return (await mewndo.journalFor(str(root, 'folder')).listSavePoints()).reverse();
  },
  async createSavePoint(root, label) {
    const name = typeof label === 'string' ? label.trim().slice(0, 200) : '';
    const sp = await mewndo.journalFor(str(root, 'folder')).createSavePoint({ label: name });
    storage.at = 0;
    return sp;
  },
  diff: (root, id) => mewndo.journalFor(str(root, 'folder')).diffSince(str(id, 'save point')),
  async plan(root, id, paths) {
    const plan = await mewndo.journalFor(str(root, 'folder')).planRestore(str(id, 'save point'), { paths: strList(paths, 'paths') });
    return { ...plan, text: confirmText(plan) };
  },
  // mode 'in-place' or 'separate'. Separate asks where, then restores into a new folder there.
  async restore(root, id, paths, mode) {
    const journal = mewndo.journalFor(str(root, 'folder'));
    let into;
    if (mode === 'separate') {
      const r = await dialog.showOpenDialog(win, { title: 'Where should the restored copy go?', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      const d = new Date(); // local time, as the user sees it
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
        + `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
      into = path.join(r.filePaths[0], `Mewndo restore of ${folderName(root)} ${stamp}`);
    } else if (mode !== 'in-place') {
      throw new Error('invalid mode');
    }
    const result = await journal.restore(str(id, 'save point'), { paths: strList(paths, 'paths'), into });
    return reportRestore(root, result);
  },
  async restores(root) {
    const list = await mewndo.journalFor(str(root, 'folder')).listRestores();
    for (const r of list) { openable.add(r.base); openable.add(r.trashRoot); }
    return list;
  },
  // Undo a restore: go back to the save point it made just before it ran.
  async undoRestore(root, restoreId) {
    const journal = mewndo.journalFor(str(root, 'folder'));
    const log = (await journal.listRestores()).find((r) => r.id === str(restoreId, 'restore'));
    if (!log?.beforeUndoId) throw new Error('This restore cannot be undone because it did not change the folder.');
    return reportRestore(root, await journal.restore(log.beforeUndoId));
  },
  async openPath(p) {
    if (typeof p !== 'string' || !(openable.has(p) || mewndo.folders().some((f) => f.root === p))) throw new Error('not allowed');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
};

// --- Startup ---------------------------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit(); // another copy is running; it shows its window
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', (e) => { if (!stopped) { e.preventDefault(); quit(); } });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // needed for notifications
    await loadSettings();
    mewndo = createMewndo({ dataDir: path.join(app.getPath('userData'), 'data') });

    let progressSentAt = 0;
    mewndo.on('progress', (root, p) => {
      progress.set(root, p);
      // Scans report every file; the window needs a few updates a second.
      if (p.phase === 'done' || Date.now() - progressSentAt > 150) {
        progressSentAt = Date.now();
        send('progress', { root, ...p });
      }
    });
    mewndo.on('change', (root) => lastChange.set(root, Date.now()));
    mewndo.on('savepoint', (root) => { storage.at = 0; send('savepoints-changed', root); });
    mewndo.on('restored', (root) => send('restores-changed', root));
    mewndo.on('retry', (root, r) => send('retry', { root, ...r }));
    mewndo.on('folders-changed', () => { storage.at = 0; stateChanged(); });
    mewndo.on('pruned', () => { storage.at = 0; });
    mewndo.on('warning', (w) => { notify('Mewndo', w.message); send('toast', w.message); });

    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.handle(name, (event, ...args) => {
        if (event.sender !== win?.webContents) throw new Error('unknown sender');
        return fn(...args);
      });
    }

    tray = new Tray(icon().resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
    updateTray();

    createWindow(!(process.argv.includes('--hidden') && settings.setupDone));
    await mewndo.start(); // re-protects saved folders in the background, then prunes
    stateChanged();
  }).catch((e) => {
    dialog.showErrorBox('Mewndo could not start', String(e?.stack ?? e));
    app.exit(1);
  });
}
