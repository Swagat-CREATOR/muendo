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

// O_NOFOLLOW refuses to open a symlink on Linux/macOS.
// ponytail: Windows has no O_NOFOLLOW; we lstat right before opening, tiny race remains.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function hashTap(hash) {
  return new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
}

async function assertRegularFile(file) {
  if (!(await fsp.lstat(file)).isFile()) throw new Error(`not a regular file: ${file}`);
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function hashFile(file) {
  await assertRegularFile(file);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { flags: READ_FLAGS })) hash.update(chunk);
  return hash.digest('hex');
}

function createStore(dir) {
  const objects = path.join(dir, 'objects');
  const tmpDir = path.join(dir, 'tmp');

  function objectPath(hash, gzipped) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid hash: ${hash}`);
    return path.join(objects, hash.slice(0, 2), gzipped ? `${hash}.gz` : hash);
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

  // Store a file and return its hash. One read pass: hash and (maybe) gzip into a temp file, then rename.
  async function put(file) {
    await assertRegularFile(file);
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, crypto.randomUUID());
    const gzipped = !PRECOMPRESSED.has(path.extname(file).toLowerCase());
    const hash = crypto.createHash('sha256');
    try {
      await pipeline(
        fs.createReadStream(file, { flags: READ_FLAGS }),
        hashTap(hash),
        ...(gzipped ? [zlib.createGzip()] : []),
        fs.createWriteStream(tmp, { flags: 'wx', flush: true }),
      );
      const digest = hash.digest('hex');
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

  // Copy stored content to dest via temp file + rename. Verifies the hash. Never overwrites an existing dest:
  // the caller moves the old file to Muendo's trash first.
  async function copyOut(hash, dest) {
    const src = await find(hash);
    if (!src) throw new Error(`not stored: ${hash}`);
    if (await exists(dest)) throw new Error(`destination exists: ${dest}`);
    const tmp = `${dest}.${crypto.randomUUID()}.muendo-tmp`;
    const check = crypto.createHash('sha256');
    try {
      await pipeline(
        fs.createReadStream(src.path),
        ...(src.gzipped ? [zlib.createGunzip()] : []),
        hashTap(check),
        fs.createWriteStream(tmp, { flags: 'wx', flush: true }),
      );
      if (check.digest('hex') !== hash) throw new Error(`stored content is corrupt: ${hash}`);
      // ponytail: check-then-rename has a tiny race; fs.link would be atomic but fails on FAT/exFAT drives.
      if (await exists(dest)) throw new Error(`destination exists: ${dest}`);
      await fsp.rename(tmp, dest);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  // Total bytes on disk used by stored content.
  async function usage() {
    if (!(await exists(objects))) return 0;
    let total = 0;
    for (const e of await fsp.readdir(objects, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) total += (await fsp.lstat(path.join(e.parentPath, e.name))).size;
    }
    return total;
  }

  return { put, has, copyOut, usage };
}

module.exports = { createStore, hashFile };
