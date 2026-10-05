// Mewndo: the top level. Owns the shared content store and one journal per protected folder, remembers which
// folders are protected, and keeps storage in check: retention pruning, a storage budget, free disk space.
// Events: 'pruned' prune result · 'folders-changed' · 'warning' { code: 'over-budget' | 'low-disk' |
//   'folder-unavailable' | 'journal' | 'prune-failed', message, ... } · and from each journal, as (root, payload):
//   'progress', 'savepoint', 'restored', 'retry', 'change', 'burst' (not while protection is paused) ·
//   'agents-changed' [{ name, since }] when AI agents start or stop.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore, writeFileAtomic, isInside } = require('./store');
const { createJournal, folderId } = require('./journal');
const { folderSize, DEFAULT_IGNORE } = require('./scanner');
const { createAgentWatcher, loadAgents, saveAgents, DEFAULT_AGENTS } = require('./agents');
const { BURST_DEFAULTS } = require('./burst');
const { startHookServer } = require('./hook-server');

const FORWARDED = ['progress', 'savepoint', 'restored', 'retry', 'change'];

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DEFAULT_MAX_FILE_MB = 50;

const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const hashesOf = (index) => Object.values(index ?? {}).map((e) => e.hash).filter(Boolean);
const byAge = (a, b) => a.createdAt.localeCompare(b.createdAt);

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Protected from pruning, even over budget: a folder's newest save point, anything from the last 24 hours,
// and manual, brief and before-undo save points within the folder's retention period. So the budget can
// only ever remove activity, agent and hook save points.
const PROTECTED_TRIGGERS = new Set(['manual', 'brief', 'before-undo']);
function isKept(sp, folder, now) {
  const age = now - Date.parse(sp.createdAt);
  return sp === folder.savePoints.at(-1) || age < DAY
    || (PROTECTED_TRIGGERS.has(sp.trigger) && age <= folder.retentionDays * DAY);
}

// Delete a folder tree in Mewndo's own data without ever entering a link or junction: links are unlinked.
async function removeTree(p) {
  const st = await fsp.lstat(p).catch(() => null);
  if (!st) return;
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(p)) await removeTree(path.join(p, name));
    await fsp.rmdir(p);
  } else {
    await fsp.unlink(p);
  }
}

// Bytes and file count under p, without following links.
async function treeSize(p) {
  let bytes = 0;
  let items = 0;
  for (const e of await fsp.readdir(p, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) continue;
    bytes += (await fsp.lstat(path.join(e.parentPath, e.name))).size;
    items++;
  }
  return { bytes, items };
}

// When a trash batch was made: Restored/<ISO time with ':' as '-'>_<id>. Null if the name doesn't say.
function trashedAt(name) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d\.\d{3}Z)_/.exec(name);
  return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}`) : null;
}

function createMewndo({
  dataDir,
  budgetBytes = 10 * GB,
  burst = {}, // { maxDeleted, maxChanged }: burst alert thresholds (see burst.js); changeable with configure()
  lowDiskBytes = 2 * GB,
  pruneEveryMs = DAY,
  availabilityCheckMs = 5000, // how often to look for protected folders that disappeared or came back
  diskCheckMs = 10 * 60 * 1000, // how often to check free disk space
  maxFolderBytes = 20 * GB, // larger folders are refused
  now = Date.now,
  journalOptions = {}, // passed to every journal (timings in tests)
  agents = null, // { intervalMs, saveEveryMs, listProcesses } turns on AI agent awareness (off in tests by default)
  hookServer = null, // { port } turns on the exact-save-point server for agent hooks (off in tests by default)
}) {
  const mewndo = new EventEmitter();
  const store = createStore(path.join(dataDir, 'store'));
  const foldersDir = path.join(dataDir, 'folders');
  const journals = new Map(); // real root -> journal
  const starting = new Set(); // roots whose first or catch-up scan is running
  let timer = null;
  let pruning = null;
  let pausedUntil = null;
  let resumeTimer = null;
  const ready = new Map(); // root -> resolves when its first or catch-up scan is over
  // Shared by every journal and read on every check, so configure() changes alerts at once.
  const burstLimits = { ...BURST_DEFAULTS, ...journalOptions.burst, ...burst };
  const runningAgents = new Map(); // agent name -> since (ms)
  let agentWatcher = null;
  let agentTimer = null;
  let hookServerHandle = null;
  let hookServerProblem = null;
  const unavailable = new Map(); // root -> since when it couldn't be found (e.g. an unplugged drive)
  const watcherTrouble = new Set(); // roots whose watcher failed and is restarting
  let availabilityTimer = null;
  let diskTimer = null;
  let checkingAvailability = false;
  let lowDisk = false;
  // A problem that went away: { code, folder?, message }. The app clears the matching warning.
  const resolved = (code, message, extra = {}) => mewndo.emit('resolved', { code, message, ...extra });
  const nameOf = (root) => path.basename(root) || root;
  const unavailableMessage = (root) => `${nameOf(root)} can't be found at ${root}. If its drive is unplugged, Mewndo `
    + "resumes protecting it as soon as it's back. Its save points are kept.";

  // The agent most likely making changes: the most recently started one still running. A guess, shown as such.
  const likelyAgent = () => [...runningAgents].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const warn = (code, message, extra = {}) => mewndo.emit('warning', { code, message, ...extra });
  const settingsFile = (dir) => path.join(dir, 'settings.json');
  let reportCache = null; // see storageReport
  const changed = () => { reportCache = null; mewndo.emit('folders-changed'); };

  async function realData() {
    await fsp.mkdir(dataDir, { recursive: true });
    return fsp.realpath(dataDir);
  }

  async function find(root) {
    const real = await fsp.realpath(root).catch(() => path.resolve(root));
    const key = [...journals.keys()].find((r) => samePath(r, real));
    return key && { root: key, journal: journals.get(key) };
  }

  // The journal for a protected folder; throws for anything else (callers pass roots from the UI).
  mewndo.journalFor = (root) => {
    const key = [...journals.keys()].find((r) => samePath(r, root));
    if (!key) throw new Error(`not a protected folder: ${root}`);
    return journals.get(key);
  };

  // Why a folder can't be protected, as a thrown Error with a plain message.
  // resuming: a folder protected before may have grown past the size limit; keep protecting it.
  mewndo.checkFolder = async (root, { resuming = false } = {}) => {
    const real = await fsp.realpath(root);
    if (!(await fsp.stat(real)).isDirectory()) throw new Error('This is not a folder.');
    const data = await realData();
    if (samePath(real, data) || isInside(data, real)) {
      throw new Error("This folder contains Mewndo's own data folder, so it can't be protected.");
    }
    if (isInside(real, data)) throw new Error("This folder is inside Mewndo's own data folder.");
    for (const other of journals.keys()) {
      if (samePath(other, real)) throw new Error('This folder is already protected.');
      if (isInside(real, other) || isInside(other, real)) throw new Error(`This folder overlaps ${other}, which is already protected.`);
    }
    if (resuming) return real;
    const size = await folderSize(real, {
      ignore: journalOptions.ignore ?? DEFAULT_IGNORE,
      stopAboveBytes: maxFolderBytes,
      onProgress: (p) => mewndo.emit('progress', real, { phase: 'checking', ...p }),
    });
    if (size.over) throw new Error(`This folder is larger than ${gb(maxFolderBytes)}. Choose a smaller folder, like one project.`);
    return real;
  };

  // Start protecting a folder (or resume protecting it). Returns its journal once the first scan is done,
  // or, with background: true, as soon as the folder is accepted (the scan's errors become warnings).
  mewndo.protect = async (root, { retentionDays = 30, background = false, resuming = false } = {}) => {
    const real = await mewndo.checkFolder(root, { resuming });
    // Remember it before the first scan, so a restart mid-scan still protects it.
    const dir = path.join(await realData(), 'folders', folderId(real));
    const saved = (await readJson(settingsFile(dir))) ?? {}; // keeps this folder's own settings
    const folder = { ...saved, root: real, retentionDays: saved.retentionDays ?? retentionDays, protected: true };
    await writeFileAtomic(settingsFile(dir), JSON.stringify(folder));
    const journal = makeJournal(real, folder);
    starting.add(real);
    changed();
    const started = journal.start().then(() => journal, async (e) => {
      journals.delete(real);
      await writeFileAtomic(settingsFile(dir), JSON.stringify({ ...folder, protected: false }));
      throw e;
    }).finally(() => { starting.delete(real); changed(); });
    ready.set(real, started.then(() => {}, () => {}));
    if (!background) return started;
    started.catch((e) => warn('folder-unavailable', `Can't protect ${real}: ${e.message}`, { root: real }));
    return journal;
  };

  // A journal for a protected folder, with its events passed on. Registered, not started.
  function makeJournal(real, folder) {
    const journal = createJournal({
      ...journalOptions, root: real, dataDir, store, likelyAgent, burst: burstLimits,
      ...folderScanOptions(folder),
    });
    for (const ev of FORWARDED) journal.on(ev, (payload) => mewndo.emit(ev, real, payload));
    journal.on('burst', (payload) => { if (!pausedUntil) mewndo.emit('burst', real, payload); }); // not while paused
    journal.on('warning', (e) => warn('journal', e.message, { folder: real }));
    journal.on('watcher-error', (e) => {
      watcherTrouble.add(real);
      warn('watcher', `Mewndo stopped seeing changes in ${nameOf(real)} (${e.code ?? e.message}). It is restarting the watcher `
        + 'and will catch up on anything it missed.', { folder: real });
    });
    journal.on('gone', () => checkAvailability().catch(() => {})); // mark it unavailable now, not at the next check
    journal.on('watcher-restarted', () => {
      if (watcherTrouble.delete(real)) resolved('watcher', `Mewndo is watching ${nameOf(real)} again.`, { folder: real });
    });
    journals.set(real, journal);
    return journal;
  }

  // A remembered folder that can't be found at launch: listed as unavailable (its save points still work, e.g.
  // to restore into a separate folder) until it's back.
  async function registerOffline(folder) {
    if (journals.has(folder.root)) return;
    const journal = makeJournal(folder.root, folder);
    await journal.attachOffline().catch(() => {});
    ready.set(folder.root, Promise.resolve());
    unavailable.set(folder.root, now());
    warn('folder-unavailable', unavailableMessage(folder.root), { folder: folder.root });
    changed();
  }

  // Folders that disappeared (stop watching) or came back (start again, catching up on what changed meanwhile).
  async function checkAvailability() {
    if (checkingAvailability) return;
    checkingAvailability = true;
    try {
      for (const [root, j] of journals) {
        if (starting.has(root) || j.isRestoring()) continue;
        const here = await fsp.stat(root).then((st) => st.isDirectory(), () => false);
        if (!here && !unavailable.has(root)) {
          unavailable.set(root, now());
          await j.stop();
          watcherTrouble.delete(root);
          warn('folder-unavailable', unavailableMessage(root), { folder: root });
          changed();
        } else if (here && unavailable.has(root)) {
          unavailable.delete(root);
          if (pausedUntil) { changed(); continue; } // resuming protection starts it
          starting.add(root);
          changed();
          try {
            await j.start();
            resolved('folder-unavailable', `${nameOf(root)} is back. Mewndo is protecting it again.`, { folder: root });
          } catch {
            unavailable.set(root, now()); // still not usable; try again next time
          } finally {
            starting.delete(root);
            changed();
          }
        }
      }
    } finally {
      checkingAvailability = false;
    }
  }

  // Low disk space: warn once, and say when it's resolved.
  async function checkDisk() {
    const free = await freeDiskBytes().catch(() => null);
    if (free === null) return;
    if (free < lowDiskBytes && !lowDisk) {
      lowDisk = true;
      warn('low-disk', `Only ${gb(free)} free on the disk Mewndo uses. Free up space so Mewndo can keep saving versions.`, { freeBytes: free });
    } else if (free >= lowDiskBytes && lowDisk) {
      lowDisk = false;
      resolved('low-disk', 'There is enough free disk space again.');
    }
  }

  // Stop protecting a folder. keepHistory: save points stay and can still be restored or protected again.
  // Otherwise its index, save points and restore logs are deleted. Its trash is kept either way: it holds
  // user files that restores moved aside, and Mewndo never permanently deletes user files.
  mewndo.unprotect = async (root, { keepHistory = true } = {}) => {
    const found = await find(root);
    if (!found) throw new Error(`not protected: ${root}`);
    const { journal } = found;
    if (journal.isRestoring()) throw new Error('a restore is running for this folder');
    await journal.stop(); // also cancels a first scan that is still running
    journals.delete(found.root);
    changed();
    const dir = path.join(await realData(), 'folders', folderId(found.root));
    if (keepHistory) {
      const settings = await readJson(settingsFile(dir));
      await writeFileAtomic(settingsFile(dir), JSON.stringify({ ...settings, protected: false }));
      return;
    }
    for (const name of await fsp.readdir(dir)) {
      if (name !== 'trash') await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
    await mewndo.prune(); // drop content only that folder referred to
  };

  mewndo.journals = () => [...journals.values()];

  // --- Settings ---------------------------------------------------------------------------------------------------

  // A folder's own scan settings (from its settings.json), as journal options.
  function folderScanOptions(folder) {
    const opts = { ignorePatterns: Array.isArray(folder.extraIgnore) ? folder.extraIgnore : [] };
    if (Number.isFinite(folder.maxFileSizeMB) && journalOptions.maxFileSize === undefined) opts.maxFileSize = folder.maxFileSizeMB * MB;
    return opts;
  }

  // Burst thresholds and the storage budget, applied at once (the budget at the next cleanup).
  mewndo.configure = ({ burst: b, budgetBytes: budget } = {}) => {
    if (b) {
      for (const k of ['maxDeleted', 'maxChanged']) {
        if (b[k] === undefined) continue;
        if (!Number.isInteger(b[k]) || b[k] < 1 || b[k] > 1_000_000) throw new Error(`${k} must be a whole number from 1 to 1,000,000`);
        burstLimits[k] = b[k];
      }
    }
    if (budget !== undefined) {
      if (!Number.isFinite(budget) || budget < 100 * MB) throw new Error('The storage budget must be at least 0.1 GB');
      budgetBytes = budget;
    }
    return mewndo.config();
  };
  mewndo.config = () => ({ burst: { maxDeleted: burstLimits.maxDeleted, maxChanged: burstLimits.maxChanged }, budgetBytes });

  // Per-folder settings of every protected folder: [{ root, retentionDays, extraIgnore, maxFileSizeMB }].
  mewndo.folderSettings = async () => {
    const out = [];
    for (const root of journals.keys()) {
      const s = (await readJson(settingsFile(path.join(await realData(), 'folders', folderId(root))))) ?? {};
      out.push({ root, retentionDays: s.retentionDays ?? 30, extraIgnore: s.extraIgnore ?? [], maxFileSizeMB: s.maxFileSizeMB ?? DEFAULT_MAX_FILE_MB });
    }
    return out;
  };

  // Change a folder's settings. Ignore patterns and the size limit apply at once: the folder's journal restarts
  // and rescans. Retention applies at the next cleanup.
  mewndo.setFolderSettings = async (root, { retentionDays, extraIgnore, maxFileSizeMB }) => {
    const key = [...journals.keys()].find((r) => samePath(r, root));
    if (!key) throw new Error(`not a protected folder: ${root}`);
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Retention must be 1 to 3,650 days');
    if (!Number.isFinite(maxFileSizeMB) || maxFileSizeMB < 1 || maxFileSizeMB > 10_240) throw new Error('The file size limit must be 1 to 10,240 MB');
    if (!Array.isArray(extraIgnore) || extraIgnore.length > 200
      || !extraIgnore.every((p) => typeof p === 'string' && p.trim() && p.length <= 200 && !/[\\/]/.test(p))) {
      throw new Error('Ignore patterns are file or folder names (no slashes), with * for any characters');
    }
    const patterns = [...new Set(extraIgnore.map((p) => p.trim()))];
    const file = settingsFile(path.join(await realData(), 'folders', folderId(key)));
    const saved = (await readJson(file)) ?? {};
    await writeFileAtomic(file, JSON.stringify({ ...saved, root: key, retentionDays, extraIgnore: patterns, maxFileSizeMB }));
    await journals.get(key).reconfigure({ ignorePatterns: patterns, maxFileSize: maxFileSizeMB * MB });
    return { root: key, retentionDays, extraIgnore: patterns, maxFileSizeMB };
  };

  // The AI agent list (agents.json). null resets it to the defaults. Agent checks re-read it within seconds.
  const agentsFile = () => path.join(dataDir, 'agents.json');
  mewndo.agentList = () => loadAgents(agentsFile());
  mewndo.setAgentList = (list) => saveAgents(agentsFile(), list ?? DEFAULT_AGENTS);

  // Protected folders for display: [{ root, status: scanning|restoring|paused|protected, files, lastChangeAt }].
  mewndo.folders = () => [...journals].map(([root, j]) => ({
    root,
    status: unavailable.has(root) ? 'unavailable' : starting.has(root) ? 'scanning' : j.isRestoring() ? 'restoring'
      : pausedUntil ? 'paused' : 'protected',
    files: Object.values(j.getIndex() ?? {}).filter((e) => e.type === 'file').length,
    lastChangeAt: j.lastChangeAt(),
  }));

  // Stop watching every folder for ms, then catch up on what changed. Save points and restores still work.
  mewndo.pauseProtection = async (ms) => {
    clearTimeout(resumeTimer);
    pausedUntil = now() + ms;
    for (const [root, j] of journals) if (!starting.has(root)) await j.stop();
    resumeTimer = setTimeout(() => mewndo.resumeProtection().catch((e) => warn('journal', e.message)), ms);
    resumeTimer.unref();
    changed();
  };

  mewndo.resumeProtection = async () => {
    if (!pausedUntil) return;
    clearTimeout(resumeTimer);
    pausedUntil = null;
    changed();
    for (const [root, j] of journals) {
      starting.add(root);
      changed();
      if (unavailable.has(root)) continue; // started when it's back
      try { await j.start(); } catch (e) { warn('folder-unavailable', `Can't protect ${root}: ${e.message}`, { root }); }
      finally { starting.delete(root); changed(); }
    }
  };

  mewndo.pausedUntil = () => pausedUntil;
  mewndo.checkAvailability = () => checkAvailability(); // runs every availabilityCheckMs after start()

  // Everything every folder still refers to, including folders that are no longer protected: refs counts how many
  // indexes and save points use each hash, and each folder's `uses` holds every hash it uses. Save points are read
  // one at a time and only counted, so memory doesn't grow with how many there are; sp.hashes() reads one again.
  async function measure() {
    const sizes = await store.objects();
    const refs = new Map();
    const folders = [];
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const dir = path.join(foldersDir, id);
      const settings = await readJson(settingsFile(dir));
      const index = await readJson(path.join(dir, 'index.json'));
      const pinned = new Set(hashesOf(index?.index));
      let jsonBytes = (await fsp.lstat(path.join(dir, 'index.json')).catch(() => null))?.size ?? 0;
      const restoresDir = path.join(dir, 'restores');
      for (const name of await fsp.readdir(restoresDir).catch(() => [])) {
        const log = await readJson(path.join(restoresDir, name));
        if (log?.status === 'running') for (const st of log.steps) if (st.hash) pinned.add(st.hash);
      }
      const uses = new Set(pinned);
      for (const h of pinned) refs.set(h, (refs.get(h) ?? 0) + 1);
      const savePoints = [];
      const spDir = path.join(dir, 'savepoints');
      for (const name of (await fsp.readdir(spDir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
        const file = path.join(spDir, name);
        const sp = await readJson(file); // a damaged file throws: never prune without knowing every reference
        const bytes = (await fsp.lstat(file)).size;
        jsonBytes += bytes;
        for (const h of new Set(hashesOf(sp.index))) {
          refs.set(h, (refs.get(h) ?? 0) + 1);
          uses.add(h);
        }
        savePoints.push({
          id: sp.id, createdAt: sp.createdAt, trigger: sp.trigger, label: sp.label, file, bytes,
          hashes: async () => new Set(hashesOf((await readJson(file)).index)),
        });
      }
      savePoints.sort(byAge);
      folders.push({ root: settings?.root ?? index?.root, retentionDays: settings?.retentionDays ?? 30, jsonBytes, savePoints, uses });
    }
    let used = folders.reduce((n, f) => n + f.jsonBytes, 0);
    for (const h of refs.keys()) used += sizes.get(h) ?? 0;
    return { folders, sizes, refs, used };
  }

  async function freeDiskBytes() {
    const disk = await fsp.statfs(dataDir);
    return disk.bavail * disk.bsize;
  }

  async function pruneNow(t, paused) {
    const { folders, sizes, refs, used: usedBefore } = await measure();
    let used = usedBefore;
    const pruned = [];
    const drop = async (c) => {
      used -= c.sp.bytes;
      for (const h of await c.sp.hashes()) {
        const n = refs.get(h) - 1;
        if (n > 0) refs.set(h, n);
        else { refs.delete(h); used -= sizes.get(h) ?? 0; }
      }
      pruned.push(c);
    };
    const candidates = folders
      .flatMap((f) => f.savePoints.filter((sp) => !isKept(sp, f, t)).map((sp) => ({ f, sp })))
      .sort((a, b) => byAge(a.sp, b.sp));
    // Retention: everything unprotected past its folder's retention period.
    for (const c of candidates) if (t - Date.parse(c.sp.createdAt) > c.f.retentionDays * DAY) await drop(c);
    // Budget: what's left unprotected is activity, agent and hook save points within retention. Oldest first.
    for (const c of candidates) {
      if (used <= budgetBytes) break;
      if (!pruned.includes(c)) await drop(c);
    }

    for (const c of pruned) await fsp.rm(c.sp.file, { force: true });

    // Sweep content nothing refers to. New puts are held meanwhile, so nothing can start referring to content
    // as it is deleted. A folder protected after this prune began wasn't paused: its scan may already refer to
    // content that isn't in any index yet, so then the sweep waits for the next prune.
    let removedObjects = 0;
    let sweepSkipped = null;
    const release = await store.holdPuts();
    try {
      if (mewndo.journals().some((j) => !paused.includes(j))) sweepSkipped = 'a folder was added while pruning';
      else if (paused.some((j) => j.isRestoring())) sweepSkipped = 'a restore is running';
      else {
        for (const h of sizes.keys()) {
          if (!refs.has(h)) { await store.remove(h); removedObjects++; }
        }
      }
    } finally {
      release();
    }

    reportCache = null;
    const result = {
      pruned: pruned.map(({ f, sp }) => ({ folder: f.root, id: sp.id, createdAt: sp.createdAt, trigger: sp.trigger, label: sp.label })),
      removedObjects, sweepSkipped, usedBytes: used, budgetBytes, overBudget: used > budgetBytes,
    };
    if (result.overBudget) {
      warn('over-budget', `Mewndo is using ${gb(used)} of its ${gb(budgetBytes)} budget. The budget can't be met `
        + 'without removing protected save points (manual, brief, before-undo, or recent ones), so they were kept.',
      { usedBytes: used, budgetBytes });
    }
    await checkDisk();
    mewndo.emit('pruned', result);
    return result;
  }

  // Prune save points (retention, then budget) and delete content nothing refers to anymore.
  // Journals are paused so nothing changes underneath; skipped while a restore runs.
  // ponytail: a separate-folder restore that starts mid-prune isn't paused; it reports failures if its save
  // point was just pruned (the sweep itself is skipped while any restore runs).
  async function runPrune() {
    const active = mewndo.journals();
    if (active.some((j) => j.isRestoring())) return { skipped: 'a restore is running' };
    const resumes = [];
    try {
      for (const j of active) resumes.push(await j.pause());
      if (active.some((j) => j.isRestoring())) return { skipped: 'a restore is running' };
      return await pruneNow(now(), active);
    } finally {
      for (const resume of resumes) resume();
    }
  }
  mewndo.prune = () => (pruning ??= runPrune().finally(() => { pruning = null; }));

  // Trash per folder (protected or not): [{ folder, trashFolder, bytes, items }]. Never counted in the budget.
  mewndo.trashReport = async () => {
    const report = [];
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const dir = path.join(foldersDir, id);
      const trashFolder = path.join(dir, 'trash');
      const settings = await readJson(settingsFile(dir));
      const root = settings?.root ?? (await readJson(path.join(dir, 'index.json')))?.root ?? null;
      report.push({ folder: root, trashFolder, ...(await treeSize(trashFolder)) });
    }
    return report;
  };

  // Permanently delete trash batches older than `olderThanDays`, optionally for one folder only.
  // Never runs on its own: only when the app calls it, e.g. after the user agrees.
  mewndo.emptyTrash = async ({ olderThanDays, folder } = {}) => {
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new Error('olderThanDays must be a number >= 0');
    const cutoff = now() - olderThanDays * DAY;
    const realFolder = folder && (await fsp.realpath(folder).catch(() => path.resolve(folder)));
    const removed = [];
    let removedBytes = 0;
    for (const entry of await mewndo.trashReport()) {
      if (realFolder && !(entry.folder && samePath(entry.folder, realFolder))) continue;
      const restored = path.join(entry.trashFolder, 'Restored');
      for (const name of await fsp.readdir(restored).catch(() => [])) {
        const at = trashedAt(name);
        if (at === null || at > cutoff) continue; // unknown or too recent: keep
        const batch = path.join(restored, name);
        const { bytes } = await treeSize(batch);
        await removeTree(batch);
        removed.push(batch);
        removedBytes += bytes;
      }
    }
    return { removed, removedBytes };
  };

  // Storage at a glance. The budget covers save point history; the trash is reported separately.
  // Per folder, `bytes` counts all content its history and index use, even if another folder shares it.
  // maxAgeMs: a report up to this old may be reused. Measuring reads every save point, which for big folders with
  // long histories takes seconds; the app asks with a few minutes, cleanups and changes to folders start afresh.
  mewndo.storageReport = async ({ maxAgeMs = 0 } = {}) => {
    if (reportCache && now() - reportCache.at <= maxAgeMs) {
      const { report } = reportCache; // with the budget as it is now (it can change in settings)
      return { ...report, budgetBytes, overBudget: report.usedBytes > budgetBytes };
    }
    const { used, folders: all, sizes } = await measure();
    const trash = await mewndo.trashReport();
    const folders = all.filter((f) => f.root).map((f) => {
      let bytes = f.jsonBytes;
      for (const h of f.uses) bytes += sizes.get(h) ?? 0;
      return { folder: f.root, bytes, savePoints: f.savePoints.length };
    });
    const report = {
      usedBytes: used, budgetBytes, overBudget: used > budgetBytes, folders,
      trashBytes: trash.reduce((n, t) => n + t.bytes, 0), trash,
      freeDiskBytes: await freeDiskBytes(),
    };
    reportCache = { at: now(), report };
    return report;
  };

  // --- AI agents ------------------------------------------------------------------------------------------------

  mewndo.agents = () => [...runningAgents].map(([name, since]) => ({ name, since })).sort((a, b) => a.since - b.since);

  // A save point in every protected folder; folders still in their first scan get it as soon as that's over.
  function savePointEverywhere(options) {
    for (const [root, j] of journals) {
      (ready.get(root) ?? Promise.resolve())
        .then(() => (journals.get(root) === j ? j.createSavePoint(options) : null))
        .catch((e) => warn('journal', e.message, { folder: root }));
    }
  }

  // An agent started: save every protected folder, so whatever it does next can be undone.
  function onAgents({ started, stopped }) {
    for (const name of stopped) runningAgents.delete(name);
    for (const name of started) {
      runningAgents.set(name, now());
      savePointEverywhere({ trigger: 'agent', agent: name, label: `${name} started`, quick: true });
    }
    mewndo.emit('agents-changed', mewndo.agents());
  }

  // While agents run: every saveEveryMs, a save point in each folder that changed since its newest one.
  function agentTick() {
    const agent = likelyAgent();
    if (agent) savePointEverywhere({ trigger: 'agent', agent, agentLikely: true, label: `While ${agent} was running`, onlyIfChanged: true, quick: true });
  }

  // An agent's hook asked for a save point (hook-server.js), in the protected folder the agent works in.
  async function hookSavePoint({ agent, event, cwd, command }) {
    const real = await fsp.realpath(cwd || '.').catch(() => path.resolve(cwd || '.'));
    const root = [...journals.keys()].find((r) => samePath(r, real) || isInside(real, r));
    if (!root) return { savePoint: null, reason: 'not in a protected folder' };
    await ready.get(root);
    const j = journals.get(root);
    if (!j) return { savePoint: null, reason: 'no longer protected' };
    const oneLine = command.replace(/\s+/g, ' ').trim();
    const label = event === 'SessionStart' ? `${agent} session started`
      : oneLine ? `Before ${agent} runs: ${oneLine.length > 100 ? `${oneLine.slice(0, 100)}…` : oneLine}`
        : `${agent}${event ? `: ${event}` : ''}`;
    // Before every command: only when something changed since the newest save point, or they'd pile up.
    const savePoint = await j.createSavePoint({ trigger: 'hook', agent, label, onlyIfChanged: event !== 'SessionStart', quick: true });
    return { folder: root, savePoint };
  }

  // null, or why exact save points for agents aren't available.
  mewndo.hookServerProblem = () => hookServerProblem;

  // --- Unclean shutdowns ------------------------------------------------------------------------------------------
  // Stored objects aren't flushed to disk one by one (see store.js), so a power cut can damage the newest ones.
  // running.json exists while Mewndo runs and says from when objects may not be on disk yet; a clean stop deletes
  // it. Found at launch, it means the last run ended uncleanly: those objects are checked, damaged ones removed,
  // and index entries that point at missing content dropped, so the catch-up scan stores those files again.
  // ponytail: assumes the OS writes data to disk within 5 minutes (Linux: 30 s, Windows: seconds); checkpoints
  // could fsync instead if that ever proves too optimistic.
  const markerFile = path.join(dataDir, 'running.json');
  let checkpointTimer = null;
  const writeMarker = (since) => writeFileAtomic(markerFile, JSON.stringify({ since }));

  async function recoverIfUnclean() {
    const marker = await readJson(markerFile);
    if (!marker) return;
    const damaged = await store.verifySince(marker.since ?? 0);
    const stored = await store.hashes();
    let dropped = 0;
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const file = path.join(foldersDir, id, 'index.json');
      const saved = await readJson(file).catch(() => null);
      if (!saved?.index) continue;
      const before = Object.keys(saved.index).length;
      for (const [rel, e] of Object.entries(saved.index)) if (e.hash && !stored.has(e.hash)) delete saved.index[rel];
      const n = before - Object.keys(saved.index).length;
      if (n) { dropped += n; await writeFileAtomic(file, JSON.stringify(saved)); }
    }
    mewndo.emit('recovered', { damaged: damaged.length, dropped });
    if (damaged.length || dropped) {
      warn('unclean-shutdown', `Mewndo didn't shut down cleanly last time (for example a power cut). ${damaged.length} recently saved `
        + `file version${damaged.length === 1 ? ' was' : 's were'} damaged and removed; files still on disk are being saved again. `
        + 'Restoring one of those versions will report it as missing.');
    }
  }

  // At launch: clean temp files, protect the remembered folders again (catch-up scans run in the
  // background), prune, then prune once a day.
  mewndo.start = async () => {
    await fsp.mkdir(dataDir, { recursive: true });
    await store.cleanTemp();
    await recoverIfUnclean();
    await writeMarker(now());
    checkpointTimer = setInterval(() => writeMarker(now() - 5 * 60 * 1000).catch(() => {}), 10 * 60 * 1000);
    checkpointTimer.unref();
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const settings = await readJson(settingsFile(path.join(foldersDir, id)));
      if (!settings?.protected || [...journals.keys()].some((r) => samePath(r, settings.root))) continue; // already running
      try {
        await mewndo.protect(settings.root, { retentionDays: settings.retentionDays, background: true, resuming: true });
      } catch (e) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENODEV', 'ENXIO'].includes(e.code)) await registerOffline(settings);
        else warn('folder-unavailable', `Can't protect ${settings.root}: ${e.message}`, { root: settings.root });
      }
    }
    await mewndo.prune();
    timer = setInterval(() => mewndo.prune().catch((e) => warn('prune-failed', e.message)), pruneEveryMs);
    timer.unref();
    availabilityTimer = setInterval(() => checkAvailability().catch((e) => warn('journal', e.message)), availabilityCheckMs);
    availabilityTimer.unref();
    diskTimer = setInterval(() => checkDisk().catch(() => {}), diskCheckMs);
    diskTimer.unref();
    if (agents) {
      agentWatcher = createAgentWatcher({
        agentsFile: path.join(dataDir, 'agents.json'), intervalMs: agents.intervalMs, listProcesses: agents.listProcesses,
        onChange: onAgents, onError: (e) => warn('agents', e.message),
      });
      await agentWatcher.start();
      agentTimer = setInterval(agentTick, agents.saveEveryMs ?? 10 * 60 * 1000);
      agentTimer.unref();
    }
    if (hookServer) {
      try {
        hookServerHandle = await startHookServer({ dataDir, port: hookServer.port, onSavePoint: hookSavePoint });
        hookServerProblem = null;
      } catch (e) {
        hookServerProblem = e.code === 'EADDRINUSE'
          ? `Exact save points for AI agents are off: port ${hookServer.port} is already used by another program.`
          : `Exact save points for AI agents are off: ${e.message}`;
        warn('hook-server', hookServerProblem);
      }
    }
  };

  mewndo.stop = async () => {
    clearInterval(timer);
    clearTimeout(resumeTimer);
    clearInterval(agentTimer);
    clearInterval(availabilityTimer);
    clearInterval(diskTimer);
    clearInterval(checkpointTimer);
    agentWatcher?.stop();
    runningAgents.clear();
    await hookServerHandle?.close();
    hookServerHandle = null;
    await pruning;
    for (const j of mewndo.journals()) await j.stop();
    journals.clear();
    if (checkpointTimer) await fsp.rm(markerFile, { force: true }); // a clean stop
    checkpointTimer = null;
  };

  mewndo.store = store;
  return mewndo;
}

module.exports = { createMewndo };
