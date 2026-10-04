// Electron main process: the window, the tray, dialogs and notifications. The engine runs in its own utility
// process (engine-host.js) and is reached only by messages, so engine work can never freeze the window.
// The window has no Node access; it talks to this process through the IPC calls in preload.js, all checked here.
// Nothing here uses synchronous file calls.
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, nativeImage, shell, utilityProcess } = require('electron');

const APP_ID = 'com.mewndo.app';
const HOUR = 60 * 60 * 1000;

// Dev and testing: a throwaway profile instead of the real one.
if (process.env.MEWNDO_USER_DATA) app.setPath('userData', path.resolve(process.env.MEWNDO_USER_DATA));

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
async function saveSettings() { // temp file + rename, like everything Mewndo writes
  const tmp = `${settingsFile()}.${crypto.randomUUID()}.mewndo-tmp`;
  await fsp.writeFile(tmp, JSON.stringify(settings), { flush: true });
  await fsp.rename(tmp, settingsFile());
}

// --- The engine process ----------------------------------------------------------------------------------------

let engine = null;
let nextCallId = 0;
const calls = new Map(); // id -> { resolve, reject }
let crashes = [];

// Call an engine method; resolves with its result. See engine-host.js for the methods.
function call(method, ...args) {
  return new Promise((resolve, reject) => {
    if (!engine) return reject(new Error('The Mewndo engine is not running.'));
    const id = ++nextCallId;
    calls.set(id, { resolve, reject });
    engine.postMessage({ id, method, args });
  });
}

function onEngineMessage(msg) {
  if (msg.id) {
    const pending = calls.get(msg.id);
    calls.delete(msg.id);
    if (!pending) return;
    if (msg.error !== undefined) pending.reject(Object.assign(new Error(msg.error), { code: msg.code }));
    else pending.resolve(msg.result);
    return;
  }
  const [a, b] = msg.args;
  switch (msg.event) {
    case 'progress': progress.set(a, b); send('progress', { root: a, ...b }); break;
    case 'change': lastChange.set(a, Date.now()); break;
    case 'savepoint': storage.at = 0; send('savepoints-changed', a); break;
    case 'restored': send('restores-changed', a); break;
    case 'retry': send('retry', { root: a, ...b }); break;
    case 'folders-changed': storage.at = 0; stateChanged(); break;
    case 'pruned': storage.at = 0; break;
    case 'warning': notify('Mewndo', a.message); send('toast', a.message); break;
    default: break;
  }
}

// Start the engine process. If it ever dies, everything it was doing fails cleanly and it is started again
// (its own startup finishes interrupted restores). Three crashes within a minute: stop and tell the user.
function startEngine() {
  // All file work in the engine shares one pool of threads (4 by default). A slow scan (antivirus checking every
  // file, OneDrive, network drives) can fill it, making quick work like checking a new folder wait minutes.
  engine = utilityProcess.fork(path.join(__dirname, 'engine-host.js'), [], {
    serviceName: 'Mewndo engine', stdio: 'inherit', env: { ...process.env, UV_THREADPOOL_SIZE: '16' },
  });
  engine.on('message', onEngineMessage);
  engine.on('exit', (code) => {
    engine = null;
    for (const { reject } of calls.values()) reject(new Error('The Mewndo engine stopped.'));
    calls.clear();
    if (quitting) return;
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length >= 3) {
      dialog.showErrorBox('Mewndo stopped working',
        `The Mewndo engine keeps stopping (exit code ${code}). Your folders are not being protected. Please restart Mewndo.`);
      return;
    }
    notify('Mewndo', 'The Mewndo engine stopped unexpectedly and is restarting.');
    setTimeout(startEngine, 1000);
  });
  call('start', { dataDir: path.join(app.getPath('userData'), 'data') })
    .then(stateChanged, (e) => notify('Mewndo could not start protecting', e.message));
}

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
    storage = { at: Date.now(), report: await call('storageReport') };
  }
  return storage.report;
}

// Documents and Desktop, if they are real folders. Some systems report the home folder itself for a missing
// Documents folder, which must never be suggested.
async function suggestions(folders) {
  const home = path.resolve(app.getPath('home'));
  const out = [];
  for (const name of ['documents', 'desktop']) {
    const p = path.resolve(app.getPath(name));
    const isDir = await fsp.stat(p).then((s) => s.isDirectory(), () => false);
    if (isDir && p !== home && !out.includes(p) && !folders.some((f) => f.root === p)) out.push(p);
  }
  return out;
}

async function state() {
  const [folders, pausedUntil, report] = await Promise.all([call('folders'), call('pausedUntil'), storageReport().catch(() => null)]);
  const bytes = new Map((report?.folders ?? []).map((f) => [f.folder, f.bytes]));
  return {
    setupDone: settings.setupDone,
    openAtLogin: settings.openAtLogin,
    loginSupported: process.platform !== 'linux',
    pausedUntil,
    suggestions: settings.setupDone ? [] : await suggestions(folders),
    folders: folders.map((f) => ({
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
  const folders = (await call('folders')).filter((f) => f.status !== 'scanning');
  if (!folders.length) return notify('Mewndo', 'No folders are protected yet.');
  for (const f of folders) await call('journal.createSavePoint', f.root, { label: 'From the tray', trigger: 'manual' });
  notify('Save point created', `${folders.length} folder${folders.length > 1 ? 's' : ''}: ${folders.map((f) => folderName(f.root)).join(', ')}`);
}

// Undo Last: put the folder that changed most recently back to its latest save point, after asking.
async function undoLast() {
  const folders = (await call('folders')).filter((f) => f.status === 'protected' || f.status === 'paused');
  const root = folders.map((f) => f.root).sort((a, b) => (lastChange.get(b) ?? 0) - (lastChange.get(a) ?? 0))[0];
  if (!root) return notify('Mewndo', 'Nothing to undo: no folders are protected yet.');
  const latest = (await call('journal.listSavePoints', root)).at(-1);
  if (!latest) return notify('Mewndo', `Nothing to undo in ${folderName(root)} yet.`);
  const diff = await call('journal.diffSince', root, latest.id);
  if (!diff.deleted.length && !diff.edited.length && !diff.moved.length && !diff.created.length) {
    return notify('Mewndo', `Nothing changed in ${folderName(root)} since the last save point.`);
  }
  const plan = await call('journal.planRestore', root, latest.id);
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Undo', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Undo last changes',
    message: `Undo the changes in ${folderName(root)} since ${new Date(latest.createdAt).toLocaleString()}?`,
    detail: `${diff.summary}\n\n${confirmText(plan)}`,
  });
  if (response !== 0) return;
  await reportRestore(root, await call('journal.restore', root, latest.id));
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
  if (await call('pausedUntil')) await call('resumeProtection');
  else await call('pauseProtection', HOUR);
  stateChanged();
}

// Stop the engine, then really quit. Runs once. The final app.quit() waits for a fresh tick: when quitting
// starts from the OS (SIGTERM, logoff) the engine can stop within the same tick as the cancelled
// before-quit, and quitting again from inside that leaves Electron half-quit with the window still open.
let quitPromise = null;
function quit() {
  quitting = true;
  quitPromise ??= (async () => {
    try {
      // Let the engine stop cleanly, but never hang quitting on it.
      await Promise.race([call('stop'), new Promise((r) => setTimeout(r, 15_000))]);
    } catch { /* not running */ } finally {
      engine?.kill();
      stopped = true;
      setImmediate(() => app.quit());
    }
  })();
  return quitPromise;
}

async function updateTray() {
  if (!tray) return;
  const until = await call('pausedUntil').catch(() => null);
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
        await call('protect', root, { background: true });
        results.push({ root, ok: true });
      } catch (e) {
        results.push({ root, ok: false, error: e.code === 'ENOENT' ? 'This folder does not exist.' : e.message });
      }
    }
    stateChanged();
    return results;
  },
  async unprotect(root, keepHistory) {
    await call('unprotect', str(root, 'folder'), { keepHistory: keepHistory !== false });
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
    return (await call('journal.listSavePoints', str(root, 'folder'))).reverse();
  },
  async createSavePoint(root, label) {
    const name = typeof label === 'string' ? label.trim().slice(0, 200) : '';
    const sp = await call('journal.createSavePoint', str(root, 'folder'), { label: name });
    storage.at = 0;
    return sp;
  },
  diff: (root, id) => call('journal.diffSince', str(root, 'folder'), str(id, 'save point')),
  async plan(root, id, paths) {
    const plan = await call('journal.planRestore', str(root, 'folder'), str(id, 'save point'), { paths: strList(paths, 'paths') });
    return { ...plan, text: confirmText(plan) };
  },
  // mode 'in-place' or 'separate'. Separate asks where, then restores into a new folder there.
  async restore(root, id, paths, mode) {
    str(root, 'folder');
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
    const result = await call('journal.restore', root, str(id, 'save point'), { paths: strList(paths, 'paths'), into });
    return reportRestore(root, result);
  },
  async restores(root) {
    const list = await call('journal.listRestores', str(root, 'folder'));
    for (const r of list) { openable.add(r.base); openable.add(r.trashRoot); }
    return list;
  },
  // Undo a restore: go back to the save point it made just before it ran.
  async undoRestore(root, restoreId) {
    const log = (await call('journal.listRestores', str(root, 'folder'))).find((r) => r.id === str(restoreId, 'restore'));
    if (!log?.beforeUndoId) throw new Error('This restore cannot be undone because it did not change the folder.');
    return reportRestore(root, await call('journal.restore', root, log.beforeUndoId));
  },
  async openPath(p) {
    if (typeof p !== 'string' || !(openable.has(p) || (await call('folders')).some((f) => f.root === p))) throw new Error('not allowed');
    const err = await shell.openPath(p);
    if (err) throw new Error(err);
  },
  // A round trip to the engine process and back; the responsiveness check uses it.
  ping: () => call('ping'),
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
    startEngine(); // re-protects saved folders and prunes, all inside the engine process

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
  }).catch((e) => {
    dialog.showErrorBox('Mewndo could not start', String(e?.stack ?? e));
    app.exit(1);
  });
}
