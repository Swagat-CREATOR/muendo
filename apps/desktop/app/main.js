// Electron main process: the window, the tray, dialogs and notifications. The engine runs in its own utility
// process (engine-host.js) and is reached only by messages, so engine work can never freeze the window.
// The window has no Node access; it talks to this process through the IPC calls in preload.js, all checked here.
// Nothing here uses synchronous file calls.
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, nativeImage, shell, utilityProcess, globalShortcut, clipboard, screen,
} = require('electron');
const { buildBrief, briefLabel, DEFAULT_SAFETY_RULES } = require('../engine/brief'); // plain text only, no engine work
const { createLog } = require('../engine/log'); // async file appends only, no engine work
const { createCore } = require('./core');
const { createCoreClient } = require('./desk/core-client');
const { createDeskWindows } = require('./desk/windows');
const { createFocus } = require('./desk/focus');
const { createDesk } = require('./desk/desk');
const { createBar } = require('./bar');
const { place, beside } = require('./dock-place');
const { DEFAULTS: SHORTCUT_DEFAULTS, pickShortcut } = require('./shortcuts');
const { createSpeech } = require('./speech');
const { parseIntent, describe: describeIntent } = require('../engine/voice'); // plain text only, no engine work

// Set up once the app is ready (the data folder depends on the profile). Until then, lines are dropped.
let log = { info() {}, warn() {}, error() {}, file: null };

// Problems Mewndo shows in the main window until they're resolved: key -> { code, message, folder }.
const alerts = new Map();
const alertKey = (code, folder) => `${code}|${folder ?? ''}`;

const APP_ID = 'com.mewndo.app';
const GB = 1024 ** 3;
const dataDir = () => path.join(app.getPath('userData'), 'data');
// Storage numbers in the windows may be this old: measuring big folders with long histories takes seconds.
const REPORT_MAX_AGE = 10 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Dev and testing: a throwaway profile instead of the real one.
// Always %APPDATA%\mewndo (the hook script and the uninstaller look there), however the app is named or started.
// Dev and testing: MEWNDO_USER_DATA picks a throwaway profile instead.
app.setPath('userData', process.env.MEWNDO_USER_DATA ? path.resolve(process.env.MEWNDO_USER_DATA) : path.join(app.getPath('appData'), 'mewndo'));

let win = null;
let tray = null;
let bar = null; // the Mewndo bar (bar.js)
let quitting = false;
let stopped = false;
let settings = { setupDone: false, openAtLogin: true };
const progress = new Map(); // folder -> latest scan/restore progress
const openable = new Set(); // paths the window may ask to open: restore targets and trash folders
let storage = { at: 0, report: null };

const settingsFile = () => path.join(app.getPath('userData'), 'app-settings.json');
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const notify = (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); };
const folderName = (root) => path.basename(root) || root;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

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
  if (msg.event === 'drift' || msg.event === 'braked') lastAlertAt = Date.now();
  if (msg.event === 'drift') { lastDriftAt = Date.now(); recentDrifters.add(a.agent); }
  if (msg.event === 'drift' || msg.event === 'guard') driftCard = cardFor(msg.event, a);
  if (msg.event === 'guard') lastAlertAt = Date.now();
  if (msg.event === 'holds-changed') { holds = a ?? []; if (holds.length) lastAlertAt = Date.now(); }
  if (BAR_EVENTS.has(msg.event)) refreshBar();
  if (msg.event === 'change') setTimeout(refreshBar, 1100); // the engine sends one change a second: catch the last
  switch (msg.event) {
    case 'progress': progress.set(a, b); send('progress', { root: a, ...b }); break;
    case 'savepoint': storage.at = 0; send('savepoints-changed', a); break;
    case 'drift': onDrift(a); break;
    case 'braked': notify('Mewndo braked an agent', `${a.agent}: ${a.reason}. Resume it from the tray menu when you're ready.`); send('state-changed'); updateTray(); break;
    case 'resumed': onResumed(a); break;
    case 'restored': send('restores-changed', a); break;
    case 'retry': send('retry', { root: a, ...b }); break;
    case 'burst': burstAlert(a, b).catch(() => {}); break;
    case 'folders-changed': storage.at = 0; stateChanged(); break;
    case 'agents-changed': stateChanged(); break;
    case 'pruned':
      storage.at = 0;
      if (a && !a.overBudget && alerts.delete(alertKey('over-budget'))) stateChanged();
      break;
    case 'warning': {
      log.warn(a.message, { code: a.code, folder: a.folder });
      // Most warnings stay in the main window until resolved; a notification says it once.
      const key = alertKey(a.code, a.folder);
      const fresh = !alerts.has(key);
      if (a.code !== 'journal' && a.code !== 'agents') alerts.set(key, { code: a.code, message: a.message, folder: a.folder ?? null });
      if (fresh) notify('Mewndo', a.message);
      send('toast', a.message);
      stateChanged();
      break;
    }
    case 'resolved':
      log.info(a.message, { code: a.code, folder: a.folder });
      if (alerts.delete(alertKey(a.code, a.folder))) {
        notify('Mewndo', a.message);
        send('toast', a.message);
        stateChanged();
      }
      break;
    case 'log': log[a === 'error' ? 'error' : a === 'warn' ? 'warn' : 'info'](b, msg.args[2]); break;
    default: break;
  }
}

// Start the engine process. If it ever dies, everything it was doing fails cleanly and it is started again
// (its own startup finishes interrupted restores). Three crashes within a minute: stop and tell the user.
// Which engine restores: 'rust' (mewndo-core), 'shadow' (v0 restores; both engines' manifests are compared every
// hour and differences logged) or 'v0'. Rust is the default: it passes every v0 restore test (P1.7).
const ENGINES = ['rust', 'shadow', 'v0'];
const engineChoice = () => (ENGINES.includes(settings.engine) ? settings.engine : 'rust');
let restartingEngine = false;

function startEngine() {
  // All file work in the engine shares one pool of threads (4 by default). A slow scan (antivirus checking every
  // file, OneDrive, network drives) can fill it, making quick work like checking a new folder wait minutes.
  engine = utilityProcess.fork(path.join(__dirname, 'engine-host.js'), [], {
    serviceName: 'Mewndo engine', stdio: 'inherit',
    // The engine opens its own connection to the core (engine/core-client.js) unless it's to use v0 only.
    env: { ...process.env, UV_THREADPOOL_SIZE: '16', ...(engineChoice() !== 'v0' && core ? { MEWNDO_CORE_PIPE: core.address } : {}) },
  });
  engine.on('message', onEngineMessage);
  engine.on('exit', (code) => {
    if (!quitting && !restartingEngine) log.error(`The engine process stopped (exit code ${code})`);
    engine = null;
    for (const { reject } of calls.values()) reject(new Error('The Mewndo engine stopped.'));
    calls.clear();
    if (quitting) return;
    if (restartingEngine) { restartingEngine = false; startEngine(); return; } // asked for: not a crash
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length >= 3) {
      dialog.showErrorBox('Mewndo stopped working',
        `The Mewndo engine keeps stopping (exit code ${code}). Your folders are not being protected. Please restart Mewndo.`);
      return;
    }
    notify('Mewndo', 'The Mewndo engine stopped unexpectedly and is restarting.');
    setTimeout(startEngine, 1000);
  });
  call('start', { dataDir: dataDir(), budgetBytes: settings.budgetGB ? settings.budgetGB * GB : undefined, burst: settings.burst, engine: engineChoice(), guardFailOpen: settings.guardFailOpen === true })
    .then(stateChanged, (e) => notify('Mewndo could not start protecting', e.message));
}

// --- mewndo-core, the Rust service for version 1 (core/). Restores run there (see engineChoice). ----------------

let core = null;

// Installed: shipped next to the app. From source: what `npm start` at the repository root just built, or
// MEWNDO_CORE_BIN (a Windows build kept outside the repository, scripts/windows.sh).
function coreBinary() {
  const exe = process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core';
  if (app.isPackaged) return path.join(process.resourcesPath, exe);
  return process.env.MEWNDO_CORE_BIN || path.join(__dirname, '..', '..', '..', 'core', 'target', 'debug', exe);
}

// The Agent Desk's folder: core.json and desk.db (docs/decisions.md, "desk.db location").
const deskDir = () => (process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Mewndo')
  : path.join(app.getPath('userData'), 'desk'));

function startCore() {
  core = createCore({
    binary: coreBinary(), runDir: app.getPath('userData'), logDir: path.dirname(log.file), log, onChange: stateChanged,
    args: ['--desk', deskDir(), '--data', dataDir()],
  });
  core.start();
}

// --- The Agent Desk (spec §33): the Inbox cards, the Talk box and the agents, fed by the core's v2 pipe ---------

const INBOX_KEY = 'Control+Shift+F11'; // §33.3; not configurable yet
const TALK_KEY = 'Control+Shift+F12'; // §33.5
let desk = null;
let deskWindows = null;
let rulesOnly = false; // the gateway says today's model budget is out (budget.state)

// The cards and the Talk box open beside the dock, toward the middle of the screen (design spec §11.8 step 5).
let dockAt = null; // the bar's last onPlaced
const CARDS_SIZE = { width: 452, height: 600 }; // 420 px cards plus the shadow's room
const TALK_SIZE = { width: 496, height: 96 }; // the 480 px box, two lines and the route chips
function placeDeskWindows() {
  if (!deskWindows) return;
  const at = dockAt ?? { ...place(screen.getPrimaryDisplay(), undefined), workArea: screen.getPrimaryDisplay().workArea };
  deskWindows.place('cards', beside(at.bounds, at.edge, at.anchor, at.workArea, CARDS_SIZE));
  deskWindows.place('talk', beside(at.bounds, at.edge, at.anchor, at.workArea, TALK_SIZE, 4));
}

// Undo on an Inbox card: put the folder back to the save point written when the answer was released (§33.4),
// after the same kind of confirmation as every other undo (§23.3).
async function undoToSavePoint(savePointId) {
  for (const f of await call('folders')) {
    const sp = (await call('journal.listSavePoints', f.root)).find((x) => x.id === savePointId);
    if (!sp) continue;
    const plan = await call('journal.planRestore', f.root, sp.id, {});
    if (!plan.write.length && !plan.links.length && !plan.trash.length) {
      return showAsk('', `Nothing changed in ${folderName(f.root)} since that answer.`, [{ label: 'OK' }]);
    }
    return showAsk('', `Undo everything since that answer? ${folderName(f.root)} goes back to ${new Date(sp.createdAt).toLocaleTimeString()}: ${confirmText(plan).split('\n')[0]}`, [
      { label: 'Undo', run: async () => reportRestore(f.root, await call('journal.restore', f.root, sp.id)) },
      { label: 'Cancel' },
    ]);
  }
  return showAsk('', 'That save point is not in any protected folder any more.', [{ label: 'OK' }]);
}

function deskCommand(command, plan) {
  if (command === 'undo-to') return undoToSavePoint(plan.savepointId).catch((e) => notify('Mewndo could not plan that undo', e.message));
  // Talk-box commands (§23.3): the same intents and confirmations as the voice ones.
  return runIntent(plan.intent ?? { intent: command }).catch((e) => notify('Mewndo could not do that', e.message));
}

function startDesk() {
  const client = createCoreClient({
    dir: deskDir(), log,
    onStatus: ({ state, message }) => {
      log.info(`Agent Desk: ${state}${message ? ` (${message})` : ''}`);
      if (state === 'needs-update') notify('Mewndo', message);
    },
  });
  const on = {
    key: (k, id) => desk?.handlers.key(k, id),
    click: (a, id, arg) => desk?.handlers.click(a, id, arg),
    graceEnd: (id) => desk?.handlers.graceEnd(id),
    text: (id, t, via) => desk?.handlers.text(id, t, via),
    talk: (t) => desk?.handlers.talk(t),
    chip: (n) => desk?.handlers.chip(n),
    closeTalk: () => desk?.handlers.closeTalk(),
    lane: (a, id, arg) => desk?.handlers.lane(a, id, arg),
  };
  deskWindows = createDeskWindows({ log, on });
  placeDeskWindows();
  screen.on('display-metrics-changed', placeDeskWindows);
  desk = createDesk({
    client, ui: deskWindows, focus: createFocus({ log }), log,
    commands: deskCommand,
    problem: (message) => notify('Mewndo', message),
    onBudget: (on) => {
      if (on === rulesOnly) return;
      rulesOnly = on;
      log.info(on ? 'The decision model is out of budget for today: rules only' : 'The decision model is back');
      refreshBar();
    },
  });
  desk.start();
  if (!tryRegister(INBOX_KEY, () => desk.openInbox())) log.warn(`The Inbox key ${INBOX_KEY} is taken by another app`);
  if (!tryRegister(TALK_KEY, () => desk.openTalk())) log.warn(`The Talk key ${TALK_KEY} is taken by another app`);
}

// Windows and macOS; a no-op on Linux. Started at login, Mewndo opens hidden in the tray. Only for the installed app:
// run from source, the entry would start a bare Electron. The name is what the uninstaller removes.
function applyOpenAtLogin() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: true, args: ['--hidden'], name: 'Mewndo' });
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

// The title bar (design spec §7.1): Windows draws real minimize, maximize and close buttons over our own 40 px bar,
// in the window's frame colour.
// ponytail: the main window is light for now (the user's call, 10 Oct); a Settings theme choice can bring dark back.
const titleBarOverlay = () => ({ color: '#ECEFEB', symbolColor: '#15171A', height: 40 });

// The saved size and position, if it still lands on a connected display.
function savedBounds() {
  const b = settings.windowBounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return {};
  const wa = screen.getDisplayMatching(b).workArea;
  const visible = b.x < wa.x + wa.width - 100 && b.x + b.width > wa.x + 100 && b.y >= wa.y - 10 && b.y < wa.y + wa.height - 100;
  return visible ? b : { width: b.width, height: b.height };
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1180, height: 760, ...savedBounds(), minWidth: 900, minHeight: 600, show, title: 'Mewndo', icon: icon(),
    titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  let saveTimer = null;
  const remember = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
      settings.windowBounds = win.getBounds();
      saveSettings().catch((e) => log.warn(`Couldn't save the window's size: ${e.message}`));
    }, 500);
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // A crashed window is reloaded; Mewndo itself keeps running.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('The main window crashed; reloading it', details);
    if (!win.isDestroyed()) win.reload();
  });
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
    storage = { at: Date.now(), report: await call('storageReport', { maxAgeMs: REPORT_MAX_AGE }) };
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
    if (isDir && p !== home && !out.includes(p) && !folders.some((f) => samePath(f.root, p))) out.push(p);
  }
  return out;
}

// The sidebar's "Protect your work" checklist (design spec §7.3): each item ticks itself from what really happened.
// Once everything is done it shows "You're set up" for the rest of that session, then never again.
// What it can't do: "Connect an account" is left out until Connections exist.
let checklistFinishing = false;
function checklist(folders, guarded) {
  const items = {
    folder: folders.length > 0,
    agent: Object.values(guarded).some(Boolean),
    undo: settings.triedUndo === true,
    shortcuts: settings.shortcutsTested === true,
  };
  const done = Object.values(items).every(Boolean);
  if (done && !settings.checklistDone) {
    settings.checklistDone = true;
    checklistFinishing = true;
    saveSettings().catch((e) => log.warn(`Couldn't save the checklist: ${e.message}`));
  }
  return { items, done, hidden: settings.checklistDone === true && !checklistFinishing };
}

async function state() {
  const [folders, pausedUntil, report, agents, hookProblem, guarded] = await Promise.all([
    call('folders'), call('pausedUntil'), storageReport().catch(() => null), call('agents'), call('hookServerProblem'),
    refreshHookStatus().catch(() => ({})),
  ]);
  const bytes = new Map((report?.folders ?? []).map((f) => [f.folder, f.bytes]));
  return {
    setupDone: settings.setupDone,
    openAtLogin: settings.openAtLogin,
    loginSupported: process.platform !== 'linux',
    shortcutProblem,
    alerts: [...alerts.values()],
    agents,
    hookProblem,
    windows: process.platform === 'win32',
    pausedUntil,
    core: core?.status() ?? null,
    suggestions: settings.setupDone ? [] : await suggestions(folders),
    folders: folders.map((f) => ({
      ...f, name: folderName(f.root), storageBytes: bytes.get(f.root) ?? null, progress: progress.get(f.root) ?? null,
    })),
    trashBytes: report?.trashBytes ?? null,
    usedBytes: report?.usedBytes ?? null,
    budgetBytes: report?.budgetBytes ?? null,
    checklist: checklist(folders, guarded),
    shortcuts: { undo: prettyShortcut(shortcutFor('undo')), brief: prettyShortcut(shortcutFor('brief')) },
  };
}

function stateChanged() {
  updateTray();
  refreshBar();
  send('state-changed');
}

// --- The Mewndo bar ---------------------------------------------------------------------------------------------
// It renders from the engine's events: protection (green protected, amber drift in the last 5 minutes, red braked,
// grey paused or nothing protected), one dot per running agent, and an alert for a minute after a drift or brake.
const BAR_EVENTS = new Set(['agents-changed', 'braked', 'resumed', 'drift', 'guard', 'holds-changed', 'folders-changed', 'restored', 'change', 'savepoint']);
const ALERT_MS = 60_000;
const DRIFT_MS = 5 * 60_000;
let lastAlertAt = 0;
let lastDriftAt = 0;
const recentDrifters = new Set(); // agents that drifted (amber dot while the drift is recent)
let barRefresh = null;
let barAgents = []; // names of the agents the bar shows, for its Brake button
let driftCard = null; // the newest drift card (spec §23.4) until the user answers or dismisses it
let holds = []; // local holds waiting for the user (engine 'holds-changed')
let cardSeq = 0;
let panelOpen = false;
let speech = null; // speech to text for the bar's mic (speech.js)
let ask = null; // a voice command waiting for the user: { id, heard, text, choices: [{ label, run }] }
let hookStatus = { at: 0, guarded: {} }; // which agents have Mewndo's Guard hooks, re-read every 30 s

// The up-arrow panel (spec §23.8), from local data only: agents and protected folders, and how sure Mewndo is.
async function refreshHookStatus() {
  if (Date.now() - hookStatus.at > 30_000) {
    const [claude, codex, cursor] = await Promise.all([call('claudeHooksPlan'), call('agentHooksPlan', 'codex'), call('agentHooksPlan', 'cursor')]
      .map((p) => p.then((x) => x.installed === true, () => false)));
    hookStatus = { at: Date.now(), guarded: { 'Claude Code': claude, Codex: codex, Cursor: cursor } };
  }
  return hookStatus.guarded;
}

async function panelData(folders, brakedNames) {
  await refreshHookStatus();
  const activity = await call('activity').catch(() => ({ agents: [], folders: [], activeMs: 0 }));
  const names = [...new Set(['Claude Code', 'Codex', 'Cursor', ...activity.agents.map((a) => a.name), ...brakedNames])];
  const agents = names.map((name) => {
    const a = activity.agents.find((x) => x.name === name) ?? {};
    const guarded = hookStatus.guarded[name] === true;
    const working = !!a.last || (guarded && Date.now() - (a.hookedAt ?? 0) < activity.activeMs);
    return {
      name,
      connection: guarded ? 'Hooks' : a.running ? 'Detected' : 'Not connected',
      status: brakedNames.has(name) ? 'Braked' : working ? 'Working' : guarded || a.running ? 'Idle' : 'Not connected',
      monitoring: guarded ? 'Guarded' : a.running ? 'Data only' : null,
      now: a.last ? `${a.last.text}${a.last.folder ? ` in ${folderName(a.last.folder)}` : ''}` : '',
    };
  });
  const connections = folders.map((f) => {
    const act = activity.folders.find((x) => x.root === f.root);
    return {
      name: folderName(f.root), root: f.root, protection: f.status === 'paused' ? 'Paused' : 'Protected',
      bubbles: act?.confidence ? [{ agent: act.agent, confidence: act.confidence, ago: Math.round((Date.now() - act.at) / 60_000) }] : [],
    };
  });
  return { agents, connections };
}

// What the drift card says: what the agent tried and what Mewndo did, from a Guard refusal or a Heal.
function cardFor(event, a) {
  const id = `card-${++cardSeq}`;
  if (event === 'guard') {
    const act = a.actions?.[0] ?? {};
    const tried = act.kind === 'shell' ? `run ${act.command.replace(/\s+/g, ' ').trim().slice(0, 120)}` : `${act.kind} ${path.basename(act.path ?? '')}`;
    return {
      id, agent: a.agent, folder: a.folder, actions: a.actions ?? [], braked: a.verdict.rule === 'burst',
      tried: `${a.agent} tried to ${tried}`,
      did: a.verdict.decision === 'deny' ? `Mewndo blocked it: ${a.verdict.reason}` : `Mewndo asked it to check with you first: ${a.verdict.reason}`,
    };
  }
  const files = a.paths?.length === 1 ? a.paths[0] : `${a.paths?.length ?? 0} files`;
  return {
    id, agent: a.agent, folder: a.folder, braked: a.action === 'braked',
    actions: (a.paths ?? []).map((p) => ({ kind: 'delete', path: path.join(a.folder, p) })),
    tried: `${a.agent} deleted ${files} outside its brief`,
    did: a.action === 'healed' ? `Mewndo put back ${a.healed.join(', ')}.` : a.action === 'braked' ? `Mewndo braked ${a.agent}: ${a.reason}.`
      : "Mewndo couldn't put it back: no save point had it.",
  };
}

function startBar() {
  bar = createBar({
    positions: settings.barPositions ?? {},
    savePositions(positions) {
      settings.barPositions = positions;
      saveSettings().catch((e) => log.warn(`Couldn't save the bar's position: ${e.message}`));
    },
    onAction(name, arg) {
      barAction(name, arg).catch((e) => notify('Mewndo', e.message));
    },
    onVoice(wav) {
      voiceCommand(wav).catch((e) => showAsk('', `Voice command failed: ${e.message}`, [{ label: 'OK' }]));
    },
    async fullScreen() {
      return process.platform === 'win32' && core?.status().state === 'running' && (await core.request('screen_state')).full_screen === true;
    },
    onPlaced(at) {
      dockAt = at;
      placeDeskWindows();
    },
    log,
  });
  bar.setEnabled(settings.barOff !== true);
  speech = createSpeech({ log });
  if (settings.barOff !== true) speech.warm();
  refreshBar();
}

// --- Voice commands (spec §23.3) ----------------------------------------------------------------------------------
// Hold the mic, speak, let go: the words become one intent. Stop, resume, brief and "what changed" act at once (a
// brief still waits for Ctrl+Enter); undo and freeze always show what they'll do and wait for Confirm; anything
// unclear asks "did you mean". What it can't do: undo can't separate one agent's changes from yours made in the
// same minutes, so it puts the whole folder back to the save point before then, and says so.
let askSeq = 0;
function showAsk(heard, text, choices) {
  ask = { id: `ask-${++askSeq}`, heard, text, choices };
  lastAlertAt = Date.now();
  refreshBar();
}

async function voiceCommand(wav) {
  const heard = await speech.transcribe(wav);
  const agents = [...new Set(['Claude Code', 'Codex', 'Cursor', ...((await call('agents').catch(() => [])).map((a) => a.name))])];
  const intent = parseIntent(heard, { agents });
  if (intent.intent === 'unclear') {
    const choices = intent.suggestions.map((sug) => ({ label: describeIntent(sug), run: () => runIntent({ ...sug, heard }, true) }));
    return showAsk(heard, heard ? 'Did you mean:' : "Mewndo didn't catch that. Hold the mic and try again.", [...choices, { label: 'Cancel' }]);
  }
  return runIntent(intent, false);
}

// confirmed: the user already picked it from "did you mean" (undo and freeze still show their plan first).
async function runIntent(i, confirmed) {
  const heard = i.heard ?? '';
  switch (i.intent) {
    case 'stop':
      await call('brake', i.agent, { reason: 'you said stop' });
      return showAsk(heard, `Stopped ${i.agent}. Resume it from the bar when you're ready.`, [{ label: 'OK' }]);
    case 'resume': {
      const braked = (await call('braked')).map((b) => b.agent);
      const agent = i.agent ?? (braked.length === 1 ? braked[0] : null);
      if (!agent) return showAsk(heard, braked.length ? 'Resume which agent?' : 'No agent is braked.', [...braked.map((a) => ({ label: `Resume ${a}`, run: () => call('resumeAgent', a) })), { label: 'Cancel' }]);
      await call('resumeAgent', agent);
      ask = null;
      return refreshBar();
    }
    case 'brief':
      ask = null;
      refreshBar();
      return openBrief(i.task);
    case 'freeze': {
      const running = (await call('agents')).map((a) => a.name);
      if (!running.length) return showAsk(heard, 'No agents are running.', [{ label: 'OK' }]);
      return showAsk(heard, `Freeze ${running.join(', ')}? Their processes pause until you resume them.`, [
        { label: 'Freeze', run: async () => { for (const a of running) await call('brake', a, { reason: 'you froze everything', freeze: true }); } },
        { label: 'Cancel' },
      ]);
    }
    case 'undo': return planVoiceUndo(i, heard);
    case 'changes': {
      const lines = [];
      const today = new Date().setHours(0, 0, 0, 0);
      for (const f of await call('folders')) {
        const first = (await call('journal.listSavePoints', f.root)).find((sp) => Date.parse(sp.createdAt) >= today);
        if (!first) continue;
        const d = await call('journal.diffSince', f.root, first.id);
        if (!nothingChanged(d)) lines.push(`${folderName(f.root)}: −${d.deleted.length} ~${d.edited.length + d.moved.length} +${d.created.length}`);
      }
      return showAsk(heard, lines.length ? `Today: ${lines.join(' · ')}` : 'Nothing changed in your protected folders today.', [
        ...(lines.length ? [{ label: 'Show', run: () => showWindow() }] : []), { label: 'OK' },
      ]);
    }
    default: return undefined;
  }
}

async function planVoiceUndo(i, heard) {
  const since = Date.now() - i.minutes * 60_000;
  const activity = await call('activity').catch(() => ({ folders: [] }));
  const touched = activity.folders.filter((f) => f.agent && (!i.agent || f.agent === i.agent)).map((f) => f.root);
  const folders = touched.length ? touched : (await call('folders')).filter((f) => f.lastChangeAt && f.lastChangeAt >= since).map((f) => f.root);
  const plans = [];
  for (const root of folders) {
    const sp = (await call('journal.listSavePoints', root)).filter((x) => Date.parse(x.createdAt) <= since).at(-1);
    if (!sp) continue;
    const plan = await call('journal.planRestore', root, sp.id, {});
    if (plan.write.length + plan.links.length + plan.trash.length) plans.push({ root, sp, plan });
  }
  if (!plans.length) return showAsk(heard, `Nothing to undo from the last ${i.minutes} minutes.`, [{ label: 'OK' }]);
  const text = plans.map(({ root, sp, plan }) => `${folderName(root)} goes back to ${new Date(sp.createdAt).toLocaleTimeString()}: ${confirmText(plan).split('\n')[0]}`
    + (plan.trash.length ? ` ${plan.trash.length} newer file${plan.trash.length === 1 ? '' : 's'} go to Mewndo's trash.` : '')).join(' ');
  const caveat = i.agent ? ` This undoes every change there since then, not only ${i.agent}'s.` : '';
  return showAsk(heard, `${text}${caveat}`, [
    { label: 'Undo', run: async () => { for (const { root, sp } of plans) await reportRestore(root, await call('journal.restore', root, sp.id)); } },
    { label: 'Cancel' },
  ]);
}

function refreshBar() {
  if (!bar || barRefresh) return;
  barRefresh = setTimeout(async () => { // events come in bunches: one update for each bunch
    barRefresh = null;
    const [folders, agents, braked, until, tickers] = await Promise.all(['folders', 'agents', 'braked', 'pausedUntil', 'ticker'].map((m) => call(m).catch(() => null)));
    const brakedNames = new Set((braked ?? []).map((x) => x.agent));
    const now = Date.now();
    const status = brakedNames.size ? 'braked' : now - lastDriftAt < DRIFT_MS ? 'drift' : until ? 'paused' : folders?.length ? 'protected' : 'off';
    const label = {
      braked: `Mewndo braked ${[...brakedNames].join(', ')}`, drift: 'Mewndo: an agent went outside its brief',
      paused: 'Mewndo: protection paused', protected: `Mewndo: protecting ${folders?.length} folder${folders?.length === 1 ? '' : 's'}`,
      off: 'Mewndo: no folders protected',
    }[status];
    const names = [...new Set([...(agents ?? []).map((x) => x.name), ...brakedNames])];
    barAgents = names.filter((n) => !brakedNames.has(n));
    const drifted = new Set(now - lastDriftAt < DRIFT_MS ? recentDrifters : []);
    const t = tickers?.[0];
    bar.update({
      status, label, alert: now - lastAlertAt < ALERT_MS || !!driftCard || holds.length > 0,
      agents: names.map((name) => ({ name, braked: brakedNames.has(name), drift: drifted.has(name) })),
      ticker: t ? { ...t, name: folderName(t.root) } : null,
      shortcuts: { undo: prettyShortcut(shortcutFor('undo')), brief: prettyShortcut(shortcutFor('brief')) },
      card: driftCard, holds, ask: ask && { id: ask.id, heard: ask.heard, text: ask.text, choices: ask.choices.map((c) => c.label) },
      voice: speech?.available === true, panel: panelOpen ? await panelData(folders ?? [], brakedNames) : null,
      rulesOnly,
    });
  }, 30);
}
setInterval(refreshBar, 30_000).unref(); // drift and alert colours fade with time
setInterval(() => panelOpen && refreshBar(), 5000).unref(); // the open panel's live activity

// The bar's buttons (spec §23.2, §23.7). They all work with the main window closed.
async function barAction(name, arg) {
  switch (name) {
    case 'protection': case 'lane': case 'connection': showWindow(); break; // ponytail: the main window stands in for an agent's lane
    case 'panel-open': panelOpen = true; hookStatus.at = 0; refreshBar(); break;
    case 'panel-close': panelOpen = false; refreshBar(); break;
    case 'undo': openUndo(); break;
    case 'undo-burst': openUndo(arg); break; // undo always shows what it will do first (spec §23.3)
    case 'diff': {
      const savePoint = (await call('ticker')).find((t) => t.root === arg)?.savePoint;
      showWindow();
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
      if (savePoint) send('show-diff', { root: arg, savePoint });
      break;
    }
    case 'savepoint': await createSavePointEverywhere(); break;
    case 'brake': for (const agent of barAgents) await call('brake', agent, { reason: 'you braked it from the Mewndo bar' }); break;
    case 'brake-agent': if (arg) await call('brake', arg, { reason: 'you braked it from the Mewndo bar' }); break;
    // The drift card's buttons (spec §23.4). arg: the card's id, so a stale click on an older card does nothing.
    case 'card-resume': case 'card-letit': case 'card-stop': case 'card-dismiss': {
      const card = driftCard;
      if (!card || card.id !== arg) break;
      driftCard = null;
      refreshBar();
      if (name === 'card-letit') await call('letIt', card.agent, card.actions);
      if (name === 'card-stop') {
        if (!card.braked) await call('brake', card.agent, { reason: 'you stopped it to review', folder: card.folder });
        if (card.folder) await barAction('diff', card.folder);
      } else if (name !== 'card-dismiss' && card.braked) await call('resumeAgent', card.agent); // writes the corrected brief
      else if (name === 'card-resume') openBrief();
      break;
    }
    case 'ask-choose': { // arg: "<ask id>:<choice index>"; a stale click on an older question does nothing
      const [id, n] = String(arg).split(':');
      const current = ask;
      if (!current || current.id !== id) break;
      ask = null;
      refreshBar();
      await current.choices[Number(n)]?.run?.();
      break;
    }
    case 'hold-approve': await call('approveHold', arg); break;
    case 'hold-cancel': await call('cancelHold', arg); break;
    case 'hold-cancel-all': for (const h of holds) await call('cancelHold', h.id); break;
    default: break;
  }
}

function toggleBar() {
  settings.barOff = settings.barOff !== true;
  bar?.setEnabled(!settings.barOff);
  updateTray();
  return saveSettings();
}

// --- Actions shared by the window and the tray -------------------------------------------------------------

async function createSavePointEverywhere() {
  const folders = (await call('folders')).filter((f) => !['scanning', 'unavailable'].includes(f.status));
  if (!folders.length) return notify('Mewndo', 'No folders are protected yet.');
  for (const f of folders) await call('journal.createSavePoint', f.root, { label: 'From the tray', trigger: 'manual' });
  notify('Save point created', `${folders.length} folder${folders.length > 1 ? 's' : ''}: ${folders.map((f) => folderName(f.root)).join(', ')}`);
}

// --- One-key undo (the undo shortcut, and the tray's Undo Last) --------------------------------------------------

let undoWin = null;
let shortcutProblem = null; // shown in the main window when the shortcut couldn't be registered

const nothingChanged = (d) => !d.deleted.length && !d.edited.length && !d.moved.length && !d.created.length;
const prettyShortcut = (accel) => accel.replace('Control', 'Ctrl').replace('CommandOrControl', 'Ctrl');

// Folders to offer, most recent activity first: the ones that changed, or all when none did.
async function undoFolders() {
  const folders = (await call('folders')).filter((f) => f.status === 'protected' || f.status === 'paused');
  const active = folders.filter((f) => f.lastChangeAt).sort((a, b) => b.lastChangeAt - a.lastChangeAt);
  return (active.length ? active : folders).map((f) => ({ root: f.root, name: folderName(f.root) }));
}

// What Enter would undo in one folder: its latest save point, ignoring before-undo ones (going back to those
// is "undo the undo", which Recent Restores offers). If nothing changed since it, the one before it.
async function undoTarget(root) {
  const savePoints = (await call('journal.listSavePoints', root)).filter((sp) => sp.trigger !== 'before-undo');
  const latest = savePoints.at(-1);
  if (!latest) return { root, nothing: 'There are no save points for this folder yet.' };
  const diff = await call('journal.diffSince', root, latest.id);
  if (!nothingChanged(diff)) return { root, savePoint: latest, summary: diff.summary };
  const previous = savePoints.at(-2);
  if (!previous) return { root, nothing: 'Nothing changed since the latest save point.' };
  const older = await call('journal.diffSince', root, previous.id);
  if (nothingChanged(older)) return { root, nothing: 'Nothing changed since the latest save points.' };
  return {
    root, savePoint: previous, summary: older.summary,
    note: 'Nothing changed since the latest save point, so this goes back to the one before it.',
  };
}

function createUndoWindow() {
  undoWin = new BrowserWindow({
    width: 500, height: 340, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, title: 'Mewndo: undo', icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'undo-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  undoWin.setAlwaysOnTop(true, 'floating');
  undoWin.loadFile(path.join(__dirname, 'renderer', 'undo.html'));
  undoWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  undoWin.webContents.on('will-navigate', (e) => e.preventDefault());
  undoWin.on('close', (e) => { if (!quitting) { e.preventDefault(); undoWin.hide(); } });
}

// Show the undo window; it asks for the folders and the target itself (see renderer/undo.js).
// root: show that folder first (e.g. the one a burst alert was about).
let undoPreferred = null;
function openUndo(root) {
  undoPreferred = typeof root === 'string' ? root : null;
  if (!undoWin || undoWin.isDestroyed()) createUndoWindow();
  else undoWin.webContents.send('undo:open');
  undoWin.center();
  undoWin.show();
  // Again once it is on screen: some Linux window managers ignore it until the window has appeared.
  undoWin.setAlwaysOnTop(true, 'floating');
  setTimeout(() => { if (!undoWin.isDestroyed() && undoWin.isVisible()) undoWin.setAlwaysOnTop(true, 'floating'); }, 150);
  undoWin.focus();
}

// --- Global shortcuts: Alt+Shift+Z (undo) and Alt+Shift+B (brief) by default, changeable in Settings ----------
// Not Ctrl+Alt: Wispr Flow dictates while Ctrl + Alt is held (shortcuts.js). A taken default falls back to a free one.

const SHORTCUTS = {
  undo: { setting: 'undoShortcut', defaults: SHORTCUT_DEFAULTS.undo, open: () => openUndo(), what: 'one-key undo', instead: 'Undo Last in the tray menu' },
  brief: { setting: 'briefShortcut', defaults: SHORTCUT_DEFAULTS.brief, open: () => openBrief(), what: 'the brief helper', instead: 'Write a Brief in the tray menu' },
};
const registered = {}; // which -> accelerator Mewndo holds right now
let shortcutTest = null; // { accel, pressed } while Settings tests a shortcut
const shortcutFor = (which) => settings[SHORTCUTS[which].setting] ?? registered[which] ?? SHORTCUTS[which].defaults[0];

function tryRegister(accel, fn) {
  try { return globalShortcut.register(accel, fn); } catch { return false; }
}
function shortcutHandler(which, accel) {
  return () => (shortcutTest?.accel === accel ? shortcutTest.pressed() : SHORTCUTS[which].open());
}
function unregisterShortcuts() {
  for (const [which, accel] of Object.entries(registered)) { globalShortcut.unregister(accel); delete registered[which]; }
}

// (Re)register both. If another app already has one, say so in the main window and a notification.
function registerShortcuts({ quiet = false } = {}) {
  unregisterShortcuts();
  const problems = [];
  for (const [which, def] of Object.entries(SHORTCUTS)) {
    const chosen = settings[def.setting];
    // The user's own choice is kept even when taken; a default that's taken gives way to the next free one.
    const accel = pickShortcut(chosen ? [chosen] : def.defaults, (a) => tryRegister(a, shortcutHandler(which, a)));
    if (accel) registered[which] = accel;
    if (!accel) problems.push(`${prettyShortcut(chosen ?? def.defaults[0])} is already used by another app, so ${def.what} has no shortcut; use ${def.instead}.`);
    else if (!chosen && accel !== def.defaults[0]) problems.push(`${prettyShortcut(def.defaults[0])} is already used by another app, so ${def.what} uses ${prettyShortcut(accel)} instead.`);
  }
  shortcutProblem = problems.length ? `${problems.join(' ')} You can choose different shortcuts in Settings.` : null;
  if (shortcutProblem && !quiet) notify('Mewndo', shortcutProblem);
  send('state-changed');
}

// "Control+Alt+U" style, with Control, Alt or Super, and a letter, digit, F-key or Space.
const ACCEL = /^(?:(?:Control|Alt|Shift|Super)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space)$/;
function checkAccel(accel) {
  if (typeof accel !== 'string' || !ACCEL.test(accel) || !/Control|Alt|Super/.test(accel)) {
    throw new Error('Use Ctrl, Alt or the Windows key with a letter, number, F-key or Space.');
  }
}

// --- The brief helper (the brief shortcut) -----------------------------------------------------------------------

let briefWin = null;

// Every protected folder, most recent activity first.
async function briefFolders() {
  const folders = (await call('folders')).filter((f) => !['scanning', 'unavailable'].includes(f.status));
  return folders
    .sort((a, b) => (b.lastChangeAt ?? 0) - (a.lastChangeAt ?? 0))
    .map((f) => ({ root: f.root, name: folderName(f.root) }));
}

function createBriefWindow() {
  briefWin = new BrowserWindow({
    width: 560, height: 400, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, title: 'Mewndo: brief', icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'brief-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  briefWin.loadFile(path.join(__dirname, 'renderer', 'brief.html'));
  briefWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  briefWin.webContents.on('will-navigate', (e) => e.preventDefault());
  briefWin.on('close', (e) => { if (!quitting) { e.preventDefault(); briefWin.hide(); } });
}

let briefPrefill = null; // a task said to the bar's mic, put in the brief window for the user to check
function openBrief(task) {
  briefPrefill = typeof task === 'string' ? task : null;
  if (!briefWin || briefWin.isDestroyed()) createBriefWindow();
  else briefWin.webContents.send('brief:open');
  briefWin.center();
  briefWin.show();
  // Again once it is on screen: some Linux window managers ignore it until the window has appeared.
  briefWin.setAlwaysOnTop(true, 'floating');
  setTimeout(() => { if (!briefWin.isDestroyed() && briefWin.isVisible()) briefWin.setAlwaysOnTop(true, 'floating'); }, 150);
  briefWin.focus();
}

const safetyRules = () => (typeof settings.safetyRules === 'string' && settings.safetyRules.trim() ? settings.safetyRules : DEFAULT_SAFETY_RULES);

const briefHandlers = {
  briefFolders,
  // Save point first (trigger brief), then copy the brief and hide. If the save point fails, nothing is copied.
  async briefCreate(root, task) {
    if (typeof task !== 'string' || !task.trim() || task.length > 20_000) throw new Error('Type the task first.');
    if (!(await briefFolders()).some((f) => f.root === root)) throw new Error('That folder is not protected.');
    const sp = await call('journal.createSavePoint', root, { trigger: 'brief', label: briefLabel(task), quick: true });
    await call('saveBrief', root, task); // Guard judges the folder's agents by it
    clipboard.writeText(buildBrief(task, root, safetyRules()));
    briefWin?.hide();
    notify('Mewndo', 'Protected. Brief copied, paste it into your agent.');
    storage.at = 0;
    return { savePointId: sp.id };
  },
  briefHide() { briefWin?.hide(); },
  briefPrefill() { const t = briefPrefill; briefPrefill = null; return t; },
};

// --- Drift (Heal and Brake) --------------------------------------------------------------------------------------
// ponytail: a notification for now; the bar's drift card (P3.3) replaces it.
function onDrift(d) {
  const what = d.action === 'healed' ? `Put back: ${d.healed.join(', ')}.`
    : d.action === 'braked' ? `${d.agent} is braked${d.handoff ? '; the task is yours now' : ''}.` : "Mewndo couldn't put it back: no save point had it.";
  notify(`Mewndo: ${d.agent} went outside its brief`, `${d.reason}. ${what}`);
  send('state-changed');
}

// Resume: the Continue card is waiting in the agent's hook, AGENTS.md or rules file; some agents need it pasted.
function onResumed(r) {
  updateTray();
  if (!r.card) return;
  if (r.copy) clipboard.writeText(r.card);
  const how = r.command ? `Run ${r.command} to carry on.` : r.copy ? 'Paste it into the agent\'s chat.' : '';
  notify(`${r.agent} can carry on`, `Continue card ready (${r.inject}${r.copy ? ', copied' : ''}). ${how}`);
}

// --- Burst alerts -----------------------------------------------------------------------------------------------

const liveNotifications = new Set(); // Windows drops click handlers of notifications that get garbage-collected

const xml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Windows toast layout. Clicking the toast or "Put them back" both arrive as Electron's 'click' (Windows reports
// any activation that way); "Dismiss" is the system's own dismiss button and closes it without a click.
function urgentToast(title, body) {
  return `<toast scenario="urgent" activationType="foreground" launch="mewndo-burst">
  <visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual>
  <actions>
    <action content="Put them back" arguments="undo" activationType="foreground"/>
    <action content="Dismiss" arguments="dismiss" activationType="system"/>
  </actions>
</toast>`;
}

// "40 files deleted in Documents by Claude Code in the last minute. Put them back?" The agent's name: one that
// reported itself through its hook in the last 10 minutes, or else the likely one (the running agent that
// started most recently), labelled as likely.
async function burstAlert(root, { deleted, changed, agent: likely }) {
  const savePoints = await call('journal.listSavePoints', root).catch(() => []);
  const exact = savePoints.filter((sp) => sp.trigger === 'hook' && sp.agent && Date.now() - Date.parse(sp.createdAt) < 10 * 60 * 1000).at(-1)?.agent;
  const agent = exact ?? (likely ? `${likely} (likely)` : null);
  const other = changed - deleted;
  const s = (n) => (n === 1 ? '' : 's');
  const what = deleted && other ? `${deleted} file${s(deleted)} deleted and ${other} changed`
    : deleted ? `${deleted} file${s(deleted)} deleted` : `${other} file${s(other)} changed`;
  const body = `${what} in ${folderName(root)}${agent ? ` by ${agent}` : ''} in the last minute. Put them back?`;
  send('toast', body); // also in the window, for systems without notifications
  const title = 'Mewndo: lots of changes at once';
  // show() is a no-op where notifications aren't supported. On Windows the toast is marked urgent: it stays on
  // screen until handled and may show during Do Not Disturb, if Windows allows urgent notifications for Mewndo.
  const n = new Notification(process.platform === 'win32' ? { toastXml: urgentToast(title, body) } : { title, body });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('click', () => { done(); openUndo(root); });
  n.on('close', done);
  n.show();
}

const undoHandlers = {
  async undoFolders() {
    const folders = await undoFolders();
    const i = folders.findIndex((f) => undoPreferred && samePath(f.root, undoPreferred));
    if (i > 0) folders.unshift(...folders.splice(i, 1));
    else if (i < 0 && undoPreferred) folders.unshift({ root: undoPreferred, name: folderName(undoPreferred) });
    undoPreferred = null;
    return folders;
  },
  async undoTarget(root) {
    if (!(await undoFolders()).some((f) => f.root === root)) throw new Error('not a protected folder');
    return undoTarget(root);
  },
  // Only ever restores to the target this folder offers right now, the whole folder, in place.
  async undoRun(root, savePointId) {
    if (!(await undoFolders()).some((f) => f.root === root)) throw new Error('not a protected folder');
    const target = await undoTarget(root);
    if (target.savePoint?.id !== savePointId) throw new Error('Something changed meanwhile. Press the undo shortcut again to see the latest.');
    const r = await reportRestore(root, await call('journal.restore', root, savePointId));
    return { verified: r.verified, written: r.counts.written, trashed: r.counts.trashed, problems: r.failures.length + r.mismatches.length };
  },
  undoHide() { undoWin?.hide(); },
};

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
      // Let the engine and the core stop cleanly, but never hang quitting on them.
      await Promise.race([Promise.allSettled([call('stop'), core?.stop()]), new Promise((r) => setTimeout(r, 15_000))]);
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
  const braked = await call('braked').catch(() => []);
  tray.setContextMenu(Menu.buildFromTemplate([
    ...braked.map((b) => ({ label: `Resume ${b.agent}`, click: run(() => call('resumeAgent', b.agent)) })),
    ...(braked.length ? [{ type: 'separator' }] : []),
    { label: 'Open Window', click: showWindow },
    { label: 'Create Save Point', click: run(createSavePointEverywhere) },
    { label: 'Write a Brief', click: () => openBrief() },
    { label: 'Settings…', click: () => openSettings() },
    { label: "What Mewndo can and can't undo", click: () => openLimits() },
    { label: 'Undo Last', click: () => openUndo() },
    { label: until ? 'Resume Protection' : 'Pause Protection for 1 Hour', click: run(togglePause) },
    { label: 'Show Mewndo Bar', type: 'checkbox', checked: settings.barOff !== true, click: run(toggleBar) },
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
  // The Agents screen (design spec §8.3): the same list the dock's panel shows, and Brake / Resume per agent.
  async agentsView() {
    const [folders, braked] = await Promise.all([call('folders'), call('braked').catch(() => [])]);
    return (await panelData(folders, new Set((braked ?? []).map((x) => x.agent)))).agents;
  },
  async brakeAgent(name) {
    await call('brake', str(name, 'agent'), { reason: 'you braked it from the Agents screen' });
  },
  async resumeAgent(name) {
    await call('resumeAgent', str(name, 'agent'));
  },
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
    if (!settings.triedUndo) { settings.triedUndo = true; saveSettings().catch(() => {}); } // the checklist's "Try an undo"
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
  claudeHooksPlan: () => call('claudeHooksPlan'),
  // The brief's safety rules: the user's own, or the defaults. Saving empty text (or null) resets them.
  safetyRules: () => ({ rules: safetyRules(), defaults: DEFAULT_SAFETY_RULES, edited: safetyRules() !== DEFAULT_SAFETY_RULES }),
  async setSafetyRules(text) {
    if (text !== null && (typeof text !== 'string' || text.length > 10_000)) throw new Error('invalid rules');
    settings.safetyRules = text?.trim() ? text : undefined;
    await saveSettings();
    return { rules: safetyRules(), defaults: DEFAULT_SAFETY_RULES, edited: safetyRules() !== DEFAULT_SAFETY_RULES };
  },
  agentHooksPlan: (agent) => call('agentHooksPlan', String(agent)),
  agentHooksInstall: (agent) => call('agentHooksInstall', String(agent)),
  claudeHooksInstall: () => call('claudeHooksInstall'),
  openSettings: () => openSettings(),
  openLimits: () => openLimits(),
  dismissAlert(code, folder) { alerts.delete(alertKey(code, folder ?? undefined)); stateChanged(); },
  // A round trip to the engine process and back; the responsiveness check uses it.
  ping: () => call('ping'),
};

// --- "What Mewndo can and can't undo" ---------------------------------------------------------------------------

let limitsWin = null;
function openLimits() {
  if (limitsWin && !limitsWin.isDestroyed()) { limitsWin.show(); limitsWin.focus(); return; }
  limitsWin = new BrowserWindow({
    width: 720, height: 760, title: "What Mewndo can and can't undo", icon: icon(), show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  limitsWin.removeMenu();
  limitsWin.loadFile(path.join(__dirname, 'renderer', 'limits.html'));
  limitsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  limitsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  limitsWin.once('ready-to-show', () => limitsWin.show());
}

// --- Settings window --------------------------------------------------------------------------------------------

let settingsWin = null;

function openSettings() {
  if (!settingsWin || settingsWin.isDestroyed()) {
    settingsWin = new BrowserWindow({
      width: 860, height: 600, minWidth: 720, minHeight: 480, show: false, title: 'Mewndo settings', icon: icon(),
      titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(), // like the main window (design spec §9)
      webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    settingsWin.removeMenu();
    settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
    settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
    settingsWin.once('ready-to-show', () => settingsWin.show());
    settingsWin.on('closed', () => { settingsWin = null; if (!Object.keys(registered).length) registerShortcuts({ quiet: true }); });
  } else {
    settingsWin.show();
    settingsWin.focus();
  }
}

const BURST = { maxDeleted: 20, maxChanged: 50 };

async function allSettings() {
  const [config, folders, agents, report] = await Promise.all([
    call('config'), call('folderSettings'), call('agentList'), call('storageReport', { maxAgeMs: REPORT_MAX_AGE }).catch(() => null),
  ]);
  return {
    shortcuts: Object.fromEntries(Object.keys(SHORTCUTS).map((w) => [w, { accel: shortcutFor(w), fallback: SHORTCUTS[w].defaults[0], working: registered[w] === shortcutFor(w) }])),
    burst: config.burst, burstDefaults: BURST,
    budgetGB: Math.round((config.budgetBytes / GB) * 10) / 10,
    usage: report && { usedBytes: report.usedBytes, trashBytes: report.trashBytes, freeDiskBytes: report.freeDiskBytes },
    folders: folders.map((f) => ({ ...f, name: folderName(f.root) })),
    agents,
    safetyRules: safetyRules(), safetyRulesDefault: DEFAULT_SAFETY_RULES,
    openAtLogin: settings.openAtLogin, loginSupported: process.platform !== 'linux',
    engine: engineChoice(),
    guardFailOpen: config.guardFailOpen === true,
    dataDir: dataDir(),
  };
}

const settingsHandlers = {
  getSettings: allSettings,
  version: () => app.getVersion(),

  // Typing a new shortcut shouldn't fire the old ones; they come back when capture ends (or Settings closes).
  suspendShortcuts() { unregisterShortcuts(); },
  resumeShortcuts() { if (!Object.keys(registered).length) registerShortcuts({ quiet: true }); },

  // Check for conflicts: the other Mewndo shortcut, then whether Windows lets Mewndo have it.
  async setShortcut(which, accel) {
    if (!SHORTCUTS[which]) throw new Error('unknown shortcut');
    checkAccel(accel);
    const other = Object.keys(SHORTCUTS).find((w) => w !== which && shortcutFor(w) === accel);
    if (other) throw new Error(`${prettyShortcut(accel)} is already Mewndo's shortcut for ${SHORTCUTS[other].what}.`);
    unregisterShortcuts();
    const free = tryRegister(accel, () => {});
    if (free) globalShortcut.unregister(accel); // only release what this check registered
    if (!free) {
      registerShortcuts({ quiet: true });
      throw new Error(`${prettyShortcut(accel)} is already used by another app. Choose another.`);
    }
    if (accel === SHORTCUTS[which].defaults[0]) delete settings[SHORTCUTS[which].setting];
    else settings[SHORTCUTS[which].setting] = accel;
    await saveSettings();
    registerShortcuts({ quiet: true });
    return allSettings();
  },

  // Registered isn't proof: another program can still intercept the keys first. Wait up to 10 s for a press.
  async testShortcut(accel) {
    checkAccel(accel);
    const ours = Object.values(registered).includes(accel);
    if (!ours && !tryRegister(accel, () => shortcutTest?.pressed())) return { ok: false, reason: 'taken' };
    const pressed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      shortcutTest = { accel, pressed: () => { clearTimeout(timer); resolve(true); } };
    });
    shortcutTest = null;
    if (!ours) globalShortcut.unregister(accel);
    if (pressed && !settings.shortcutsTested) { settings.shortcutsTested = true; saveSettings().catch(() => {}); stateChanged(); }
    return { ok: pressed, reason: pressed ? null : 'not-delivered' };
  },

  async setGuardFailOpen(on) {
    await call('configure', { guardFailOpen: on === true });
    settings.guardFailOpen = on === true;
    await saveSettings();
    return allSettings();
  },

  async setBurst(burst) {
    const result = await call('configure', { burst });
    settings.burst = result.burst;
    await saveSettings();
    return allSettings();
  },

  async setBudget(gb) {
    if (!Number.isFinite(gb)) throw new Error('Enter the budget in GB.');
    await call('configure', { budgetBytes: gb * GB });
    settings.budgetGB = gb;
    await saveSettings();
    storage.at = 0;
    return allSettings();
  },

  async setFolder(root, folder) {
    await call('setFolderSettings', root, folder);
    storage.at = 0;
    return allSettings();
  },

  async setAgents(list) {
    await call('setAgentList', list);
    return allSettings();
  },

  async setRules(text) {
    if (typeof text !== 'string' || text.length > 10_000) throw new Error('invalid rules');
    settings.safetyRules = text.trim() ? text : undefined;
    await saveSettings();
    return allSettings();
  },

  async setOpenAtLogin(on) {
    settings.openAtLogin = on === true;
    await saveSettings();
    applyOpenAtLogin();
    send('state-changed');
    return allSettings();
  },

  // A new engine choice restarts the engine process, which protects every folder again with it.
  async setEngine(choice) {
    if (!ENGINES.includes(choice)) throw new Error('unknown engine');
    settings.engine = choice;
    await saveSettings();
    log.info(`Restore engine set to ${choice}; restarting the engine`);
    restartingEngine = true;
    await call('stop').catch(() => {}); // cleanly: a running restore finishes its step and resumes after
    engine?.kill();
    return allSettings();
  },

  async openLog() {
    await log.flush();
    const err = await shell.openPath(log.file);
    if (err) throw new Error(err);
  },
  openLimits: () => openLimits(),

  async openDataFolder() {
    const err = await shell.openPath(dataDir());
    if (err) throw new Error(err);
  },

  // Everything back to how Mewndo comes: shortcuts, alerts, budget, agents, every folder's settings, safety rules,
  // start at login. Protected folders and their history stay.
  async resetAll() {
    for (const key of ['undoShortcut', 'briefShortcut', 'safetyRules', 'burst', 'budgetGB']) delete settings[key];
    settings.openAtLogin = true;
    await saveSettings();
    applyOpenAtLogin();
    registerShortcuts({ quiet: true });
    await call('configure', { burst: BURST, budgetBytes: 10 * GB });
    await call('setAgentList', null);
    for (const f of await call('folderSettings')) {
      await call('setFolderSettings', f.root, { retentionDays: 30, extraIgnore: [], maxFileSizeMB: 50 });
    }
    storage.at = 0;
    send('state-changed');
    return allSettings();
  },
};

// --- Startup ---------------------------------------------------------------------------------------------------

if (process.argv.includes('--remove-claude-hooks')) {
  // Run by the uninstaller: take Mewndo's hooks out of Claude Code's settings, then exit. No window, no engine.
  require('../engine/claude-hooks').removeClaudeHooks().catch(() => {}).finally(() => app.exit(0));
} else if (!app.requestSingleInstanceLock()) {
  app.quit(); // another copy is running; it shows its window
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', (e) => { if (!stopped) { e.preventDefault(); quit(); } });

  // Never crash on an unexpected error in this process: log it and carry on. The engine runs separately, so
  // protection continues regardless.
  process.on('uncaughtException', (e) => log.error('Unexpected error in the main process', e?.stack ?? String(e)));
  process.on('unhandledRejection', (e) => log.error('Unhandled promise rejection in the main process', e?.stack ?? String(e)));

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // needed for notifications
    log = createLog(path.join(dataDir(), 'logs'));
    log.info(`Mewndo ${app.getVersion()} starting`, { platform: process.platform, electron: process.versions.electron });
    app.on('will-quit', () => log.info('Mewndo quitting'));
    await loadSettings();
    if (settings.setupDone) applyOpenAtLogin(); // keeps the sign-in entry pointing at this copy of Mewndo
    startCore(); // first: the engine connects to it
    startEngine(); // re-protects saved folders and prunes, all inside the engine process

    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.handle(name, (event, ...args) => {
        if (event.sender !== win?.webContents) throw new Error('unknown sender');
        return fn(...args);
      });
    }
    for (const [name, fn] of Object.entries(briefHandlers)) {
      ipcMain.handle(name, (event, ...args) => {
        if (event.sender !== briefWin?.webContents) throw new Error('unknown sender');
        return fn(...args);
      });
    }
    for (const [name, fn] of Object.entries(undoHandlers)) {
      ipcMain.handle(name, (event, ...args) => {
        if (event.sender !== undoWin?.webContents) throw new Error('unknown sender');
        return fn(...args);
      });
    }
    registerShortcuts();
    startDesk();
    for (const [name, fn] of Object.entries(settingsHandlers)) {
      ipcMain.handle(`settings:${name}`, (event, ...args) => { // own prefix: names can't clash with the main window's
        if (event.sender !== settingsWin?.webContents) throw new Error('unknown sender');
        return fn(...args);
      });
    }
    app.on('will-quit', () => globalShortcut.unregisterAll());

    tray = new Tray(icon().resize({ width: 16, height: 16 }));
    tray.on('click', showWindow);
    updateTray();
    startBar();

    createWindow(!(process.argv.includes('--hidden') && settings.setupDone));
  }).catch((e) => {
    log.error('Mewndo could not start', e?.stack ?? String(e));
    dialog.showErrorBox('Mewndo could not start', String(e?.stack ?? e));
    app.exit(1);
  });
}
