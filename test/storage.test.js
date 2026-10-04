const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMewndo, hashFile } = require('../engine');
const { tempDir } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;
// quietMs huge: at most one activity save point per test, so tests control what exists.
const journalOptions = { debounceMs: 50, writeFinishMs: 100, quietMs: Number.MAX_SAFE_INTEGER };

// A Mewndo instance with a controllable clock and one protected folder. Callers must stop() it.
async function setup({ files = { 'a.txt': 'A' }, retentionDays, ...opts } = {}) {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
  const clock = { now: Date.now() };
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), now: () => clock.now, journalOptions, ...opts });
  const warnings = [];
  mewndo.on('warning', (w) => warnings.push(w));
  const journal = await mewndo.protect(root, { retentionDays });
  return { base, root, clock, mewndo, journal, warnings };
}

// Change file `name`, then make a save point. Returns the save point and the hash of that version.
async function version(journal, root, name, content, opts) {
  fs.writeFileSync(path.join(root, name), content);
  const hash = await hashFile(path.join(root, name));
  return { sp: await journal.createSavePoint(opts), hash };
}

const ids = (result) => result.pruned.map((p) => p.id);

test('retention prunes save points older than the period, oldest first, keeping the newest', async () => {
  const { root, clock, mewndo, journal } = await setup({ retentionDays: 30 });
  try {
    const v1 = await version(journal, root, 'a.txt', 'v1');
    const v2 = await version(journal, root, 'a.txt', 'v2');
    const v3 = await version(journal, root, 'a.txt', 'v3');

    clock.now += 10 * DAY;
    assert.deepStrictEqual(ids(await mewndo.prune()), [], 'nothing older than 30 days yet');

    clock.now += 30 * DAY;
    const result = await mewndo.prune();
    const all = (await journal.listSavePoints()).map((s) => s.id);
    assert.deepStrictEqual(all, [v3.sp.id], 'only the newest survives');
    assert.ok(ids(result).includes(v1.sp.id) && ids(result).includes(v2.sp.id));
    const created = result.pruned.map((p) => p.createdAt);
    assert.deepStrictEqual(created, [...created].sort(), 'oldest first');
  } finally { await mewndo.stop(); }
});

test('never prunes the newest, anything from the last 24 hours, or recent before-undo save points', async () => {
  const { root, clock, mewndo, journal } = await setup({ retentionDays: 0 });
  try {
    const old = await version(journal, root, 'a.txt', 'old');
    const undo = await version(journal, root, 'a.txt', 'before undo', { trigger: 'before-undo' });
    const newest = await version(journal, root, 'a.txt', 'newest');

    assert.deepStrictEqual(ids(await mewndo.prune()), [], 'everything is under 24 hours old');

    clock.now += 3 * DAY;
    const r1 = await mewndo.prune();
    assert.ok(ids(r1).includes(old.sp.id));
    assert.ok(!ids(r1).includes(undo.sp.id), 'before-undo kept for 7 days');
    assert.ok(!ids(r1).includes(newest.sp.id), 'newest always kept');

    clock.now += 5 * DAY;
    const r2 = await mewndo.prune();
    assert.deepStrictEqual(ids(r2), [undo.sp.id], 'before-undo pruned after 7 days');
    assert.deepStrictEqual((await journal.listSavePoints()).map((s) => s.id), [newest.sp.id]);
  } finally { await mewndo.stop(); }
});

test('deletes stored content nothing refers to, keeps what any save point or index uses', async () => {
  const { base, root, clock, mewndo, journal } = await setup({ retentionDays: 1 });
  const otherRoot = path.join(base, 'other');
  fs.mkdirSync(otherRoot);
  fs.writeFileSync(path.join(otherRoot, 'shared.txt'), 'shared v1'); // same content as v1 below
  const other = await mewndo.protect(otherRoot);
  try {
    const v1 = await version(journal, root, 'a.txt', 'shared v1');
    const v2 = await version(journal, root, 'a.txt', 'only in an old save point');
    const v3 = await version(journal, root, 'a.txt', 'in the newest save point');
    fs.writeFileSync(path.join(root, 'a.txt'), 'current');
    await journal.sync();
    const current = await hashFile(path.join(root, 'a.txt'));
    const orphan = path.join(base, 'orphan.bin');
    fs.writeFileSync(orphan, crypto.randomBytes(100));
    const orphanHash = await mewndo.store.put(orphan);

    clock.now += 3 * DAY;
    const result = await mewndo.prune();
    assert.ok(ids(result).includes(v2.sp.id));
    assert.ok(!(await mewndo.store.has(v2.hash)), 'content only an old save point used is gone');
    assert.ok(!(await mewndo.store.has(orphanHash)), 'content nothing ever used is gone');
    assert.ok(await mewndo.store.has(v1.hash), "still in the other folder's index");
    assert.ok(await mewndo.store.has(v3.hash), 'still in the newest save point');
    assert.ok(await mewndo.store.has(current), 'still in the current index');
    assert.ok(result.removedObjects >= 2);
    assert.strictEqual(other.getIndex()['shared.txt'].hash, v1.hash);
  } finally { await mewndo.stop(); }
});

test('over budget: prunes further, oldest first, within the protections', async () => {
  const big = () => crypto.randomBytes(200 * 1024); // incompressible, ~200 KB stored
  const { root, clock, mewndo, journal, warnings } = await setup({ retentionDays: 30, budgetBytes: 520 * 1024 });
  try {
    const v = [];
    for (let i = 0; i < 4; i++) v.push(await version(journal, root, 'big.bin', big()));
    clock.now += 2 * DAY; // past the 24-hour protection, well within retention

    const result = await mewndo.prune();
    assert.ok(ids(result).includes(v[0].sp.id) && ids(result).includes(v[1].sp.id), 'two oldest pruned');
    assert.ok(!ids(result).includes(v[2].sp.id) && !ids(result).includes(v[3].sp.id), 'stopped once under budget');
    assert.ok(!(await mewndo.store.has(v[0].hash)) && !(await mewndo.store.has(v[1].hash)));
    assert.ok(result.usedBytes <= 520 * 1024 && !result.overBudget);
    assert.deepStrictEqual(warnings, []);
  } finally { await mewndo.stop(); }
});

test('still over budget after pruning everything allowed: warns and keeps protected save points', async () => {
  const { root, clock, mewndo, journal, warnings } = await setup({ budgetBytes: 1 });
  try {
    await version(journal, root, 'a.txt', 'one');
    const undo = await version(journal, root, 'a.txt', 'two', { trigger: 'before-undo' });
    const newest = await version(journal, root, 'a.txt', 'three');
    clock.now += 2 * DAY;
    const result = await mewndo.prune();
    assert.strictEqual(result.overBudget, true);
    const left = (await journal.listSavePoints()).map((s) => s.id);
    assert.deepStrictEqual(left, [undo.sp.id, newest.sp.id]);
    assert.strictEqual(warnings.filter((w) => w.code === 'over-budget').length, 1);
    assert.match(warnings[0].message, /budget/);
  } finally { await mewndo.stop(); }
});

test('warns when the disk is low on space', async () => {
  const { mewndo, warnings } = await setup({ lowDiskBytes: Number.MAX_SAFE_INTEGER });
  try {
    await mewndo.prune();
    const w = warnings.find((x) => x.code === 'low-disk');
    assert.ok(w && w.freeBytes > 0, JSON.stringify(warnings));
  } finally { await mewndo.stop(); }
});

test('prunes at startup and again on schedule', async () => {
  const { base, root, clock, mewndo, journal } = await setup({ retentionDays: 1 });
  const old = await version(journal, root, 'a.txt', 'old');
  const newest = await version(journal, root, 'a.txt', 'new');
  await mewndo.stop();

  clock.now += 3 * DAY;
  const again = createMewndo({ dataDir: path.join(base, 'data'), now: () => clock.now, journalOptions, pruneEveryMs: 100 });
  const runs = [];
  again.on('pruned', (r) => runs.push(r));
  await again.start();
  try {
    assert.ok(ids(runs[0]).includes(old.sp.id), 'pruned at startup');
    assert.deepStrictEqual((await again.journals()[0].listSavePoints()).map((s) => s.id), [newest.sp.id]);
    assert.strictEqual(again.journals().length, 1, 'remembered the protected folder');
    await new Promise((r) => setTimeout(r, 350));
    assert.ok(runs.length >= 3, `scheduled runs: ${runs.length}`);
  } finally { await again.stop(); }
});

test('stop protecting a folder, keeping its history', async () => {
  const { base, root, mewndo, journal } = await setup();
  const sp = await journal.createSavePoint();
  const dir = journal.folderDir;
  await mewndo.unprotect(root, { keepHistory: true });
  assert.deepStrictEqual(mewndo.journals(), []);
  assert.ok(fs.existsSync(path.join(dir, 'savepoints', `${sp.id}.json`)));
  await mewndo.stop();

  const again = createMewndo({ dataDir: path.join(base, 'data'), journalOptions });
  await again.start();
  try {
    assert.deepStrictEqual(again.journals(), [], 'not protected after restart');
    const hash = JSON.parse(fs.readFileSync(path.join(dir, 'savepoints', `${sp.id}.json`), 'utf8')).index['a.txt'].hash;
    assert.ok(await again.store.has(hash), 'kept history still has its content');
    const j = await again.protect(root);
    assert.deepStrictEqual((await j.listSavePoints()).map((s) => s.id), [sp.id], 'history is back when protected again');
  } finally { await again.stop(); }
});

test('stop protecting a folder, deleting its history but never its trash', async () => {
  const { root, mewndo, journal } = await setup({ files: { 'a.txt': 'unique to this folder' } });
  try {
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'new.txt'), 'goes to trash on restore');
    const restored = await journal.restore(sp.id);
    const hash = journal.getIndex()['a.txt'].hash;
    const dir = journal.folderDir;

    await mewndo.unprotect(root, { keepHistory: false });
    assert.deepStrictEqual(fs.readdirSync(dir), ['trash']);
    assert.strictEqual(fs.readFileSync(path.join(restored.trashFolder, 'new.txt'), 'utf8'), 'goes to trash on restore');
    assert.ok(!(await mewndo.store.has(hash)), 'content only this folder used is gone');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'unique to this folder', 'the folder itself is untouched');
    await assert.rejects(mewndo.unprotect(root), /not protected/);
  } finally { await mewndo.stop(); }
});
