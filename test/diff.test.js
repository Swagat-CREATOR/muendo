const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { scan, compare, createJournal, createStore } = require('../engine');
const { tempDir, linkDir } = require('./helpers');

function folder(files) {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return { base, root };
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

test('every kind of change, including a move into a new subfolder and a removed link', async () => {
  const { base, root } = folder({
    'keep.txt': 'unchanged',
    'gone.txt': 'will be deleted',
    'edit.txt': 'v1',
    'rename-me.txt': 'moved in place',
    'src/old.js': 'moved into a new subfolder',
  });
  fs.mkdirSync(path.join(base, 'elsewhere'));
  fs.mkdirSync(path.join(base, 'other'));
  linkDir(path.join(base, 'elsewhere'), path.join(root, 'link-removed'));
  linkDir(path.join(base, 'elsewhere'), path.join(root, 'link-retargeted'));
  const before = await scan(root);

  fs.rmSync(path.join(root, 'gone.txt'));
  fs.writeFileSync(path.join(root, 'edit.txt'), 'v2');
  fs.renameSync(path.join(root, 'rename-me.txt'), path.join(root, 'renamed.txt'));
  fs.mkdirSync(path.join(root, 'lib/new'), { recursive: true });
  fs.renameSync(path.join(root, 'src/old.js'), path.join(root, 'lib/new/old.js'));
  fs.unlinkSync(path.join(root, 'link-removed'));
  fs.unlinkSync(path.join(root, 'link-retargeted'));
  linkDir(path.join(base, 'other'), path.join(root, 'link-retargeted'));
  write(root, 'fresh.txt', 'brand new');
  write(root, 'docs/fresh.md', 'also new');
  const after = await scan(root);

  const d = compare(before, after);
  assert.deepStrictEqual(d.deleted, ['gone.txt', 'link-removed']);
  assert.deepStrictEqual(d.edited, ['edit.txt', 'link-retargeted']);
  assert.deepStrictEqual(d.moved, [
    { from: 'rename-me.txt', to: 'renamed.txt' },
    { from: 'src/old.js', to: 'lib/new/old.js' },
  ]);
  assert.deepStrictEqual(d.created, ['docs/fresh.md', 'fresh.txt']);
  assert.deepStrictEqual(d.totals, { deleted: 2, edited: 2, moved: 2, created: 2 });
  assert.strictEqual(d.summary, 'Since this save point, 2 deleted, 2 edited, 2 moved, 2 created.');
});

test('touching a file without changing it is not an edit', async () => {
  const { root } = folder({ 'a.txt': 'same' });
  const before = await scan(root);
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later);
  const d = compare(before, await scan(root, { previous: before }));
  assert.deepStrictEqual(d.totals, { deleted: 0, edited: 0, moved: 0, created: 0 });
  assert.strictEqual(d.summary, 'Since this save point, nothing changed.');
});

test('each created file can be the target of only one move', () => {
  const f = (hash) => ({ type: 'file', size: 1, mtimeMs: 1, hash });
  const before = { 'a.txt': f('h1'), 'b.txt': f('h1'), 'c.txt': f('h2') };
  const after = { 'x.txt': f('h1'), 'c.txt': f('h3') };
  const d = compare(before, after);
  assert.deepStrictEqual(d.moved, [{ from: 'a.txt', to: 'x.txt' }]);
  assert.deepStrictEqual(d.deleted, ['b.txt']);
  assert.deepStrictEqual(d.edited, ['c.txt']);
  assert.deepStrictEqual(d.created, []);
});

test('folders are not listed; a file replaced by a folder is a deletion', () => {
  const before = { 'a': { type: 'file', size: 1, mtimeMs: 1, hash: 'h1' }, 'old': { type: 'directory' } };
  const after = { 'a': { type: 'directory' }, 'new': { type: 'directory' } };
  const d = compare(before, after);
  assert.deepStrictEqual(d.deleted, ['a']);
  assert.deepStrictEqual([d.edited, d.moved, d.created], [[], [], []]);
});

test('journal.diffSince compares a save point with the folder right now', async () => {
  const { base, root } = folder({ 'a.txt': 'A', 'b.txt': 'B' });
  const dataDir = path.join(base, 'data');
  const j = createJournal({
    root, dataDir, store: createStore(path.join(dataDir, 'store')), debounceMs: 50, writeFinishMs: 5000,
  });
  await j.start();
  try {
    const sp = await j.createSavePoint({ label: 'before agent' });
    fs.rmSync(path.join(root, 'a.txt'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'B edited');
    write(root, 'c.txt', 'C');
    const d = await j.diffSince(sp.id); // watcher hasn't reported yet; diffSince scans first
    assert.strictEqual(d.summary, 'Since this save point, 1 deleted, 1 edited, 0 moved, 1 created.');
    await assert.rejects(j.diffSince('00000000-0000-0000-0000-000000000000'), /no such save point/);
  } finally { await j.stop(); }
});
