// Mewndo: the top level. Owns the shared content store and one journal per protected folder, remembers which
// folders are protected, and keeps storage in check: retention pruning, a storage budget, free disk space.
// Events: 'pruned' prune result · 'warning' { code: 'over-budget' | 'low-disk' | 'folder-unavailable' |
//   'prune-failed', message, ... }
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStore, writeFileAtomic } = require('./store');
const { createJournal } = require('./journal');

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const hashesOf = (index) => Object.values(index ?? {}).map((e) => e.hash).filter(Boolean);
const byAge = (a, b) => a.createdAt.localeCompare(b.createdAt);

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Never pruned: a folder's newest save point, anything from the last 24 hours, before-undo from the last 7 days.
function isKept(sp, folder, now) {
  const age = now - Date.parse(sp.createdAt);
  return sp === folder.savePoints.at(-1) || age < DAY || (sp.trigger === 'before-undo' && age < 7 * DAY);
}

function createMewndo({
  dataDir,
  budgetBytes = 10 * GB,
  lowDiskBytes = 2 * GB,
  pruneEveryMs = DAY,
  now = Date.now,
  journalOptions = {}, // passed to every journal (timings in tests)
}) {
  const mewndo = new EventEmitter();
  const store = createStore(path.join(dataDir, 'store'));
  const foldersDir = path.join(dataDir, 'folders');
  const journals = new Map(); // folder data dir -> journal
  let timer = null;
  let pruning = null;

  const warn = (code, message, extra = {}) => mewndo.emit('warning', { code, message, ...extra });
  const settingsFile = (dir) => path.join(dir, 'settings.json');

  async function find(root) {
    const real = await fsp.realpath(root).catch(() => path.resolve(root));
    return [...journals.values()].find((j) => samePath(j.root, real));
  }

  // Start protecting a folder (or resume protecting it). Returns its journal.
  mewndo.protect = async (root, { retentionDays = 30 } = {}) => {
    if (await find(root)) throw new Error(`already protected: ${root}`);
    const journal = createJournal({ ...journalOptions, root, dataDir, store });
    await journal.start();
    journals.set(journal.folderDir, journal);
    await writeFileAtomic(settingsFile(journal.folderDir), JSON.stringify({ root: journal.root, retentionDays, protected: true }));
    return journal;
  };

  // Stop protecting a folder. keepHistory: save points stay and can still be restored or protected again.
  // Otherwise its index, save points and restore logs are deleted. Its trash is kept either way: it holds
  // user files that restores moved aside, and Mewndo never permanently deletes user files.
  mewndo.unprotect = async (root, { keepHistory = true } = {}) => {
    const journal = await find(root);
    if (!journal) throw new Error(`not protected: ${root}`);
    if (journal.isRestoring()) throw new Error('a restore is running for this folder');
    await journal.stop();
    journals.delete(journal.folderDir);
    const dir = journal.folderDir;
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

  async function pruneNow(t) {
    const folders = await loadFolders();
    const sizes = await store.objects();
    const refs = new Map(); // hash -> how many save points/indexes refer to it
    for (const f of folders) {
      for (const h of f.pinned) refs.set(h, (refs.get(h) ?? 0) + 1);
      for (const sp of f.savePoints) for (const h of sp.hashes) refs.set(h, (refs.get(h) ?? 0) + 1);
    }
    // Bytes in use once unreferenced content is gone: referenced objects plus Mewndo's JSON files.
    let used = folders.reduce((n, f) => n + f.jsonBytes, 0);
    for (const h of refs.keys()) used += sizes.get(h) ?? 0;

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
    for (const c of candidates) if (t - Date.parse(c.sp.createdAt) > c.f.retentionDays * DAY) drop(c);
    for (const c of candidates) {
      if (used <= budgetBytes) break;
      if (!pruned.includes(c)) drop(c);
    }

    for (const c of pruned) await fsp.rm(c.sp.file, { force: true });
    let removedObjects = 0;
    for (const h of sizes.keys()) {
      if (!refs.has(h)) { await store.remove(h); removedObjects++; }
    }

    const result = {
      pruned: pruned.map(({ f, sp }) => ({ folder: f.root, id: sp.id, createdAt: sp.createdAt, trigger: sp.trigger, label: sp.label })),
      removedObjects, usedBytes: used, budgetBytes, overBudget: used > budgetBytes,
    };
    if (result.overBudget) {
      warn('over-budget', `Mewndo is using ${gb(used)} of its ${gb(budgetBytes)} budget and nothing more can be pruned safely.`,
        { usedBytes: used, budgetBytes });
    }
    const disk = await fsp.statfs(dataDir);
    const free = disk.bavail * disk.bsize;
    if (free < lowDiskBytes) warn('low-disk', `Only ${gb(free)} free on the disk Mewndo uses.`, { freeBytes: free });
    mewndo.emit('pruned', result);
    return result;
  }

  // Prune save points (retention, then budget) and delete content nothing refers to anymore.
  // Journals are paused so nothing changes underneath; skipped while a restore runs.
  // ponytail: a separate-folder restore that starts mid-prune isn't paused; it reports failures if its save
  // point was just pruned. Add a store-wide lock if that ever matters.
  async function runPrune() {
    const active = mewndo.journals();
    if (active.some((j) => j.isRestoring())) return { skipped: 'a restore is running' };
    const resumes = [];
    try {
      for (const j of active) resumes.push(await j.pause());
      if (active.some((j) => j.isRestoring())) return { skipped: 'a restore is running' };
      return await pruneNow(now());
    } finally {
      for (const resume of resumes) resume();
    }
  }
  mewndo.prune = () => (pruning ??= runPrune().finally(() => { pruning = null; }));

  // At launch: clean temp files, protect the remembered folders again, prune, then prune once a day.
  mewndo.start = async () => {
    await fsp.mkdir(dataDir, { recursive: true });
    await store.cleanTemp();
    for (const id of await fsp.readdir(foldersDir).catch(() => [])) {
      const settings = await readJson(settingsFile(path.join(foldersDir, id)));
      if (!settings?.protected) continue;
      try {
        await mewndo.protect(settings.root, { retentionDays: settings.retentionDays });
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
    await pruning;
    for (const j of mewndo.journals()) await j.stop();
    journals.clear();
  };

  mewndo.store = store;
  return mewndo;
}

module.exports = { createMewndo };
