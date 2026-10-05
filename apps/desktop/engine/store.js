// Content store: file contents named by SHA-256, stored once, gzipped unless already compressed.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);

const PRECOMPRESSED = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic',
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.mp3', '.m4a', '.aac', '.ogg', '.flac',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.xz', '.bz2', '.zst',
  '.pdf', '.docx', '.xlsx', '.pptx', '.jar', '.apk',
]);

const TEMP_SUFFIX = '.mewndo-tmp';
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;

// Error code for a file that was swapped, modified or moved out of bounds while we read it.
const CHANGED = 'EMEWNDO_CHANGED';

// O_NOFOLLOW refuses to open a symlink on Linux/macOS. Windows has none, so readStable re-checks after opening.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function hashTap(hash) {
  return new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
}

function changed(file, why) {
  return Object.assign(new Error(`changed while reading (${why}): ${file}`), { code: CHANGED });
}

// Same file identity, size and modified time. Bigint stats so Windows file IDs compare exactly.
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// Open a regular file and hand a read stream to consume(). Throws CHANGED if the path is or becomes a link,
// if the opened file is not the one lstat saw, if it changes during the read, or if its real path is not
// inside `within` (a realpath'd protected folder; optional).
async function readStable(file, within, consume) {
  const before = await fsp.lstat(file, { bigint: true });
  if (!before.isFile()) throw changed(file, 'not a regular file');
  let fh;
  try {
    fh = await fsp.open(file, READ_FLAGS);
  } catch (e) {
    throw e.code === 'ELOOP' ? changed(file, 'became a link') : e;
  }
  try {
    if (!sameFile(before, await fh.stat({ bigint: true }))) throw changed(file, 'replaced before open');
    if (within && !isInside(await fsp.realpath(file), within)) throw changed(file, 'outside protected folder');
    const result = await consume(fh.createReadStream({ autoClose: false, start: 0 }));
    const afterOpen = await fh.stat({ bigint: true });
    const afterPath = await fsp.lstat(file, { bigint: true }).catch(() => null);
    if (!afterPath || afterPath.isSymbolicLink()) throw changed(file, 'path is gone or now a link');
    if (!sameFile(before, afterOpen) || !sameFile(before, afterPath)) throw changed(file, 'modified during read');
    return result;
  } finally {
    await fh.close();
  }
}

async function hashFile(file, within) {
  const hash = crypto.createHash('sha256');
  await readStable(file, within, async (stream) => { for await (const chunk of stream) hash.update(chunk); });
  return hash.digest('hex');
}

function createStore(dir) {
  const objectsDir = path.join(dir, 'objects');
  const tmpDir = path.join(dir, 'tmp');

  function objectPath(hash, gzipped) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid hash: ${hash}`);
    return path.join(objectsDir, hash.slice(0, 2), gzipped ? `${hash}.gz` : hash);
  }

  async function find(hash) {
    for (const gzipped of [false, true]) {
      const p = objectPath(hash, gzipped);
      if (await exists(p)) return { path: p, gzipped };
    }
    return null;
  }

  async function has(hash) {
    return (await find(hash)) !== null;
  }

  // Store a file and return its hash. Hashes first so already-stored content costs one read and no write; new
  // content is gzipped (unless already compressed) into a temp file and renamed. Small files are read once;
  // big ones are streamed a second time, hashed again on the way.
  // Not flushed to disk one by one: that cost ~350 s per 50,000 files. A power cut can damage the newest
  // objects instead, so after an unclean shutdown Mewndo checks them with verifySince() (see mewndo.js).
  // ponytail: new content over 1 MB is read twice; fine up to the 50 MB limit, single-pass if big files get slow.
  let gate = null; // set while pruning decides what to delete; puts wait for it
  let inFlight = 0;
  let idle = null; // resolves when inFlight drops to 0

  async function put(file, within) {
    while (gate) await gate;
    inFlight++;
    try {
      return await storeFile(file, within);
    } finally {
      if (--inFlight === 0) idle?.();
    }
  }

  // Hold new puts and wait for running ones to finish; returns release(). While held, nothing new can come
  // to refer to stored content, so pruning can safely delete what nothing refers to.
  async function holdPuts() {
    while (gate) await gate;
    let release;
    gate = new Promise((r) => { release = r; });
    if (inFlight > 0) await new Promise((r) => { idle = r; });
    idle = null;
    return () => { gate = null; release(); };
  }

  // Folders already created this session, so storing a file doesn't ask for them again.
  const made = new Set();
  async function mkdirOnce(dir) {
    if (made.has(dir)) return;
    await fsp.mkdir(dir, { recursive: true });
    made.add(dir);
  }

  // Rename a finished temp file into place as the object for `digest`. If another put stored the same content
  // meanwhile, replacing it is harmless (same bytes); if the replace fails (Windows: open for a restore), the
  // existing copy is kept.
  async function commit(tmp, digest, gzipped) {
    const dest = objectPath(digest, gzipped);
    await mkdirOnce(path.dirname(dest));
    try { await fsp.rename(tmp, dest); } catch (e) { if (!(await has(digest))) throw e; }
  }

  async function storeFile(file, within) {
    // One read: hash, and keep small files in memory, so new small content needs no second read.
    const SMALL = 1024 * 1024;
    const hash0 = crypto.createHash('sha256');
    let chunks = [];
    let bytes = 0;
    await readStable(file, within, async (stream) => {
      for await (const chunk of stream) {
        hash0.update(chunk);
        if (!chunks) continue;
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes > SMALL) chunks = null; // big: stream it again below instead
      }
    });
    const first = hash0.digest('hex');
    if (await has(first)) return first;
    const gzipped = !PRECOMPRESSED.has(path.extname(file).toLowerCase());
    await mkdirOnce(tmpDir);
    const tmp = path.join(tmpDir, crypto.randomUUID() + TEMP_SUFFIX);
    if (chunks) {
      let committed = false;
      try {
        const data = Buffer.concat(chunks, bytes);
        await fsp.writeFile(tmp, gzipped ? await gzip(data) : data, { flag: 'wx' });
        await commit(tmp, first, gzipped);
        committed = true;
        return first;
      } finally {
        if (!committed) await fsp.rm(tmp, { force: true }); // after a rename there's nothing left to remove
      }
    }
    const hash = crypto.createHash('sha256');
    try {
      await readStable(file, within, (stream) => pipeline(
        stream,
        hashTap(hash),
        ...(gzipped ? [zlib.createGzip()] : []),
        fs.createWriteStream(tmp, { flags: 'wx' }),
      ));
      const digest = hash.digest('hex');
      if (digest !== first) throw changed(file, 'modified between reads');
      await commit(tmp, digest, gzipped);
      return digest;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  // Write stored content to a verified temp file next to dest and return its path; the caller renames it
  // into place. Next to dest (not in the store's tmp folder) because rename can't cross drives.
  async function extract(hash, dest) {
    const src = await find(hash);
    if (!src) throw new Error(`not stored: ${hash}`);
    const tmp = `${dest}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
    const check = crypto.createHash('sha256');
    try {
      await pipeline(
        fs.createReadStream(src.path),
        ...(src.gzipped ? [zlib.createGunzip()] : []),
        hashTap(check),
        fs.createWriteStream(tmp, { flags: 'wx', flush: true }),
      );
      if (check.digest('hex') !== hash) throw new Error(`stored content is corrupt: ${hash}`);
      return tmp;
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  // Copy stored content to dest via temp file + rename. Verifies the hash. Never overwrites an existing dest:
  // the caller moves the old file to Mewndo's trash first.
  async function copyOut(hash, dest) {
    if (await exists(dest)) throw new Error(`destination exists: ${dest}`);
    const tmp = await extract(hash, dest);
    try {
      // ponytail: check-then-rename has a tiny race; fs.link would be atomic but fails on FAT/exFAT drives.
      if (await exists(dest)) throw new Error(`destination exists: ${dest}`);
      await fsp.rename(tmp, dest);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  // Total bytes on disk used by stored content.
  async function usage() {
    if (!(await exists(objectsDir))) return 0;
    let total = 0;
    for (const e of await fsp.readdir(objectsDir, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) total += (await fsp.lstat(path.join(e.parentPath, e.name))).size;
    }
    return total;
  }

  // Every stored object: Map hash -> bytes on disk.
  async function objects() {
    const sizes = new Map();
    if (!(await exists(objectsDir))) return sizes;
    for (const e of await fsp.readdir(objectsDir, { recursive: true, withFileTypes: true })) {
      const hash = e.name.replace(/\.gz$/, '');
      if (e.isFile() && /^[0-9a-f]{64}$/.test(hash)) {
        sizes.set(hash, (sizes.get(hash) ?? 0) + (await fsp.lstat(path.join(e.parentPath, e.name))).size);
      }
    }
    return sizes;
  }

  // Delete stored content. Only for content no save point or index refers to (see pruning).
  async function remove(hash) {
    for (const gzipped of [false, true]) await fsp.rm(objectPath(hash, gzipped), { force: true });
  }

  // Run at startup. Never touches objects.
  const cleanTemp = (maxAgeMs) => removeStaleTemp(tmpDir, maxAgeMs);

  // Hashes of everything stored (names only, no per-file work).
  async function hashes() {
    if (!(await exists(objectsDir))) return new Set();
    const names = await fsp.readdir(objectsDir, { recursive: true });
    return new Set(names.map((n) => path.basename(n).replace(/\.gz$/, '')).filter((h) => /^[0-9a-f]{64}$/.test(h)));
  }

  // After an unclean shutdown: re-check every object written at or after `since` (ms) and delete the ones whose
  // content no longer matches its name (e.g. cut short by a power loss). Returns the deleted hashes.
  async function verifySince(since) {
    const bad = [];
    if (!(await exists(objectsDir))) return bad;
    const files = (await fsp.readdir(objectsDir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && /^[0-9a-f]{64}(\.gz)?$/.test(e.name));
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < files.length) {
        const e = files[next++];
        const file = path.join(e.parentPath, e.name);
        const st = await fsp.lstat(file).catch(() => null);
        if (!st || st.mtimeMs < since) continue;
        const want = e.name.replace(/\.gz$/, '');
        const check = crypto.createHash('sha256');
        const ok = await pipeline(fs.createReadStream(file), ...(e.name.endsWith('.gz') ? [zlib.createGunzip()] : []), hashTap(check),
          new Transform({ transform(_c, _e, cb) { cb(); } }))
          .then(() => check.digest('hex') === want, () => false);
        if (!ok) {
          await fsp.rm(file, { force: true });
          bad.push(want);
        }
      }
    }));
    return bad;
  }

  return { put, holdPuts, has, extract, copyOut, usage, objects, remove, cleanTemp, hashes, verifySince };
}

// Delete *.mewndo-tmp files older than maxAgeMs directly inside dir (Mewndo's own folders only).
// Returns how many were removed.
async function removeStaleTemp(dir, maxAgeMs = TEMP_MAX_AGE_MS) {
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(TEMP_SUFFIX)) continue;
    const p = path.join(dir, name);
    const st = await fsp.lstat(p).catch(() => null);
    if (st?.isFile() && Date.now() - st.mtimeMs > maxAgeMs) {
      await fsp.rm(p, { force: true });
      removed++;
    }
  }
  return removed;
}

// Write a file via temp file + rename so a crash leaves either the old or the new version, never half of one.
// mode: permissions for the new file, e.g. 0o600 for secrets (ignored on Windows).
async function writeFileAtomic(file, text, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
  try {
    await fsp.writeFile(tmp, text, { flag: 'wx', flush: true, ...(mode ? { mode } : {}) });
    await renameReplacing(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

// Windows won't replace a file another program has open at that moment, which antivirus and the search indexer do
// briefly with files that were just written. Try again for up to about 5 s (a busy machine) before giving up.
async function renameReplacing(from, to) {
  for (let delay = 10; ; delay *= 2) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || delay > 4000) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = {
  createStore, hashFile, readStable, removeStaleTemp, writeFileAtomic, isInside, CHANGED, TEMP_SUFFIX,
};
