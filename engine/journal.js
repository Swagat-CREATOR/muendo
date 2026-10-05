// Journal: one per protected folder. Keeps the folder's current index (a scanner manifest whose file
// contents are all in the store), watches for changes, and writes save points. Events:
//   'progress' scan/restore progress · 'change' { path, type: added|changed|deleted } · 'savepoint' metadata ·
//   'restored' restore result · 'retry' { path, op, attempt, error } while waiting for a locked file ·
//   'watcher-error' Error when the watcher fails (it restarts by itself) · 'watcher-restarted' ·
//   'gone' when the folder itself disappears (deleted, or its drive unplugged) ·
//   'burst' { deleted, changed } once when many files change within a minute (not from restores) ·
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
const { createBurstDetector } = require('./burst');
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

// Call onChange(relPath) whenever something under root may have changed, or onChange(null) when it isn't known
// what (then everything is rescanned). Returns close().
//   native (Windows, macOS): one recursive OS watch handle. Nothing to walk and no file work at start,
//     however big the folder.
//   chokidar (Linux, which has no native recursive watching): walks the tree and stats every file first to
//     watch each folder. On Windows that walk over a 170,000-file OneDrive folder flooded the engine's file
//     queue, so every other file operation, even checking a 28-file folder, waited minutes behind it.
async function watchTree(root, { mode, ignore, writeFinishMs, onChange, onError }) {
  const names = new Set(ignore);
  if (mode === 'native') {
    let gone = false;
    const w = fs.watch(root, { recursive: true }, (type, name) => {
      if (gone) return;
      if (!name) return onChange(null); // e.g. Windows' event buffer overflowed: what changed is unknown
      // Windows names the watched folder itself, by its full path, when it is deleted or its drive is unplugged,
      // and then repeats that thousands of times a second. Report it once.
      if (path.isAbsolute(String(name))) {
        gone = true;
        return onError(Object.assign(new Error(`The folder was removed or its drive unplugged: ${root}`), { code: 'ENOENT' }));
      }
      const rel = String(name).replace(/\\/g, '/');
      if (rel.split('/').slice(0, -1).some((s) => names.has(s))) return; // inside an ignored folder
      if (type !== 'change') return onChange(rel);
      // Windows reports a "change" on a folder when it is merely listed (its last-access time). Content changes
      // always come with events for the files themselves, so folder "change" events can be ignored.
      fsp.lstat(path.join(root, rel)).then((st) => { if (!st.isDirectory()) onChange(rel); }, () => onChange(rel));
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
  w.on('all', () => onChange(null)).on('error', onError); // ponytail: Linux (dev only) always rescans all
  await new Promise((resolve) => w.once('ready', resolve));
  return () => w.close();
}

function createJournal({
  root,
  dataDir,
  store,
  ignore = DEFAULT_IGNORE,
  ignorePatterns = [], // extra names or * patterns to leave out, for this folder (settings)
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  concurrency,
  quietMs = 30_000, // an activity save point is made when changes start after this much quiet
  debounceMs = 300, // batch watcher events into one sync
  writeFinishMs = 2000, // a file must stop changing this long before it is captured
  // Linux keeps Chokidar: Node's recursive watching there sometimes names nested files by their bare name, which
  // partial rescans can't rely on. (Tests use 'native' on Linux too; the events they need come through.)
  watcher: watchMode = process.platform === 'win32' || process.platform === 'darwin' ? 'native' : 'chokidar',
  burst: burstOptions, // thresholds for burst alerts (an object read on every check, so settings apply live)
  likelyAgent = () => null, // the AI agent most likely making changes right now, if any (see agents.js)
  maxWaitMs = MAX_WAIT_MS, // under constant change, sync at least this often (shorter in tests)
}) {
  const journal = new EventEmitter();
  let realRoot, indexFile, savePointDir, closeWatcher, timer;
  let waitingSince = null; // first event of the current wait for quiet; reset when that wait ends
  // Folders the native watcher reported changes in since the last scan, so background syncs and quick save points
  // read only those. Everything is rescanned when that isn't enough to go on: at start, after the watcher
  // failed or reported an unknown change, while not watching, and with the Linux watcher.
  const changedDirs = new Set();
  let fullRescan = true;
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  function noteChange(rel) {
    if (rel === null) fullRescan = true;
    else changedDirs.add(parentOf(rel));
    if (changedDirs.size > 2000) fullRescan = true; // reading them one by one would cost more than a full walk
    schedule();
  }
  let unsettledSince = null; // when files were first left for later as still being written
  let syncQueued = false; // at most one background sync waits in the queue, however many events arrive
  let index = null;
  let indexJson = null;
  let lastChangeAt = -Infinity;
  let lastSavePointAt = 0;
  let restoring = false;
  let catchingUp = false; // the scan at start: those changes happened while Mewndo wasn't watching
  let watching = false; // false while stopped or paused: changes then don't count toward burst alerts
  let savedJson = null; // the index as of the newest save point made since start, for onlyIfChanged
  const burst = createBurstDetector(burstOptions ?? {});
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
  // A folder that disappeared (deleted, or its drive unplugged) isn't an error to report: Mewndo marks it
  // unavailable (see 'gone') and resumes when it's back.
  const rootGone = (e) => e?.code === 'ENOENT' && realRoot && (e.path === realRoot || e.path === root || /removed or its drive/.test(e.message));
  const warn = (e) => {
    if (isAbort(e)) return;
    if (rootGone(e)) journal.emit('gone');
    else journal.emit('warning', e);
  };

  // Scan against the index (only changed files are rehashed and stored), then record the result.
  // settle: leave files modified within writeFinishMs at their previous version and look again soon, because
  // they may still be being written (used by background syncs with the native watcher, see schedule).
  // partial: read only the folders the watcher reported (see changedDirs) when that's enough to go on.
  async function sync({ settle = false, partial = false } = {}) {
    const usePartial = partial && watchMode === 'native' && closeWatcher && !fullRescan && index;
    if (usePartial && !changedDirs.size) {
      await new Promise((r) => setTimeout(r, 100)); // a file written a moment ago: let its event arrive
      if (!changedDirs.size && !fullRescan) return; // nothing changed since the last scan
    }
    const dirs = usePartial && !fullRescan ? [...changedDirs] : undefined;
    changedDirs.clear(); // changes from here on are noted for the next sync
    if (!dirs) fullRescan = false;
    let next;
    try {
      next = await scan(realRoot, {
        previous: index ?? {}, dirs, ignore, ignorePatterns, maxFileSize, concurrency, signal: scanAbort.signal,
        settleMs: settle ? writeFinishMs : 0,
        hash: store.put,
        onProgress: (p) => journal.emit('progress', p),
      });
    } catch (e) {
      fullRescan = true; // what was noted is lost: look at everything next time
      throw e;
    }
    let unsettled = false;
    for (const [rel, e] of Object.entries(next)) {
      if (!e.pending) continue;
      unsettled = true;
      changedDirs.add(parentOf(rel)); // look at it again next time
      if (index?.[rel]) next[rel] = index[rel];
      else delete next[rel];
    }
    if (unsettled) {
      unsettledSince ??= Date.now();
      schedule();
    } else {
      unsettledSince = null;
    }
    const index0 = index;
    const changes = index ? diff(index, next) : [];
    if (changes.length && !restoring) {
      if (Date.now() - lastChangeAt >= quietMs) {
        const agent = likelyAgent();
        await writeSavePoint(index, { trigger: 'activity', label: 'Before changes', agent, agentLikely: !!agent }, indexJson);
      }
      lastChangeAt = Date.now();
    }
    const json = JSON.stringify(next);
    if (json !== indexJson) await writeFileAtomic(indexFile, JSON.stringify({ root: realRoot, index: next }));
    index = next;
    indexJson = json;
    for (const c of changes) journal.emit('change', c);
    if (watching && !restoring && !catchingUp) {
      // Files and links only: a deleted folder of 30 files is 30 files, not 31 changes.
      const entry = (c) => (c.type === 'deleted' ? index0 : next)[c.path];
      const alert = burst.record(changes.filter((c) => entry(c)?.type !== 'directory'));
      if (alert) journal.emit('burst', { ...alert, agent: likelyAgent() }); // agent: a guess, shown as likely
    }
  }

  // ponytail: each save point is a full copy of the index; share unchanged entries between save points
  // if save point files get too big for very large folders.
  // agentLikely: the agent name is a guess (the agent that was running), not reported by the agent itself.
  async function writeSavePoint(snapshot, { label, trigger, agent, agentLikely }, snapshotJson) {
    lastSavePointAt = Math.max(Date.now(), lastSavePointAt + 1); // keeps createdAt strictly ordered
    const meta = {
      id: crypto.randomUUID(), createdAt: new Date(lastSavePointAt).toISOString(),
      label: label ?? '', trigger, agent: agent ? String(agent).slice(0, 60) : null,
      ...(agent && agentLikely ? { agentLikely: true } : {}),
    };
    await writeFileAtomic(path.join(savePointDir, `${meta.id}.json`), JSON.stringify({ ...meta, index: snapshot }));
    savedJson = snapshotJson;
    journal.emit('savepoint', meta);
    return meta;
  }

  // Sync once changes pause. Chokidar already waits for each file to stop changing. The native watcher waits
  // writeFinishMs of quiet, and its syncs also leave recently modified files for later: Windows sends no events
  // while a program keeps a file open and writes to it, so quiet alone doesn't mean a file is complete. Under
  // constant change it still syncs after MAX_WAIT_MS, then capturing everything as it is (a file still being
  // written is caught by readStable and picked up by the next sync).
  const native = watchMode === 'native';
  const settleMs = native ? Math.max(debounceMs, writeFinishMs) : debounceMs;
  function schedule() {
    waitingSince ??= Date.now();
    clearTimeout(timer);
    const left = waitingSince + maxWaitMs - Date.now();
    timer = setTimeout(() => {
      waitingSince = null;
      // During an in-place restore, syncing only competes with it for the disk: when it ends, setRestoring(false)
      // rescans everything anyway.
      if (restoring) return;
      // Files left unsettled for maxWaitMs (e.g. a log written all the time) are captured as they are.
      const forced = left <= settleMs || (unsettledSince !== null && Date.now() - unsettledSince >= maxWaitMs);
      if (syncQueued) return; // one is already waiting and will see these changes too
      syncQueued = true;
      enqueue(() => {
        syncQueued = false;
        return sync({ settle: native && !forced, partial: true });
      }).catch(warn);
    }, Math.max(0, Math.min(settleMs, left)));
  }

  // Where this folder's data lives (index, save points, restore logs, trash), and its last known index.
  async function attach(real) {
    await fsp.mkdir(dataDir, { recursive: true });
    const realData = await fsp.realpath(dataDir);
    if (realData === real || isInside(realData, real)) {
      throw new Error(`Mewndo's data folder must not be inside a protected folder: ${realData}`);
    }
    realRoot = real;
    const dir = path.join(realData, 'folders', folderId(realRoot));
    journal.root = realRoot;
    journal.folderDir = dir;
    indexFile = path.join(dir, 'index.json');
    savePointDir = path.join(dir, 'savepoints');
    await removeStaleTemp(dir);
    await removeStaleTemp(savePointDir);
    index = (await readJson(indexFile))?.index ?? null;
    indexJson = index && JSON.stringify(index);
  }

  // For a folder that can't be reached right now (e.g. its drive is unplugged): its save points can still be
  // listed and restored into a separate folder. root must be the folder's real path, as remembered.
  journal.attachOffline = () => attach(root);

  // If the watcher fails, say so and start a new one: after 2 s, then backing off to 1 min. Each restart is
  // followed by a sync that catches up on whatever happened meanwhile.
  let watcherRetry = null;
  let watcherDelay = 2000;
  function watcherFailed(e) {
    if (!watching || watcherRetry) return;
    // A folder that vanished: Mewndo marks it unavailable (stopping this journal). If it's still there after all,
    // the restart below brings the watcher back.
    if (rootGone(e)) journal.emit('gone');
    else journal.emit('watcher-error', e);
    const failed = closeWatcher;
    closeWatcher = null;
    Promise.resolve(failed?.()).catch(() => {});
    watcherRetry = setTimeout(async () => {
      watcherRetry = null;
      if (!watching) return;
      try {
        fullRescan = true; // changes while it was down weren't seen
        closeWatcher = await watchTree(realRoot, { mode: watchMode, ignore, writeFinishMs, onChange: noteChange, onError: watcherFailed });
        watcherDelay = 2000;
        journal.emit('watcher-restarted');
        schedule();
      } catch (err) {
        watcherDelay = Math.min(watcherDelay * 2, 60_000);
        watching && watcherFailed(err);
      }
    }, watcherDelay);
  }

  // Protect the folder: catch up with (or, the first time, capture) its contents, then watch it.
  journal.start = async () => {
    await attach(await fsp.realpath(root));
    // Watch first, so nothing that changes during the initial scan is missed.
    fullRescan = true; // nothing was watched before now
    closeWatcher = await watchTree(realRoot, { mode: watchMode, ignore, writeFinishMs, onChange: noteChange, onError: watcherFailed });
    watching = true;
    // Finish an interrupted restore first, so its writes don't look like new activity.
    if (index) await resumeRestores(journal);
    try {
      await enqueue(async () => {
        catchingUp = true;
        try { await sync(); } finally { catchingUp = false; }
      });
    } catch (e) {
      if (!isAbort(e)) throw e; // stopped during the first scan: not an error, the next start catches up
    }
  };

  journal.stop = async () => {
    clearTimeout(timer);
    waitingSince = null;
    unsettledSince = null;
    watching = false;
    fullRescan = true; // changes from now on aren't watched
    clearTimeout(watcherRetry);
    watcherRetry = null;
    scanAbort.abort();
    await closeWatcher?.();
    closeWatcher = null;
    await queue;
    scanAbort = new AbortController(); // save points and restores still scan after a stop (e.g. while paused)
  };

  // onlyIfChanged: skip it (resolving null) when nothing changed since the newest save point made since start,
  // e.g. for a hook that asks before every command an agent runs. quick: rely on what the watcher reported
  // instead of rescanning everything, so it's ready in milliseconds even in big folders (agents and hooks,
  // where the agent doesn't wait).
  journal.createSavePoint = async ({ label, trigger = 'manual', agent, agentLikely, onlyIfChanged = false, quick = false } = {}) => {
    if (!TRIGGERS.includes(trigger)) throw new Error(`unknown trigger: ${trigger}`);
    return enqueue(async () => {
      await sync({ partial: quick }); // catch anything the watcher hasn't reported yet
      if (onlyIfChanged && indexJson === savedJson) return null;
      return writeSavePoint(index, { label, trigger, agent, agentLikely }, indexJson);
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
  // When files last changed (not counting restores), or null if nothing has changed since start.
  journal.lastChangeAt = () => (lastChangeAt === -Infinity ? null : lastChangeAt);

  // Scan now and return the up-to-date index.
  journal.sync = () => enqueue(() => sync()).then(() => index); // not enqueue(sync): it'd get the last task's result

  // Hold the journal's work (syncs, save points) until the returned resume() is called. Watcher events
  // still queue up and run after. Used so pruning sees indexes and save points that can't change under it.
  journal.pause = () => new Promise((paused) => {
    enqueue(() => new Promise((resume) => paused(resume)));
  });
  journal.isRestoring = () => isRestoreRunning(journal);

  journal.store = store;
  // What a fresh scan of this folder uses (restore verification); always the current settings.
  Object.defineProperty(journal, 'scanOptions', { get: () => ({ ignore, ignorePatterns, maxFileSize, concurrency }) });

  // New per-folder settings: a running journal restarts (stop, then start with a catch-up scan), so files the
  // new settings include are captured and ones they leave out drop out of the index.
  journal.reconfigure = async ({ ignorePatterns: patterns, maxFileSize: size } = {}) => {
    const running = !!closeWatcher;
    if (running) await journal.stop();
    if (patterns) ignorePatterns = patterns;
    if (size) maxFileSize = size;
    if (running) await journal.start();
  };
  journal.planRestore = (id, opts) => planRestore(journal, id, opts);
  journal.restore = (id, opts) => restore(journal, id, opts);
  journal.listRestores = () => listRestores(journal);

  return journal;
}

module.exports = { createJournal, folderId, TRIGGERS };
