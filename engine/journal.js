// Journal: one per protected folder. Keeps the folder's current index (a scanner manifest whose file
// contents are all in the store), watches for changes, and writes save points. Events:
//   'progress' scan/restore progress · 'change' { path, type: added|changed|deleted } · 'savepoint' metadata ·
//   'restored' restore result · 'retry' { path, op, attempt, error } while waiting for a locked file ·
//   'warning' Error from background work (watcher or sync) that did not stop it.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { watch } = require('chokidar');
const { scan, DEFAULT_IGNORE, DEFAULT_MAX_FILE_SIZE } = require('./scanner');
const { removeStaleTemp, writeFileAtomic, isInside } = require('./store');
const { changes: diff, compare } = require('./diff');
const { planRestore, restore, resumeRestores, isRestoreRunning, listRestores } = require('./restore');

const TRIGGERS = ['manual', 'brief', 'activity', 'agent', 'hook', 'before-undo'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function folderId(realRoot) {
  const key = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// Chokidar ignore: anything under an ignored folder, or an ignored folder itself.
function ignoreFn(root, names) {
  return (p, stats) => {
    const parts = path.relative(root, p).split(path.sep);
    if (parts.slice(0, -1).some((s) => names.has(s))) return true;
    return names.has(parts.at(-1)) && !!stats?.isDirectory();
  };
}

const MAX_WAIT_MS = 30_000; // under constant change, still sync at least this often

// Call onChange whenever anything under root may have changed. The journal then rescans, so the details of
// each event don't matter. Returns close().
//   native (Windows, macOS): one recursive OS watch handle. Nothing to walk and no file work at start,
//     however big the folder.
//   chokidar (Linux, which has no native recursive watching): walks the tree and stats every file first to
//     watch each folder. On Windows that walk over a 170,000-file OneDrive folder flooded the engine's file
//     queue, so every other file operation, even checking a 28-file folder, waited minutes behind it.
async function watchTree(root, { mode, ignore, writeFinishMs, onChange, onError }) {
  const names = new Set(ignore);
  if (mode === 'native') {
    const w = fs.watch(root, { recursive: true }, (_type, name) => {
      if (name && String(name).split(/[\\/]/).slice(0, -1).some((s) => names.has(s))) return; // inside an ignored folder
      onChange();
    });
    w.on('error', onError);
    return async () => w.close();
  }
  const w = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: ignoreFn(root, names),
    awaitWriteFinish: { stabilityThreshold: writeFinishMs, pollInterval: Math.min(100, writeFinishMs / 2) },
  });
  w.on('all', onChange).on('error', onError);
  await new Promise((resolve) => w.once('ready', resolve));
  return () => w.close();
}

function createJournal({
  root,
  dataDir,
  store,
  ignore = DEFAULT_IGNORE,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  concurrency,
  quietMs = 30_000, // an activity save point is made when changes start after this much quiet
  debounceMs = 300, // batch watcher events into one sync
  writeFinishMs = 2000, // a file must stop changing this long before it is captured
  watcher: watchMode = process.platform === 'win32' || process.platform === 'darwin' ? 'native' : 'chokidar',
}) {
  const journal = new EventEmitter();
  let realRoot, indexFile, savePointDir, closeWatcher, timer;
  let pendingSince = null;
  let index = null;
  let indexJson = null;
  let lastChangeAt = -Infinity;
  let lastSavePointAt = 0;
  let restoring = false;
  let queue = Promise.resolve();

  // All work on the index runs one task at a time.
  function enqueue(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }
  // A stopped journal cancels its running scan instead of waiting for it; the next start scans again.
  let scanAbort = new AbortController();
  const isAbort = (e) => e?.name === 'AbortError';
  const warn = (e) => { if (!isAbort(e)) journal.emit('warning', e); };

  // Scan against the index (only changed files are rehashed and stored), then record the result.
  async function sync() {
    const next = await scan(realRoot, {
      previous: index ?? {}, ignore, maxFileSize, concurrency, signal: scanAbort.signal,
      hash: store.put,
      onProgress: (p) => journal.emit('progress', p),
    });
    const changes = index ? diff(index, next) : [];
    if (changes.length && !restoring) {
      if (Date.now() - lastChangeAt >= quietMs) {
        await writeSavePoint(index, { trigger: 'activity', label: 'Before changes' });
      }
      lastChangeAt = Date.now();
    }
    const json = JSON.stringify(next);
    if (json !== indexJson) await writeFileAtomic(indexFile, JSON.stringify({ root: realRoot, index: next }));
    index = next;
    indexJson = json;
    for (const c of changes) journal.emit('change', c);
  }

  // ponytail: each save point is a full copy of the index; share unchanged entries between save points
  // if save point files get too big for very large folders.
  async function writeSavePoint(snapshot, { label, trigger, agent }) {
    lastSavePointAt = Math.max(Date.now(), lastSavePointAt + 1); // keeps createdAt strictly ordered
    const meta = {
      id: crypto.randomUUID(), createdAt: new Date(lastSavePointAt).toISOString(),
      label: label ?? '', trigger, agent: agent ?? null,
    };
    await writeFileAtomic(path.join(savePointDir, `${meta.id}.json`), JSON.stringify({ ...meta, index: snapshot }));
    journal.emit('savepoint', meta);
    return meta;
  }

  // Sync once changes pause. Chokidar already waits for each file to stop changing; the native watcher reports
  // every write, so it waits writeFinishMs of quiet instead, letting half-written files finish. Under constant
  // change it still syncs every MAX_WAIT_MS; a file still being written then is caught by readStable and
  // picked up by the next sync.
  const settleMs = watchMode === 'native' ? Math.max(debounceMs, writeFinishMs) : debounceMs;
  function schedule() {
    pendingSince ??= Date.now();
    clearTimeout(timer);
    const wait = Math.min(settleMs, Math.max(0, pendingSince + MAX_WAIT_MS - Date.now()));
    timer = setTimeout(() => {
      pendingSince = null;
      enqueue(sync).catch(warn);
    }, wait);
  }

  // Protect the folder: catch up with (or, the first time, capture) its contents, then watch it.
  journal.start = async () => {
    realRoot = await fsp.realpath(root);
    await fsp.mkdir(dataDir, { recursive: true });
    const realData = await fsp.realpath(dataDir);
    if (realData === realRoot || isInside(realData, realRoot)) {
      throw new Error(`Mewndo's data folder must not be inside a protected folder: ${realData}`);
    }
    const dir = path.join(realData, 'folders', folderId(realRoot));
    journal.root = realRoot;
    journal.folderDir = dir; // this folder's index, save points, restore logs and trash
    indexFile = path.join(dir, 'index.json');
    savePointDir = path.join(dir, 'savepoints');
    await removeStaleTemp(dir);
    await removeStaleTemp(savePointDir);

    index = (await readJson(indexFile))?.index ?? null;
    indexJson = index && JSON.stringify(index);

    // Watch first, so nothing that changes during the initial scan is missed.
    closeWatcher = await watchTree(realRoot, { mode: watchMode, ignore, writeFinishMs, onChange: schedule, onError: warn });
    // Finish an interrupted restore first, so its writes don't look like new activity.
    if (index) await resumeRestores(journal);
    try {
      await enqueue(sync);
    } catch (e) {
      if (!isAbort(e)) throw e; // stopped during the first scan: not an error, the next start catches up
    }
  };

  journal.stop = async () => {
    clearTimeout(timer);
    pendingSince = null;
    scanAbort.abort();
    await closeWatcher?.();
    closeWatcher = null;
    await queue;
    scanAbort = new AbortController(); // save points and restores still scan after a stop (e.g. while paused)
  };

  journal.createSavePoint = async ({ label, trigger = 'manual', agent } = {}) => {
    if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger: ${trigger}`);
    return enqueue(async () => {
      await sync(); // catch anything the watcher hasn't reported yet
      return writeSavePoint(index, { label, trigger, agent });
    });
  };

  // ponytail: reads every save point file to list them; keep a small metadata file if this gets slow.
  journal.listSavePoints = async () => {
    let names;
    try { names = await fsp.readdir(savePointDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const list = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const { index: _, ...meta } = await readJson(path.join(savePointDir, name));
      list.push(meta);
    }
    return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  journal.getSavePoint = async (id) => {
    if (!UUID.test(id)) throw new Error(`invalid save point id: ${id}`);
    return readJson(path.join(savePointDir, `${id}.json`));
  };

  // While restoring, the index still follows the folder but no activity save points are made.
  // Turning it off first syncs, so the restore's own writes are absorbed while still flagged.
  journal.setRestoring = (on) => enqueue(async () => {
    if (!on) await sync();
    restoring = on;
  });

  // What changed between a save point and the folder right now (scans first, so it's current).
  journal.diffSince = (id) => enqueue(async () => {
    const sp = await journal.getSavePoint(id);
    if (!sp) throw new Error(`no such save point: ${id}`);
    await sync();
    return compare(sp.index, index);
  });

  journal.getIndex = () => index;

  // Scan now and return the up-to-date index.
  journal.sync = () => enqueue(sync).then(() => index);

  // Hold the journal's work (syncs, save points) until the returned resume() is called. Watcher events
  // still queue up and run after. Used so pruning sees indexes and save points that can't change under it.
  journal.pause = () => new Promise((paused) => {
    enqueue(() => new Promise((resume) => paused(resume)));
  });
  journal.isRestoring = () => isRestoreRunning(journal);

  journal.store = store;
  journal.scanOptions = { ignore, maxFileSize, concurrency };
  journal.planRestore = (id, opts) => planRestore(journal, id, opts);
  journal.restore = (id, opts) => restore(journal, id, opts);
  journal.listRestores = () => listRestores(journal);

  return journal;
}

module.exports = { createJournal, folderId, TRIGGERS };
