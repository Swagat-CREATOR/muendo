// Journal: one per protected folder. Keeps the folder's current index (a scanner manifest whose file
// contents are all in the store), watches for changes, and writes save points. Events:
//   'progress' scan/restore progress · 'change' { path, type: added|changed|deleted } · 'savepoint' metadata ·
//   'restored' restore result · 'warning' Error from background work (watcher or sync) that did not stop it.
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { watch } = require('chokidar');
const { scan, DEFAULT_IGNORE, DEFAULT_MAX_FILE_SIZE } = require('./scanner');
const { removeStaleTemp, writeFileAtomic, isInside } = require('./store');
const { changes: diff, compare } = require('./diff');
const { planRestore, restore, resumeRestores } = require('./restore');

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

function createJournal({
  root,
  dataDir,
  store,
  ignore = DEFAULT_IGNORE,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  concurrency,
  quietMs = 30_000, // an activity save point is made when changes start after this much quiet
  debounceMs = 300, // batch watcher events into one sync
  writeFinishMs = 2000, // a file must stop changing this long before the watcher reports it
}) {
  const journal = new EventEmitter();
  let realRoot, indexFile, savePointDir, watcher, timer;
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
  const warn = (e) => journal.emit('warning', e);

  // Scan against the index (only changed files are rehashed and stored), then record the result.
  async function sync() {
    const next = await scan(realRoot, {
      previous: index ?? {}, ignore, maxFileSize, concurrency,
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

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => enqueue(sync).catch(warn), debounceMs);
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
    watcher = watch(realRoot, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: ignoreFn(realRoot, new Set(ignore)),
      awaitWriteFinish: { stabilityThreshold: writeFinishMs, pollInterval: Math.min(100, writeFinishMs / 2) },
    });
    watcher.on('all', schedule).on('error', warn);
    await new Promise((resolve) => watcher.once('ready', resolve));
    // Finish an interrupted restore first, so its writes don't look like new activity.
    if (index) await resumeRestores(journal);
    await enqueue(sync);
  };

  journal.stop = async () => {
    clearTimeout(timer);
    await watcher?.close();
    await queue;
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

  journal.store = store;
  journal.scanOptions = { ignore, maxFileSize, concurrency };
  journal.planRestore = (id, opts) => planRestore(journal, id, opts);
  journal.restore = (id, opts) => restore(journal, id, opts);

  return journal;
}

module.exports = { createJournal, TRIGGERS };
