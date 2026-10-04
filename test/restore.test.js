const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createJournal, createStore } = require('../engine');
const { tempDir, linkDir } = require('./helpers');

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

// Protected folder `project` with files, data folder `data` beside it. Callers must stop() the journal.
async function setup(files) {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  const dataDir = path.join(base, 'data');
  const opts = { root, dataDir, store: createStore(path.join(dataDir, 'store')), debounceMs: 50, writeFinishMs: 100 };
  const journal = createJournal(opts);
  journal.on('warning', (e) => { throw e; });
  await journal.start();
  return { base, root, dataDir, opts, journal };
}

const FILES = { 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C', 'docs/d.md': 'D', 'docs/deep/e.md': 'E' };

test('restores deletes, edits and renames, and keeps modified times', async () => {
  const { root, journal } = await setup(FILES);
  try {
    const original = { ...journal.getIndex() };
    const sp = await journal.createSavePoint({ label: 'clean' });

    fs.rmSync(path.join(root, 'a.txt'));
    fs.writeFileSync(path.join(root, 'b.txt'), 'B edited by agent');
    write(root, 'lib/new/c-renamed.txt', 'C');
    fs.rmSync(path.join(root, 'c.txt'));
    fs.rmSync(path.join(root, 'docs/deep'), { recursive: true });

    const plan = await journal.planRestore(sp.id);
    assert.deepStrictEqual(plan.write, ['a.txt', 'b.txt', 'c.txt', 'docs/deep/e.md']);
    assert.deepStrictEqual(plan.overwrites, ['b.txt']);
    assert.deepStrictEqual(plan.trash, ['lib/new/c-renamed.txt']);
    assert.deepStrictEqual(plan.mkdirs, ['docs/deep']);
    assert.deepStrictEqual(plan.rmdirs, ['lib/new', 'lib']);

    const result = await journal.restore(sp.id);
    assert.strictEqual(result.verified, true, JSON.stringify(result));
    assert.deepStrictEqual(result.failures, []);
    assert.deepStrictEqual(result.counts, { written: 4, linked: 0, trashed: 1, foldersCreated: 1, foldersRemoved: 2 });
    for (const [rel, content] of Object.entries(FILES)) assert.strictEqual(read(root, rel), content, rel);
    assert.ok(!exists(path.join(root, 'lib')));
    for (const rel of Object.keys(FILES)) {
      assert.ok(Math.abs(fs.lstatSync(path.join(root, rel)).mtimeMs - original[rel].mtimeMs) < 1, `mtime ${rel}`);
    }

    // The edited version is in the trash, and the state before the restore is a save point.
    assert.strictEqual(fs.readFileSync(path.join(result.trashFolder, 'b.txt'), 'utf8'), 'B edited by agent');
    const before = await journal.getSavePoint(result.beforeUndoId);
    assert.strictEqual(before.trigger, 'before-undo');
    assert.ok(before.index['lib/new/c-renamed.txt']);
    assert.ok(!fs.readdirSync(root).some((n) => n.endsWith('.mewndo-tmp')));

    // The restore's own writes don't create an activity save point: before-undo stays the newest.
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual((await journal.listSavePoints()).at(-1).id, result.beforeUndoId);
  } finally { await journal.stop(); }
});

test('restores only the selected files or folders', async () => {
  const { root, journal } = await setup(FILES);
  try {
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'a.txt'), 'A edited');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B edited');
    fs.writeFileSync(path.join(root, 'docs/d.md'), 'D edited');
    write(root, 'docs/new.md', 'new in docs');
    write(root, 'new.txt', 'new at top');
    fs.rmSync(path.join(root, 'docs/deep'), { recursive: true });

    const r1 = await journal.restore(sp.id, { paths: ['a.txt'] });
    assert.strictEqual(r1.verified, true);
    assert.strictEqual(read(root, 'a.txt'), 'A');
    assert.strictEqual(read(root, 'b.txt'), 'B edited');

    const r2 = await journal.restore(sp.id, { paths: ['docs'] });
    assert.strictEqual(r2.verified, true);
    assert.strictEqual(read(root, 'docs/d.md'), 'D');
    assert.strictEqual(read(root, 'docs/deep/e.md'), 'E');
    assert.ok(!exists(path.join(root, 'docs/new.md')));
    assert.strictEqual(read(root, 'new.txt'), 'new at top');
    assert.strictEqual(read(root, 'b.txt'), 'B edited');

    // A selected file whose folder was deleted gets its folder back.
    fs.rmSync(path.join(root, 'docs'), { recursive: true });
    const r3 = await journal.restore(sp.id, { paths: ['docs/deep/e.md'] });
    assert.strictEqual(r3.verified, true);
    assert.strictEqual(read(root, 'docs/deep/e.md'), 'E');
    assert.ok(!exists(path.join(root, 'docs/d.md')));

    await assert.rejects(journal.restore(sp.id, { paths: ['../outside'] }), /invalid path/);
  } finally { await journal.stop(); }
});

test('restores into a separate folder without touching the protected one', async () => {
  const { base, root, journal } = await setup(FILES);
  try {
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'a.txt'), 'A edited');
    write(root, 'new.txt', 'new');
    fs.mkdirSync(path.join(root, 'empty-later'));

    const into = path.join(base, 'recovered');
    const result = await journal.restore(sp.id, { into });
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.beforeUndoId, null);
    for (const [rel, content] of Object.entries(FILES)) assert.strictEqual(read(into, rel), content);
    assert.ok(!exists(path.join(into, 'new.txt')));

    assert.strictEqual(read(root, 'a.txt'), 'A edited');
    assert.strictEqual(read(root, 'new.txt'), 'new');
    assert.ok(!(await journal.listSavePoints()).some((s) => s.trigger === 'before-undo'));

    await assert.rejects(journal.restore(sp.id, { into }), /new or empty/);
    await assert.rejects(journal.restore(sp.id, { into: path.join(root, 'inside') }), /outside the protected folder/);
  } finally { await journal.stop(); }
});

test('new files go to the trash, keeping their relative path', async () => {
  const { root, journal } = await setup({ 'a.txt': 'A' });
  try {
    const sp = await journal.createSavePoint();
    write(root, 'agent/notes/plan.md', 'agent notes');
    write(root, 'b.txt', 'agent file');
    const result = await journal.restore(sp.id);
    assert.strictEqual(result.verified, true);
    assert.deepStrictEqual(fs.readdirSync(root), ['a.txt']);
    assert.ok(result.trashFolder.includes(path.join('trash', 'Restored')));
    assert.ok(!result.trashFolder.startsWith(root));
    assert.strictEqual(fs.readFileSync(path.join(result.trashFolder, 'agent/notes/plan.md'), 'utf8'), 'agent notes');
    assert.strictEqual(fs.readFileSync(path.join(result.trashFolder, 'b.txt'), 'utf8'), 'agent file');
  } finally { await journal.stop(); }
});

test('a removed link is recreated as a link, and a link replaced by a file is restored', async () => {
  const { base, root, journal } = await setup({ 'a.txt': 'A' });
  try {
    const outside = path.join(base, 'shared');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'x.txt'), 'outside');
    linkDir(outside, path.join(root, 'shared-link'));
    linkDir(outside, path.join(root, 'other-link'));
    const sp = await journal.createSavePoint();
    const target = journal.getIndex()['shared-link'].target;

    fs.unlinkSync(path.join(root, 'shared-link'));
    fs.unlinkSync(path.join(root, 'other-link'));
    fs.writeFileSync(path.join(root, 'other-link'), 'a file where a link was');

    const result = await journal.restore(sp.id);
    assert.strictEqual(result.verified, true, JSON.stringify(result));
    assert.strictEqual(result.counts.linked, 2);
    for (const l of ['shared-link', 'other-link']) {
      assert.ok(fs.lstatSync(path.join(root, l)).isSymbolicLink(), l);
      assert.strictEqual(fs.readlinkSync(path.join(root, l)), target);
    }
    assert.strictEqual(fs.readFileSync(path.join(result.trashFolder, 'other-link'), 'utf8'), 'a file where a link was');
    assert.strictEqual(read(outside, 'x.txt'), 'outside'); // never touched the link's target
  } finally { await journal.stop(); }
});

test('an interrupted restore is finished at next start, and can then be undone', async () => {
  const { root, opts, journal } = await setup(FILES);
  const sp = await journal.createSavePoint({ label: 'good state' });
  fs.rmSync(path.join(root, 'a.txt'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'B edited');
  write(root, 'new.txt', 'new');
  const edited = { ...(await journal.sync()) };
  await assert.rejects(journal.restore(sp.id, { crashAfterSteps: 1 }), /simulated crash/); // only new.txt trashed
  write(root, `a.txt.12345678-1234-1234-1234-123456789abc.mewndo-tmp`, 'half-written');
  await journal.stop();

  // "Next launch"
  const j2 = createJournal(opts);
  const restored = [];
  j2.on('restored', (r) => restored.push(r));
  await j2.start();
  try {
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].resumed, true);
    assert.strictEqual(restored[0].verified, true, JSON.stringify(restored[0]));
    for (const [rel, content] of Object.entries(FILES)) assert.strictEqual(read(root, rel), content);
    assert.ok(!exists(path.join(root, 'new.txt')));
    assert.ok(!fs.readdirSync(root).some((n) => n.endsWith('.mewndo-tmp')));
    const log = JSON.parse(fs.readFileSync(path.join(j2.folderDir, 'restores', `${restored[0].id}.json`), 'utf8'));
    assert.strictEqual(log.status, 'done');

    // Undo the restore: go back to the before-undo save point.
    const undo = await j2.restore(restored[0].beforeUndoId);
    assert.strictEqual(undo.verified, true);
    assert.ok(!exists(path.join(root, 'a.txt')));
    assert.strictEqual(read(root, 'b.txt'), 'B edited');
    assert.strictEqual(read(root, 'new.txt'), 'new');
    for (const [rel, e] of Object.entries(edited)) {
      if (e.hash) assert.strictEqual(j2.getIndex()[rel]?.hash, e.hash, rel);
    }
  } finally { await j2.stop(); }
});

test('a file that stays locked is reported, not fatal', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { root, journal } = await setup({ 'a.txt': 'A', 'locked/b.txt': 'B' });
  try {
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'a.txt'), 'A edited');
    fs.writeFileSync(path.join(root, 'locked/b.txt'), 'B edited');
    fs.chmodSync(path.join(root, 'locked'), 0o555); // can't rename or create inside: EACCES, like a lock
    let result;
    try { result = await journal.restore(sp.id, { retryDelayMs: 1 }); }
    finally { fs.chmodSync(path.join(root, 'locked'), 0o755); }
    assert.strictEqual(read(root, 'a.txt'), 'A');
    assert.deepStrictEqual(result.failures.map((f) => [f.path, f.error, f.attempts]), [['locked/b.txt', 'EACCES', 5]]);
    assert.deepStrictEqual(result.mismatches, ['locked/b.txt']);
    assert.strictEqual(result.verified, false);
  } finally { await journal.stop(); }
});
