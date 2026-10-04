// Mewndo: the top level. Owns the shared content store and one journal per protected folder, remembers which
// folders are protected, and keeps storage in check: retention pruning, a storage budget, free disk space.
// Events: 'pruned' prune result · 'folders-changed' · 'warning' { code: 'over-budget' | 'low-disk' |
//   'folder-unavailable' | 'journal' | 'prune-failed', message, ... } · and from each journal, as (root, payload):
//   'progress', 'savepoint', 'restored', 'retry', 'change'.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore, writeFileAtomic, isInside } = require('./store');
const { createJournal, folderId } = require('./journal');
const { folderSize, DEFAULT_IGNORE } = require('./scanner');

const FORWARDED = ['progress', 'savepoint', 'restored', 'retry', 'change'];

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

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
  lowDiskBytes = 2 * GB,
  pruneEveryMs = DAY,
  maxFolderBytes = 20 * GB, // larger folders are refused
  now = Date.now,
  journalOptions = {}, // passed to every journal (timings in tests)
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

  const warn = (code, message, extra = {}) => mewndo.emit('warning', { code, message, ...extra });
  const settingsFile = (dir) => path.join(dir, 'settings.json');
  const changed = () => mewndo.emit('folders-changed');

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
    await writeFileAtomic(settingsFile(dir), JSON.stringify({ root: real, retentionDays, protected: true }));
    const journal = createJournal({ ...journalOptions, root: real, dataDir, store });
    for (const ev of FORWARDED) journal.on(ev, (payload) => mewndo.emit(ev, real, payload));
    journal.on('warning', (e) => warn('journal', e.message, { folder: real }));
    journals.set(real, journal);
    starting.add(real);
    changed();
    const started = journal.start().then(() => journal, async (e) => {
      journals.delete(real);
      await writeFileAtomic(settingsFile(dir), JSON.stringify({ root: real, retentionDays, protected: false }));
      throw e;
    }).finally(() => { starting.delete(real); changed(); });
    if (!background) return started;
    started.catch((e) => warn('folder-unavailable', `Can't protect ${real}: ${e.message}`, { root: real }));
    return journal;
  };

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

  // Protected folders for display: [{ root, status: scanning|restoring|paused|protected, files }].
  mewndo.folders = () => [...journals].map(([root, j]) => ({
    root,
    status: starting.has(root) ? 'scanning' : j.isRestoring() ? 'restoring' : pausedUntil ? 'paused' : 'protected',
    files: Object.values(j.getIndex() ?? {}).filter((e) => e.type === 'file').length,
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
      try { await j.start(); } catch (e) { warn('folder-unavailable', `Can't protect ${root}: ${e.message}`, { root }); }
      finally { starting.delete(root); changed(); }
    }
  };

  mewndo.pausedUntil = () => pausedUntil;

  // Everything every folder still refers to, including folders that are no longer protected.
  async function loadFolders() {
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
        if (log?.status === 'running') for (const s of log.steps) if (s.hash) pinned.add(s.hash);
      }
      const savePoints = [];
      const spDir = path.join(dir, 'savepoints');
      for (const name of (await fsp.readdir(spDir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
        const file = path.join(spDir, name);
        const sp = await readJson(file); // a damaged file throws: never prune without knowing every reference
        const bytes = (await fsp.lstat(file)).size;
        jsonBytes += bytes;
        savePoints.push({
          id: sp.id, createdAt: sp.createdAt, trigger: sp.trigger, label: sp.label, file, bytes,
          hashes: new Set(hashesOf(sp.index)),
        });
      }
      savePoints.sort(byAge);
      folders.push({ root: settings?.root ?? index?.root, retentionDays: settings?.retentionDays ?? 30, pinned, jsonBytes, savePoints });
    }
    return folders;
  }

  // What counts toward the budget: referenced stored content plus Mewndo's JSON files. Not the trash.
  async function measure() {
    const folders = await loadFolders();
    const sizes = await store.objects();
    const refs = new Map(); // hash -> how many save points/indexes refer to it
    for (const f of folders) {
      for (const h of f.pinned) refs.set(h, (refs.get(h) ?? 0) + 1);
      for (const sp of f.savePoints) for (const h of sp.hashes) refs.set(h, (refs.get(h) ?? 0) + 1);
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
    const drop = (c) => {
      used -= c.sp.bytes;
      for (const h of c.sp.hashes) {
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
    for (const c of candidates) if (t - Date.parse(c.sp.createdAt) > c.f.retentionDays * DAY) drop(c);
    // Budget: what's left unprotected is activity, agent and hook save points within retention. Oldest first.
    for (const c of candidates) {
      if (used <= budgetBytes) break;
      if (!pruned.includes(c)) drop(c);
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

    const result = {
      pruned: pruned.map(({ f, sp }) => ({ folder: f.root, id: sp.id, createdAt: sp.createdAt, trigger: sp.trigger, label: sp.label })),
      removedObjects, sweepSkipped, usedBytes: used, budgetBytes, overBudget: used > budgetBytes,
    };
    if (result.overBudget) {
      warn('over-budget', `Mewndo is using ${gb(used)} of its ${gb(budgetBytes)} budget. The budget can't be met `
        + 'without removing protected save points (manual, brief, before-undo, or recent ones), so they were kept.',
      { usedBytes: used, budgetBytes });
    }
    const free = await freeDiskBytes();
    if (free < lowDiskBytes) warn('low-disk', `Only ${gb(free)} free on the disk Mewndo uses.`, { freeBytes: free });
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
  mewndo.storageReport = async () => {
    const { used, folders: all, sizes } = await measure();
    const trash = await mewndo.trashReport();
    const folders = all.filter((f) => f.root).map((f) => {
      const hashes = new Set([...f.pinned, ...f.savePoints.flatMap((sp) => [...sp.hashes])]);
      let bytes = f.jsonBytes;
      for (const h of hashes) bytes += sizes.get(h) ?? 0;
      return { folder: f.root, bytes, savePoints: f.savePoints.length };
    });
    return {
      usedBytes: used, budgetBytes, overBudget: used > budgetBytes, folders,
      trashBytes: trash.reduce((n, t) => n + t.bytes, 0), trash,
      freeDiskBytes: await freeDiskBytes(),
    };
  };

  // At launch: clean temp files, protect the remembered folders again (catch-up scans run in the
  // background), prune, then prune once a day.
  mewndo.start = async () => {
    await fsp.mkdir(dataDir, { recursive: true });
    await store.cleanTemp();
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const settings = await readJson(settingsFile(path.join(foldersDir, id)));
      if (!settings?.protected) continue;
      try {
        await mewndo.protect(settings.root, { retentionDays: settings.retentionDays, background: true, resuming: true });
      } catch (e) {
        warn('folder-unavailable', `Can't protect ${settings.root}: ${e.message}`, { root: settings.root });
      }
    }
    await mewndo.prune();
    timer = setInterval(() => mewndo.prune().catch((e) => warn('prune-failed', e.message)), pruneEveryMs);
    timer.unref();
  };

  mewndo.stop = async () => {
    clearInterval(timer);
    clearTimeout(resumeTimer);
    await pruning;
    for (const j of mewndo.journals()) await j.stop();
    journals.clear();
  };

  mewndo.store = store;
  return mewndo;
}

module.exports = { createMewndo };
