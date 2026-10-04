const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore, hashFile } = require('../engine');
const { tempDir } = require('./helpers');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const objectFiles = (dir) => fs.readdirSync(path.join(dir, 'objects'), { recursive: true }).filter((f) => f.length > 3);

test('put returns the SHA-256 and copyOut restores byte for byte', async () => {
  const dir = tempDir();
  const store = createStore(path.join(dir, 'data'));
  const content = crypto.randomBytes(3 * 1024 * 1024 + 7); // spans many stream chunks
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, content);

  const hash = await store.put(file);
  assert.strictEqual(hash, sha(content));
  assert.strictEqual(await hashFile(file), hash);
  assert.ok(await store.has(hash));
  assert.ok(!(await store.has('0'.repeat(64))));

  const out = path.join(dir, 'out.bin');
  await store.copyOut(hash, out);
  assert.ok(fs.readFileSync(out).equals(content));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('muendo-tmp')), []);
});

test('identical content is stored once', async () => {
  const dir = tempDir();
  const store = createStore(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'same');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'same');
  const h1 = await store.put(path.join(dir, 'a.txt'));
  const used = await store.usage();
  const h2 = await store.put(path.join(dir, 'b.txt'));
  assert.strictEqual(h1, h2);
  assert.strictEqual(await store.usage(), used);
  assert.strictEqual(objectFiles(path.join(dir, 'data')).length, 1);
});

test('text is gzipped, already-compressed formats are not', async () => {
  const dir = tempDir();
  const data = path.join(dir, 'data');
  const store = createStore(data);
  const text = 'hello muendo\n'.repeat(10000);
  fs.writeFileSync(path.join(dir, 'notes.txt'), text);
  fs.writeFileSync(path.join(dir, 'photo.PNG'), 'pretend png bytes');
  const t = await store.put(path.join(dir, 'notes.txt'));
  const p = await store.put(path.join(dir, 'photo.PNG'));

  const files = objectFiles(data);
  assert.ok(files.some((f) => f.endsWith(`${t}.gz`)));
  assert.ok(files.some((f) => f.endsWith(p)));
  assert.ok((await store.usage()) < text.length);

  await store.copyOut(t, path.join(dir, 'notes.out'));
  await store.copyOut(p, path.join(dir, 'photo.out'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'notes.out'), 'utf8'), text);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'photo.out'), 'utf8'), 'pretend png bytes');
});

test('copyOut never overwrites an existing file', async () => {
  const dir = tempDir();
  const store = createStore(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'stored');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'user data');
  const hash = await store.put(path.join(dir, 'a.txt'));
  await assert.rejects(store.copyOut(hash, path.join(dir, 'keep.txt')), /destination exists/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'user data');
});

test('copyOut detects corrupt stored content and leaves nothing behind', async () => {
  const dir = tempDir();
  const data = path.join(dir, 'data');
  const store = createStore(data);
  fs.writeFileSync(path.join(dir, 'a.png'), 'original');
  const hash = await store.put(path.join(dir, 'a.png'));
  fs.writeFileSync(path.join(data, 'objects', hash.slice(0, 2), hash), 'tampered');
  await assert.rejects(store.copyOut(hash, path.join(dir, 'out.png')), /corrupt/);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.png', 'data']);
});

test('rejects malformed hashes and refuses to store links', async () => {
  const dir = tempDir();
  const store = createStore(path.join(dir, 'data'));
  await assert.rejects(store.has('../../etc/passwd'), /invalid hash/);
  fs.mkdirSync(path.join(dir, 'target'));
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'junction');
  await assert.rejects(store.put(path.join(dir, 'link')), /not a regular file/);
});

test('usage is 0 for an empty store', async () => {
  assert.strictEqual(await createStore(path.join(tempDir(), 'data')).usage(), 0);
});
