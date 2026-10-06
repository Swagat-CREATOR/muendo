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
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('mewndo-tmp')), []);
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
  const text = 'hello mewndo\n'.repeat(10000);
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

const { readStable, CHANGED, TEMP_SUFFIX } = require('../engine');

// Links: a folder junction, which Windows lets anyone create (file symlinks need admin or Developer Mode there,
// so an agent couldn't make one either). Mewndo's checks are the same for both kinds of link.
test('readStable rejects a file swapped for a link, or for another file, while reading', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.txt');
  const other = path.join(dir, 'other.txt');
  fs.mkdirSync(path.join(dir, 'elsewhere'));
  fs.writeFileSync(file, 'original');
  await assert.rejects(
    readStable(file, null, async (stream) => {
      fs.rmSync(file);
      fs.symlinkSync(path.join(dir, 'elsewhere'), file, 'junction');
      for await (const _ of stream);
    }),
    { code: CHANGED },
  );
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'original');
  fs.writeFileSync(other, 'imposter');
  let refused = false;
  const reading = readStable(file, null, async (stream) => {
    try {
      fs.renameSync(other, file); // same name, different file
    } catch (e) {
      if (process.platform !== 'win32') throw e;
      refused = true; // Windows won't replace a file that is open: the swap can't happen while Mewndo reads
    }
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
  });
  const outcome = await reading.then((text) => ({ text }), (error) => ({ error }));
  if (refused) assert.deepStrictEqual(outcome, { text: 'original' });
  else assert.strictEqual(outcome.error?.code, CHANGED);
});

test('readStable rejects a file modified while reading', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'original');
  await assert.rejects(
    readStable(file, null, async (stream) => {
      fs.appendFileSync(file, ' plus more');
      for await (const _ of stream);
    }),
    { code: CHANGED },
  );
});

test('readStable rejects a path whose real location is outside the protected folder', async () => {
  const dir = tempDir();
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'sneaky'), 'junction');
  const realRoot = fs.realpathSync(root);
  // lstat of root/sneaky/secret.txt sees a regular file; only the realpath check catches it.
  await assert.rejects(hashFile(path.join(root, 'sneaky', 'secret.txt'), realRoot), /outside protected folder/);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
  assert.strictEqual(await hashFile(path.join(root, 'ok.txt'), realRoot), sha(Buffer.from('fine')));
});

test('put stores nothing and leaves no temp file when readStable rejects', async () => {
  const dir = tempDir();
  const data = path.join(dir, 'data');
  const store = createStore(data);
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'a.txt'), 'junction'); // a link where a file is expected
  await assert.rejects(store.put(path.join(dir, 'a.txt')), { code: CHANGED });
  assert.strictEqual(await store.usage(), 0);
  assert.deepStrictEqual(fs.existsSync(path.join(data, 'tmp')) ? fs.readdirSync(path.join(data, 'tmp')) : [], []);
});

test('cleanTemp removes stale temp files only, never objects or recent temps', async () => {
  const dir = tempDir();
  const data = path.join(dir, 'data');
  const store = createStore(data);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'keep me');
  const hash = await store.put(path.join(dir, 'a.txt'));

  const tmp = path.join(data, 'tmp');
  const stale = path.join(tmp, `stale${TEMP_SUFFIX}`);
  const recent = path.join(tmp, `recent${TEMP_SUFFIX}`);
  const notOurs = path.join(tmp, 'stale-but-not-a-temp');
  for (const f of [stale, recent, notOurs]) fs.writeFileSync(f, 'x');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(notOurs, twoHoursAgo, twoHoursAgo);
  const objectPath = path.join(data, 'objects', hash.slice(0, 2), `${hash}.gz`);
  fs.utimesSync(objectPath, twoHoursAgo, twoHoursAgo);

  assert.strictEqual(await store.cleanTemp(), 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(recent));
  assert.ok(fs.existsSync(notOurs));
  assert.ok(fs.existsSync(objectPath));
  await store.copyOut(hash, path.join(dir, 'out.txt'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'keep me');
});

test('cleanTemp on a fresh store is a no-op', async () => {
  assert.strictEqual(await createStore(path.join(tempDir(), 'data')).cleanTemp(), 0);
});

test('holdPuts makes new puts wait until released', async () => {
  const dir = tempDir();
  const store = createStore(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'held');
  const release = await store.holdPuts();
  let done = false;
  const pending = store.put(path.join(dir, 'a.txt')).then((h) => { done = true; return h; });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(done, false, 'put must wait while held');
  release();
  assert.strictEqual(await pending, sha(Buffer.from('held')));
});

// Windows only: hold the target file open the way antivirus does (no sharing), release it after 300 ms.
test('writeFileAtomic waits for a file another program briefly holds open (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const { writeFileAtomic } = require('../engine');
  const dir = tempDir();
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file, 'old');
  const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep -Milliseconds 300; $f.Close()`]);
  await new Promise((resolve) => ps.stdout.once('data', resolve));
  await writeFileAtomic(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  await new Promise((resolve) => (ps.exitCode !== null ? resolve() : ps.once('exit', resolve)));
  assert.deepStrictEqual(fs.readdirSync(dir), ['index.json'], 'no temp file left behind');
});

test('the hot cache keeps small gzipped content uncompressed for a day; remove takes its copy too', async () => {
  const base = tempDir();
  const store = createStore(path.join(base, 'data'));
  fs.writeFileSync(path.join(base, 'notes.txt'), 'hot content');
  fs.writeFileSync(path.join(base, 'photo.png'), 'png bytes');
  const text = await store.put(path.join(base, 'notes.txt'));
  const png = await store.put(path.join(base, 'photo.png'));
  const hot = (h) => path.join(base, 'data', 'hot', h.slice(0, 2), h);
  assert.strictEqual(fs.readFileSync(hot(text), 'utf8'), 'hot content');
  assert.ok(!fs.existsSync(hot(png)), 'already stored as is: no copy needed');
  assert.deepStrictEqual([...(await store.hashes())].sort(), [text, png].sort(), 'not an object of its own');
  assert.strictEqual(await store.cleanHot(), 0, 'kept for a day');
  assert.strictEqual(await store.cleanHot(-1), 1);
  assert.ok(!fs.existsSync(hot(text)));
  assert.ok(await store.has(text), 'the object itself stays');

  fs.writeFileSync(path.join(base, 'other.txt'), 'more');
  const other = await store.put(path.join(base, 'other.txt'));
  await store.remove(other);
  assert.ok(!fs.existsSync(hot(other)));
});
