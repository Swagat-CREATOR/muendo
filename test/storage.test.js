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

test('never prunes the newest or anything from the last 24 hours, even past retention', async () => {
  const { root, clock, mewndo, journal } = await setup({ retentionDays: 0 });
  try {
    await version(journal, root, 'a.txt', 'old', { trigger: 'agent' });
    const newest = await version(journal, root, 'a.txt', 'newest', { trigger: 'agent' });
    assert.deepStrictEqual(ids(await mewndo.prune()), [], 'everything is under 24 hours old');
    clock.now += 100 * DAY;
    await mewndo.prune();
    assert.deepStrictEqual((await journal.listSavePoints()).map((s) => s.id), [newest.sp.id]);
  } finally { await mewndo.stop(); }
});

test('manual, brief and before-undo save points last the full retention period, then go', async () => {
  const { root, clock, mewndo, journal } = await setup({ retentionDays: 10, budgetBytes: 1 });
  try {
    const manual = await version(journal, root, 'a.txt', 'manual', { trigger: 'manual' });
    const brief = await version(journal, root, 'a.txt', 'brief', { trigger: 'brief' });
    const undo = await version(journal, root, 'a.txt', 'before undo', { trigger: 'before-undo' });
    const agent = await version(journal, root, 'a.txt', 'agent', { trigger: 'agent' });
    const newest = await version(journal, root, 'a.txt', 'newest', { trigger: 'hook' });

    clock.now += 9 * DAY; // within retention, and over budget
    const r1 = await mewndo.prune();
    for (const kept of [manual, brief, undo, newest]) assert.ok(!ids(r1).includes(kept.sp.id), kept.sp.trigger);
    assert.ok(ids(r1).includes(agent.sp.id), 'agent save point removed for the budget');

    clock.now += 2 * DAY; // past retention
    const r2 = await mewndo.prune();
    for (const gone of [manual, brief, undo]) assert.ok(ids(r2).includes(gone.sp.id), gone.sp.trigger);
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

test('over budget: removes activity, agent and hook save points oldest first, never protected ones', async () => {
  const big = () => crypto.randomBytes(200 * 1024); // incompressible, ~200 KB stored
  const { root, clock, mewndo, journal, warnings } = await setup({ retentionDays: 30, budgetBytes: 650 * 1024 });
  try {
    const manual = await version(journal, root, 'big.bin', big(), { trigger: 'manual' }); // oldest, but protected
    const agent = await version(journal, root, 'big.bin', big(), { trigger: 'agent' });
    const hook = await version(journal, root, 'big.bin', big(), { trigger: 'hook' });
    const activity = await version(journal, root, 'big.bin', big(), { trigger: 'activity' });
    const newest = await version(journal, root, 'big.bin', big(), { trigger: 'agent' });
    clock.now += 2 * DAY; // past the 24-hour protection, well within retention

    const result = await mewndo.prune();
    assert.ok(!ids(result).includes(manual.sp.id), 'manual kept though oldest');
    assert.ok(ids(result).includes(agent.sp.id) && ids(result).includes(hook.sp.id), 'oldest unprotected removed');
    assert.ok(!ids(result).includes(activity.sp.id) && !ids(result).includes(newest.sp.id), 'stopped once under budget');
    assert.ok(!(await mewndo.store.has(agent.hash)) && !(await mewndo.store.has(hook.hash)));
    assert.ok(await mewndo.store.has(manual.hash));
    assert.ok(result.usedBytes <= 650 * 1024 && !result.overBudget, String(result.usedBytes));
    assert.deepStrictEqual(warnings, []);
  } finally { await mewndo.stop(); }
});

test("budget that can't be met: warns, and keeps every protected save point", async () => {
  const { root, clock, mewndo, journal, warnings } = await setup({ budgetBytes: 1 });
  try {
    const kept = [];
    for (const trigger of ['manual', 'brief', 'before-undo']) kept.push(await version(journal, root, 'a.txt', trigger, { trigger }));
    const agent = await version(journal, root, 'a.txt', 'agent', { trigger: 'agent' });
    const newest = await version(journal, root, 'a.txt', 'newest', { trigger: 'hook' });
    clock.now += 2 * DAY;
    const result = await mewndo.prune();
    assert.strictEqual(result.overBudget, true);
    assert.ok(ids(result).includes(agent.sp.id));
    const left = (await journal.listSavePoints()).map((s) => s.id);
    assert.deepStrictEqual(left, [...kept, newest].map((v) => v.sp.id));
    const w = warnings.filter((x) => x.code === 'over-budget');
    assert.strictEqual(w.length, 1);
    assert.match(w[0].message, /can't be met/);
  } finally { await mewndo.stop(); }
});

test('trash: reported per folder and separately from the budget, emptied only when asked', async () => {
  const { base, root, clock, mewndo, journal } = await setup({ files: { 'a.txt': 'A' } });
  try {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'never touched');
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'junk.txt'), 'x'.repeat(1000));
    fs.symlinkSync(outside, path.join(root, 'junk-link'), 'junction');
    await journal.restore(sp.id);

    const [entry] = await mewndo.trashReport();
    assert.strictEqual(entry.folder, journal.root);
    assert.strictEqual(entry.items, 2);
    assert.ok(entry.bytes >= 1000);
    const report = await mewndo.storageReport();
    assert.strictEqual(report.trashBytes, entry.bytes);
    assert.ok(report.usedBytes > 0 && report.freeDiskBytes > 0);
    const usedBefore = report.usedBytes;

    clock.now += 365 * DAY;
    await mewndo.prune(); // pruning never touches the trash
    assert.strictEqual((await mewndo.trashReport())[0].bytes, entry.bytes);

    assert.deepStrictEqual((await mewndo.emptyTrash({ olderThanDays: 400 })).removed, [], 'nothing that old');
    await assert.rejects(mewndo.emptyTrash({}), /olderThanDays/);
    const emptied = await mewndo.emptyTrash({ olderThanDays: 30, folder: root });
    assert.strictEqual(emptied.removed.length, 1);
    assert.strictEqual(emptied.removedBytes, entry.bytes);
    assert.strictEqual((await mewndo.trashReport())[0].bytes, 0);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'never touched', 'link not followed');
    assert.ok((await mewndo.storageReport()).usedBytes <= usedBefore);
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

test('a folder protected while pruning runs never loses content to the sweep', async () => {
  const { base, mewndo, journal } = await setup();
  try {
    // Content nothing refers to yet: the sweep would delete it.
    const orphan = path.join(base, 'orphan.txt');
    fs.writeFileSync(orphan, 'shared content');
    const hash = await mewndo.store.put(orphan);

    // Hold the new folder's scan right after it stores (dedups) the content and before it writes its index:
    // the window in which pruning can't see the new reference.
    let stored;
    const putDone = new Promise((r) => { stored = r; });
    let release;
    const gate = new Promise((r) => { release = r; });
    const realPut = mewndo.store.put;
    mewndo.store.put = async (...args) => { const h = await realPut(...args); stored(); await gate; return h; };

    const resume = await journal.pause(); // prune waits for this journal
    const pruned = mewndo.prune();
    const otherRoot = path.join(base, 'other');
    fs.mkdirSync(otherRoot);
    fs.writeFileSync(path.join(otherRoot, 'copy.txt'), 'shared content');
    await mewndo.protect(otherRoot, { background: true });
    await putDone;
    resume();
    await pruned; // sweeps while the new folder's index is not yet written
    release();
    while (mewndo.folders().some((f) => f.status === 'scanning')) await new Promise((r) => setTimeout(r, 20));
    mewndo.store.put = realPut;

    const other = mewndo.journals().find((j) => j.root === fs.realpathSync(otherRoot));
    assert.strictEqual(other.getIndex()['copy.txt'].hash, hash);
    assert.ok(await mewndo.store.has(hash), 'content referenced by the new folder must survive the prune');
  } finally { await mewndo.stop(); }
});
