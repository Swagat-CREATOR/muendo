// The Rust content store (core/src/store.rs) and the v0 Node one (engine/store.js) share one format: each reads
// what the other wrote, and both name objects the same way. Uses the real mewndo-core binary, as core.test.js does.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { createStore } = require('../engine');
const { tempDir } = require('./helpers');

const BINARY = path.join(__dirname, '..', '..', '..', 'core', 'target', 'debug', process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core');
const skip = fs.existsSync(BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nothing = { info() {}, warn() {}, error() {} };

// Names that decide gzip or not, including the edge cases of how each language finds an extension.
const FILES = {
  'notes.txt': Buffer.from('hello mewndo '.repeat(500)),
  'photo.png': Buffer.from('pretend png bytes'),
  'PHOTO2.JPG': Buffer.from('pretend jpeg bytes'),
  'archive.tar.gz': Buffer.from('pretend gzip bytes'),
  'big.bin': crypto.randomBytes(3 * 1024 * 1024 + 7), // over 1 MB: read twice, streamed
  'empty.txt': Buffer.alloc(0),
  '.env': Buffer.from('KEY=not-a-real-secret'),
  Makefile: Buffer.from('all:\n\techo hi\n'),
  'trailing.': Buffer.from('a name ending in a dot'),
};

// At the top level: tempDir() removes its folder when the context that made it ends.
const base = tempDir();
const src = path.join(base, 'src');
fs.mkdirSync(src);
for (const [name, bytes] of Object.entries(FILES)) fs.writeFileSync(path.join(src, name), bytes);

let core;
before(async () => {
  if (skip) return;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: BINARY, runDir: base, logDir: path.join(base, 'logs'), log: nothing,
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
});
after(() => core?.stop());

// Every object file, relative to objects/: what the format looks like on disk.
const objectNames = (store) => fs.readdirSync(path.join(store, 'objects'), { recursive: true }).filter((f) => f.length > 3).map((f) => f.replaceAll('\\', '/')).sort();

test('Rust reads a store written by the v0 Node engine', { skip }, async () => {
  const dir = path.join(base, 'node-store');
  const node = createStore(dir);
  for (const [name, bytes] of Object.entries(FILES)) {
    const hash = await node.put(path.join(src, name));
    assert.strictEqual(hash, sha(bytes));
    const has = await core.request('store_has', { store: dir, hash });
    assert.deepStrictEqual({ type: has.type, stored: has.stored }, { type: 'has', stored: true });
    const out = path.join(base, `from-node-${name}`);
    await core.request('store_copy_out', { store: dir, hash, dest: out }, { within: 30_000 });
    assert.ok(fs.readFileSync(out).equals(bytes), `${name} comes back byte for byte`);
  }
  assert.strictEqual((await core.request('store_has', { store: dir, hash: '0'.repeat(64) })).stored, false);

  // Rust checks what it reads: a damaged v0 object is refused and nothing is left behind.
  const hash = sha(FILES['notes.txt']);
  fs.writeFileSync(path.join(dir, 'objects', hash.slice(0, 2), `${hash}.gz`), 'not gzip any more');
  await assert.rejects(core.request('store_copy_out', { store: dir, hash, dest: path.join(base, 'damaged.txt') }), /corrupt/);
  assert.ok(!fs.readdirSync(base).some((n) => n.startsWith('damaged.txt')));
});

test('the v0 Node engine reads a store written by Rust, and both name objects the same way', { skip }, async () => {
  const rustDir = path.join(base, 'rust-store');
  const names = Object.keys(FILES);
  const reply = await core.request('store_put', {
    store: rustDir, files: names.map((n) => path.join(src, n)), within: fs.realpathSync(src),
  }, { within: 60_000 });
  assert.deepStrictEqual(reply.results, names.map((n) => ({ hash: sha(FILES[n]) })));

  const node = createStore(rustDir);
  for (const name of names) {
    const hash = sha(FILES[name]);
    assert.ok(await node.has(hash), `${name} is in the store`);
    const out = path.join(base, `from-rust-${name}`);
    await node.copyOut(hash, out); // gunzips and verifies the hash
    assert.ok(fs.readFileSync(out).equals(FILES[name]), `${name} comes back byte for byte`);
  }
  assert.deepStrictEqual(await node.verifySince(0), [], 'every Rust-written object passes v0 verification');
  assert.strictEqual((await node.hashes()).size, names.length);
  assert.deepStrictEqual(fs.readdirSync(path.join(rustDir, 'tmp')), [], 'no temp files left');

  const nodeDir = path.join(base, 'node-store-2');
  const v0 = createStore(nodeDir);
  for (const name of names) await v0.put(path.join(src, name));
  assert.deepStrictEqual(objectNames(rustDir), objectNames(nodeDir), 'same object files, same .gz choices');
});

test('Rust refuses files outside the protected folder and files that are links, per file', { skip }, async () => {
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'not protected');
  const files = [path.join(src, 'notes.txt'), outside, path.join(src, 'missing.txt')];
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(src, 'notes.txt'), path.join(src, 'link.txt'));
    files.push(path.join(src, 'link.txt'));
  }
  const { results } = await core.request('store_put', { store: path.join(base, 'refusals'), files, within: fs.realpathSync(src) }, { within: 30_000 });
  assert.deepStrictEqual(results[0], { hash: sha(FILES['notes.txt']) });
  assert.strictEqual(results[1].code, 'changed');
  assert.match(results[1].error, /outside protected folder/);
  assert.strictEqual(results[2].code, 'not_found');
  if (results[3]) assert.strictEqual(results[3].code, 'changed');
  fs.rmSync(path.join(src, 'link.txt'), { force: true });
});

test('Rust keeps v0 temp files and their startup cleanup: stale ones go, recent ones and objects stay', { skip }, async () => {
  const dir = path.join(base, 'with-temp');
  const node = createStore(dir);
  const hash = await node.put(path.join(src, 'notes.txt'));
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const stale = path.join(tmp, 'left-by-a-crash.mewndo-tmp');
  const recent = path.join(tmp, 'still-being-written.mewndo-tmp');
  const other = path.join(tmp, 'not-ours.txt');
  for (const f of [stale, recent, other]) fs.writeFileSync(f, 'x');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const f of [stale, other]) fs.utimesSync(f, old, old);

  assert.strictEqual((await core.request('store_has', { store: dir, hash })).stored, true); // first use: cleanup
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(recent) && fs.existsSync(other));
  assert.ok(await node.has(hash));
});
