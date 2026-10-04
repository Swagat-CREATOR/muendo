const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { scan, createStore, hashFile } = require('../engine');
const { tempDir, linkDir } = require('./helpers');

// root/
//   a.txt, docs/b.txt, docs/deep/c.txt   nested files
//   empty/                                empty folder
//   node_modules/pkg/index.js             ignored
//   .git/HEAD                             included
//   huge.bin (2000 bytes, limit 1000)     skipped as too large
//   outside-link -> ../outside            recorded, never followed
function makeTree() {
  const base = tempDir();
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  const w = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  w('a.txt', 'A');
  w('docs/b.txt', 'BB');
  w('docs/deep/c.txt', 'CCC');
  w('node_modules/pkg/index.js', 'ignored');
  w('.git/HEAD', 'ref: refs/heads/main\n');
  w('huge.bin', Buffer.alloc(2000, 1));
  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret', 'x.txt'), 'outside');
  linkDir(outside, path.join(root, 'outside-link'));
  return { base, root, outside };
}

const opts = { maxFileSize: 1000 };

test('manifest records files, folders and links correctly', async () => {
  const { root, outside } = makeTree();
  const m = await scan(root, opts);

  assert.deepStrictEqual(Object.keys(m).sort(), [
    '.git', '.git/HEAD', 'a.txt', 'docs', 'docs/b.txt', 'docs/deep', 'docs/deep/c.txt',
    'empty', 'huge.bin', 'outside-link',
  ]);
  for (const d of ['.git', 'docs', 'docs/deep', 'empty']) assert.deepStrictEqual(m[d], { type: 'directory' });

  for (const f of ['a.txt', 'docs/b.txt', 'docs/deep/c.txt', '.git/HEAD']) {
    const st = fs.lstatSync(path.join(root, f));
    assert.deepStrictEqual(m[f], {
      type: 'file', size: st.size, mtimeMs: st.mtimeMs, hash: await hashFile(path.join(root, f)),
    });
  }

  assert.strictEqual(m['huge.bin'].skipped, 'too-large');
  assert.strictEqual(m['huge.bin'].size, 2000);
  assert.strictEqual(m['huge.bin'].hash, undefined);

  assert.strictEqual(m['outside-link'].type, 'link');
  assert.strictEqual(path.resolve(m['outside-link'].target.replace(/^\\\\\?\\/, '')), path.resolve(outside));
  assert.ok(!Object.keys(m).some((k) => k.includes('secret')), 'link must not be followed');
  assert.ok(!Object.keys(m).some((k) => k.startsWith('node_modules')), 'node_modules must be skipped');
});

test('only files with changed size or mtime are rehashed', async () => {
  const { root } = makeTree();
  const hashed = [];
  const spy = (f) => { hashed.push(path.relative(root, f).split(path.sep).join('/')); return hashFile(f); };

  const first = await scan(root, { ...opts, hash: spy });
  assert.strictEqual(hashed.length, 4);

  hashed.length = 0;
  const second = await scan(root, { ...opts, previous: first, hash: spy });
  assert.deepStrictEqual(hashed, []);
  assert.deepStrictEqual(second, first);

  fs.writeFileSync(path.join(root, 'docs/b.txt'), 'changed');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later); // same size, new mtime
  const third = await scan(root, { ...opts, previous: second, hash: spy });
  assert.deepStrictEqual(hashed.sort(), ['a.txt', 'docs/b.txt']);
  assert.notStrictEqual(third['docs/b.txt'].hash, first['docs/b.txt'].hash);
  assert.strictEqual(third['a.txt'].hash, first['a.txt'].hash);
});

test('limits concurrent hashing and reports progress', async () => {
  const root = tempDir();
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), String(i));
  let active = 0;
  let peak = 0;
  const slow = async (f) => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return hashFile(f);
  };
  const events = [];
  await scan(root, { concurrency: 3, hash: slow, onProgress: (p) => events.push(p) });

  assert.strictEqual(peak, 3);
  assert.deepStrictEqual(events.at(-1), { phase: 'done', found: 20, toHash: 20, hashed: 20 });
  const hashing = events.filter((e) => e.phase === 'hashing').map((e) => e.hashed);
  assert.deepStrictEqual(hashing, Array.from({ length: 21 }, (_, i) => i));
});

test('a store can hash and store in one pass; stored content matches byte for byte', async () => {
  const { base, root } = makeTree();
  const store = createStore(path.join(base, 'data'));
  const m = await scan(root, { ...opts, hash: store.put });
  for (const [rel, e] of Object.entries(m)) {
    if (e.type !== 'file' || e.skipped) continue;
    const out = path.join(base, 'restored', rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await store.copyOut(e.hash, out);
    assert.ok(fs.readFileSync(out).equals(fs.readFileSync(path.join(root, rel))), rel);
  }
});

test('custom ignore list and missing root', async () => {
  const { root } = makeTree();
  const m = await scan(root, { ...opts, ignore: ['docs'] });
  assert.ok(m['node_modules/pkg/index.js']);
  assert.ok(!m.docs);
  await assert.rejects(scan(path.join(root, 'nope')), { code: 'ENOENT' });
});

test('a file that changes while being read is recorded as skipped, not hashed', async () => {
  const { root } = makeTree();
  const target = path.join(root, 'a.txt');
  const racy = (f, within) => {
    if (f === target) {
      // Simulate an agent swapping the file for a link between the walk and the read.
      fs.rmSync(f);
      fs.symlinkSync(path.join(root, 'docs/b.txt'), f);
    }
    return hashFile(f, within);
  };
  const m = await scan(root, { ...opts, hash: racy });
  assert.strictEqual(m['a.txt'].skipped, 'changed-while-reading');
  assert.strictEqual(m['a.txt'].hash, undefined);
  assert.ok(m['docs/b.txt'].hash);
});

test('online-only cloud files (size but no disk space) are recorded as skipped, never opened', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'local.txt'), 'x'.repeat(10_000));
  fs.writeFileSync(path.join(root, 'tiny.txt'), 'small files can use no blocks of their own');
  fs.closeSync(fs.openSync(path.join(root, 'cloud.docx'), 'w'));
  fs.truncateSync(path.join(root, 'cloud.docx'), 1_000_000); // sparse: has a size, takes no space, like a placeholder
  if (fs.lstatSync(path.join(root, 'cloud.docx')).blocks !== 0) return; // filesystem without sparse files
  const opened = [];
  const m = await scan(root, { skipOnlineOnly: true, hash: (f) => { opened.push(path.basename(f)); return hashFile(f); } });
  assert.strictEqual(m['cloud.docx'].skipped, 'online-only');
  assert.strictEqual(m['cloud.docx'].hash, undefined);
  assert.deepStrictEqual(opened.sort(), ['local.txt', 'tiny.txt']);
  assert.ok(m['local.txt'].hash && m['tiny.txt'].hash);
});
