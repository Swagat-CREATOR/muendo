// Folder scanner: walks a folder with lstat only and returns a manifest { relPath: entry }.
// Paths use '/' on every platform. Links and junctions are recorded, never entered.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { hashFile, CHANGED, TEMP_SUFFIX } = require('./store');

const DEFAULT_IGNORE = [
  'node_modules', '.venv', 'dist', 'build',
  '.cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.parcel-cache',
];
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

// name -> true when it matches one of the patterns: a whole name, with * for any run of characters. Case is
// ignored on Windows and macOS, where file names are case-insensitive.
function patternMatcher(patterns) {
  const flags = process.platform === 'linux' ? '' : 'i';
  const res = patterns.filter(Boolean).map((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, flags));
  return (name) => res.some((re) => re.test(name));
}

// An online-only cloud file (OneDrive "Files On-Demand" and similar): it has a size but takes no disk space.
// Opening it would download it, so it is recorded as skipped instead. Tiny files can live inside the file table
// with no space of their own, hence the 4 KB floor.
// ponytail: inferred from space used; read the file's RECALL_ON_DATA_ACCESS attribute if Node ever exposes it.
const isOnlineOnly = (st) => st.size > 4096 && st.blocks === 0;

async function scan(root, {
  previous = {},
  ignore = DEFAULT_IGNORE, // folder names
  ignorePatterns = [], // extra: file or folder names, * matches anything (e.g. "*.log", "tmp")
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  concurrency = 4,
  hash = hashFile, // (file, realRoot); a store's put() can go here to hash and store in one read
  onProgress = () => {},
  signal, // an AbortSignal: stops the scan between files with an AbortError
  skipOnlineOnly = process.platform === 'win32',
  // Files modified less than this long ago are marked { pending: true } and not hashed: they may still be being
  // written. Files dated more than a second in the future are not pending, so a wrong date can't hide a file.
  settleMs = 0,
} = {}) {
  const scanStart = Date.now();
  const realRoot = await fsp.realpath(root);
  const ignored = new Set(ignore);
  const extra = patternMatcher(ignorePatterns);
  const manifest = {};
  const toHash = [];
  const progress = { phase: 'walking', found: 0, toHash: 0, hashed: 0 };
  const report = () => onProgress({ ...progress });

  const dirs = [''];
  while (dirs.length) {
    signal?.throwIfAborted();
    const dir = dirs.pop();
    let names;
    try {
      names = await fsp.readdir(path.join(root, dir));
    } catch (e) {
      if (dir === '') throw e;
      if (e.code === 'ENOENT') delete manifest[dir];
      else manifest[dir].error = e.code;
      continue;
    }
    for (const name of names) {
      if (extra(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      const abs = path.join(root, rel);
      let st;
      try {
        st = await fsp.lstat(abs);
      } catch (e) {
        if (e.code !== 'ENOENT') manifest[rel] = { type: 'unknown', error: e.code };
        continue;
      }
      if (st.isSymbolicLink()) { // junctions report as symbolic links too
        try { manifest[rel] = { type: 'link', target: await fsp.readlink(abs) }; }
        catch (e) { if (e.code !== 'ENOENT') manifest[rel] = { type: 'link', error: e.code }; }
      } else if (st.isDirectory()) {
        if (ignored.has(name)) continue;
        manifest[rel] = { type: 'directory' };
        dirs.push(rel);
      } else if (st.isFile()) {
        if (name.endsWith(TEMP_SUFFIX)) continue; // Mewndo's own in-progress restore writes
        const entry = { type: 'file', size: st.size, mtimeMs: st.mtimeMs };
        manifest[rel] = entry;
        const prev = previous[rel];
        const age = scanStart - st.mtimeMs;
        if (st.size > maxFileSize) entry.skipped = 'too-large';
        else if (skipOnlineOnly && isOnlineOnly(st)) entry.skipped = 'online-only';
        else if (settleMs && age < settleMs && age > -1000) entry.pending = true;
        else if (prev?.type === 'file' && prev.hash && prev.size === st.size && prev.mtimeMs === st.mtimeMs) entry.hash = prev.hash;
        else toHash.push(rel);
      } // ponytail: sockets, FIFOs and devices are not user files; skipped
      progress.found++;
    }
    report();
  }

  progress.phase = 'hashing';
  progress.toHash = toHash.length;
  report();
  let next = 0;
  async function worker() {
    while (next < toHash.length) {
      signal?.throwIfAborted();
      const rel = toHash[next++];
      try {
        manifest[rel].hash = await hash(path.join(root, rel), realRoot);
      } catch (e) {
        if (e.code === 'ENOENT') delete manifest[rel];
        else if (e.code === CHANGED) manifest[rel].skipped = 'changed-while-reading';
        else manifest[rel].error = e.code || e.message;
      }
      progress.hashed++;
      report();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  progress.phase = 'done';
  report();
  return manifest;
}

// Total size of the files in a folder, with the scan's ignore rules and never entering links. Stops early
// once over stopAboveBytes. Returns { bytes, files, over }.
async function folderSize(root, { ignore = DEFAULT_IGNORE, ignorePatterns = [], stopAboveBytes = Infinity, onProgress = () => {} } = {}) {
  const ignored = new Set(ignore);
  const extra = patternMatcher(ignorePatterns);
  let bytes = 0;
  let files = 0;
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop();
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (extra(name)) continue;
      const st = await fsp.lstat(path.join(dir, name)).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!ignored.has(name)) dirs.push(path.join(dir, name));
      } else if (st.isFile()) {
        bytes += st.size;
        files++;
        if (bytes > stopAboveBytes) return { bytes, files, over: true };
        if (files % 500 === 0) onProgress({ files, bytes });
      }
    }
  }
  return { bytes, files, over: false };
}

module.exports = { scan, folderSize, patternMatcher, DEFAULT_IGNORE, DEFAULT_MAX_FILE_SIZE };
