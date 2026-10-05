const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createMewndo, folderSize } = require('../engine');
const { tempDir, linkDir } = require('./helpers');

const journalOptions = { debounceMs: 50, writeFinishMs: 100 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function folder(base, name, files) {
  const root = path.join(base, name);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

test('folderSize counts files with the ignore rules, never enters links, stops early', async () => {
  const base = tempDir();
  const outside = folder(base, 'outside', { 'big.bin': Buffer.alloc(5000) });
  const root = folder(base, 'root', { 'a.txt': 'x'.repeat(100), 'sub/b.txt': 'x'.repeat(50), 'node_modules/m.js': 'x'.repeat(999) });
  linkDir(outside, path.join(root, 'link'));
  assert.deepStrictEqual(await folderSize(root), { bytes: 150, files: 2, over: false });
  assert.strictEqual((await folderSize(root, { stopAboveBytes: 120 })).over, true);
});

test('refuses folders containing Mewndo data, overlapping protected folders, or over the size limit', async () => {
  const base = tempDir();
  const dataDir = path.join(base, 'home', 'AppData', 'Mewndo');
  fs.mkdirSync(dataDir, { recursive: true });
  const mewndo = createMewndo({ dataDir, journalOptions, maxFolderBytes: 1000 });
  try {
    await assert.rejects(mewndo.protect(path.join(base, 'home')), /contains Mewndo's own data folder/);
    await assert.rejects(mewndo.protect(dataDir), /contains Mewndo's own data folder/);
    const project = folder(base, 'project', { 'src/a.txt': 'small' });
    await mewndo.protect(project);
    await assert.rejects(mewndo.protect(project), /already protected/);
    await assert.rejects(mewndo.protect(path.join(project, 'src')), /overlaps/);
    await assert.rejects(mewndo.protect(base), /overlaps|contains Mewndo/);
    const big = folder(base, 'big', { 'huge.bin': Buffer.alloc(2000) });
    await assert.rejects(mewndo.protect(big), /larger than/);
    assert.deepStrictEqual(mewndo.folders().map((f) => f.root), [fs.realpathSync(project)]);
  } finally { await mewndo.stop(); }
});

test('background protect shows the folder while its first scan runs, with progress', async () => {
  const base = tempDir();
  const files = {};
  for (let i = 0; i < 300; i++) files[`d${i % 10}/f${i}.txt`] = `file ${i}`;
  const root = folder(base, 'project', files);
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions });
  const progress = [];
  mewndo.on('progress', (r, p) => progress.push([r, p.phase]));
  try {
    await mewndo.protect(root, { background: true });
    assert.deepStrictEqual(mewndo.folders().map((f) => f.status), ['scanning']);
    while (mewndo.folders()[0].status === 'scanning') await sleep(20);
    assert.deepStrictEqual(mewndo.folders()[0], { root: fs.realpathSync(root), status: 'protected', files: 300, lastChangeAt: null });
    assert.ok(progress.some(([r, phase]) => r === fs.realpathSync(root) && phase === 'hashing'));
    assert.ok(progress.some(([, phase]) => phase === 'done'));
  } finally { await mewndo.stop(); }
});

test('pause stops recording for a while, then catches up on what changed', async () => {
  const base = tempDir();
  const root = folder(base, 'project', { 'a.txt': 'A' });
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions });
  try {
    const journal = await mewndo.protect(root);
    await mewndo.pauseProtection(300);
    assert.strictEqual(mewndo.folders()[0].status, 'paused');
    assert.ok(mewndo.pausedUntil() > Date.now());
    fs.writeFileSync(path.join(root, 'b.txt'), 'made while paused');
    await sleep(250);
    assert.strictEqual(journal.getIndex()['b.txt'], undefined, 'not recorded while paused');
    const sp = await journal.createSavePoint(); // save points still work while paused
    assert.ok(sp.id);
    while (mewndo.pausedUntil() || mewndo.folders()[0].status !== 'protected') await sleep(20);
    assert.ok(journal.getIndex()['b.txt'], 'caught up after the pause');
    const changed = new Promise((r) => mewndo.once('change', (root2, c) => r(c)));
    fs.writeFileSync(path.join(root, 'c.txt'), 'watched again');
    assert.deepStrictEqual(await changed, { path: 'c.txt', type: 'added' });
  } finally { await mewndo.stop(); }
});

test('restores are listed newest first; storage is reported per folder', async () => {
  const base = tempDir();
  const root = folder(base, 'project', { 'a.txt': 'A' });
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions });
  try {
    const journal = await mewndo.protect(root);
    const sp = await journal.createSavePoint();
    fs.writeFileSync(path.join(root, 'a.txt'), 'edited');
    const first = await journal.restore(sp.id);
    const second = await journal.restore(first.beforeUndoId); // undo the restore
    const list = await journal.listRestores();
    assert.deepStrictEqual(list.map((r) => r.id), [second.id, first.id]);
    assert.strictEqual(list[0].status, 'done');
    assert.strictEqual(list[0].result.verified, true);
    assert.strictEqual(list[1].beforeUndoId, first.beforeUndoId);
    assert.strictEqual(list[0].steps, undefined);

    const report = await mewndo.storageReport();
    assert.deepStrictEqual(report.folders.map((f) => f.folder), [journal.root]);
    assert.ok(report.folders[0].bytes > 0 && report.folders[0].savePoints >= 3);
  } finally { await mewndo.stop(); }
});

test('stopping during a first scan cancels it quickly, keeps the folder protected, and the next start finishes it', async () => {
  const base = tempDir();
  const files = {};
  for (let i = 0; i < 3000; i++) files[`d${i % 30}/f${i}.txt`] = `file ${i}`;
  const root = folder(base, 'project', files);
  const dataDir = path.join(base, 'data');
  const mewndo = createMewndo({ dataDir, journalOptions });
  await mewndo.protect(root, { background: true });
  while (!mewndo.folders()[0]?.files && mewndo.folders()[0]?.status === 'scanning') await sleep(20);
  await sleep(300); // well into hashing
  const t = Date.now();
  await mewndo.stop();
  assert.ok(Date.now() - t < 3000, `stop took ${Date.now() - t} ms`);

  const again = createMewndo({ dataDir, journalOptions });
  await again.start();
  try {
    assert.deepStrictEqual(again.folders().map((f) => f.root), [fs.realpathSync(root)], 'still protected');
    while (again.folders()[0].status === 'scanning') await sleep(50);
    assert.strictEqual(again.folders()[0].files, 3000);
  } finally { await again.stop(); }
});

test('a folder can be unprotected while its first scan is still running', async () => {
  const base = tempDir();
  const files = {};
  for (let i = 0; i < 2000; i++) files[`d${i % 20}/f${i}.txt`] = `file ${i}`;
  const root = folder(base, 'project', files);
  const dataDir = path.join(base, 'data');
  const mewndo = createMewndo({ dataDir, journalOptions });
  try {
    await mewndo.protect(root, { background: true });
    await sleep(300);
    assert.strictEqual(mewndo.folders()[0].status, 'scanning');
    const t = Date.now();
    await mewndo.unprotect(root, { keepHistory: true });
    assert.ok(Date.now() - t < 3000, `unprotect took ${Date.now() - t} ms`);
    assert.deepStrictEqual(mewndo.folders(), []);
  } finally { await mewndo.stop(); }
  const again = createMewndo({ dataDir, journalOptions });
  await again.start();
  try {
    assert.deepStrictEqual(again.folders(), [], 'stays unprotected after a restart');
  } finally { await again.stop(); }
});

test('folders report when their files last changed', async () => {
  const base = tempDir();
  const root = folder(base, 'project', { 'a.txt': 'A' });
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions });
  try {
    const journal = await mewndo.protect(root);
    assert.strictEqual(mewndo.folders()[0].lastChangeAt, null);
    const before = Date.now();
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    await journal.sync();
    assert.ok(mewndo.folders()[0].lastChangeAt >= before);
  } finally { await mewndo.stop(); }
});
