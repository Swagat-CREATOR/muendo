// Content store: file contents named by SHA-256, stored once, gzipped unless already compressed.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

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

  // Store a file and return its hash. Hashes first so already-stored content costs one read and no write;
  // new content is then hashed again while it is (maybe) gzipped into a flushed temp file and renamed.
  // ponytail: new content is read twice; fine up to the 50 MB limit, single-pass if big files get slow.
  async function put(file, within) {
    const first = await hashFile(file, within);
    if (await has(first)) return first;
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, crypto.randomUUID() + TEMP_SUFFIX);
    const gzipped = !PRECOMPRESSED.has(path.extname(file).toLowerCase());
    const hash = crypto.createHash('sha256');
    try {
      await readStable(file, within, (stream) => pipeline(
        stream,
        hashTap(hash),
        ...(gzipped ? [zlib.createGzip()] : []),
        fs.createWriteStream(tmp, { flags: 'wx', flush: true }),
      ));
      const digest = hash.digest('hex');
      if (digest !== first) throw changed(file, 'modified between reads');
      if (!(await has(digest))) {
        const dest = objectPath(digest, gzipped);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        try { await fsp.rename(tmp, dest); } catch (e) { if (!(await has(digest))) throw e; }
      }
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

  return { put, has, extract, copyOut, usage, objects, remove, cleanTemp };
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
async function writeFileAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
  try {
    await fsp.writeFile(tmp, text, { flag: 'wx', flush: true });
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

module.exports = {
  createStore, hashFile, readStable, removeStaleTemp, writeFileAtomic, isInside, CHANGED, TEMP_SUFFIX,
};
