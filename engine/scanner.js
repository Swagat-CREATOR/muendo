// Folder scanner: walks a folder with lstat only and returns a manifest { relPath: entry }.
// Paths use '/' on every platform. Links and junctions are recorded, never entered.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { hashFile, CHANGED } = require('./store');

const DEFAULT_IGNORE = [
  'node_modules', '.venv', 'dist', 'build',
  '.cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.parcel-cache',
];
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;

async function scan(root, {
  previous = {},
  ignore = DEFAULT_IGNORE,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  concurrency = 4,
  hash = hashFile, // (file, realRoot); a store's put() can go here to hash and store in one read
  onProgress = () => {},
} = {}) {
  const realRoot = await fsp.realpath(root);
  const ignored = new Set(ignore);
  const manifest = {};
  const toHash = [];
  const progress = { phase: 'walking', found: 0, toHash: 0, hashed: 0 };
  const report = () => onProgress({ ...progress });

  const dirs = [''];
  while (dirs.length) {
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
        const entry = { type: 'file', size: st.size, mtimeMs: st.mtimeMs };
        manifest[rel] = entry;
        const prev = previous[rel];
        if (st.size > maxFileSize) entry.skipped = 'too-large';
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

module.exports = { scan, DEFAULT_IGNORE, DEFAULT_MAX_FILE_SIZE };
