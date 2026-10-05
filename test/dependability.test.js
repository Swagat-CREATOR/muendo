const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createMewndo, createJournal, createStore } = require('../engine');
const { tempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const journalOptions = { debounceMs: 50, writeFinishMs: 100 };
async function until(fn, ms = 5000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(25)) if (await fn()) return true;
  return false;
}

test('a folder that disappears (unplugged drive) is marked unavailable at once, then protected again when it is back', async () => {
  const base = tempDir();
  const root = path.join(base, 'drive', 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  // A long check interval: the journal itself must notice the folder going away.
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions, availabilityCheckMs: 2000 });
  const warnings = [];
  const resolvedEvents = [];
  mewndo.on('warning', (w) => warnings.push(w));
  mewndo.on('resolved', (r) => resolvedEvents.push(r));
  const journal = await mewndo.protect(root);
  await mewndo.start();
  try {
    const real = fs.realpathSync(root);
    fs.rmSync(path.join(base, 'drive'), { recursive: true }); // the drive goes away (Windows won't rename a watched folder)
    assert.ok(await until(() => mewndo.folders()[0].status === 'unavailable', 1500), 'marked unavailable before the periodic check');
    await sleep(300);
    assert.deepStrictEqual(warnings.map((w) => w.code), ['folder-unavailable'], 'one clear warning, no flood of errors');
    assert.match(warnings[0].message, /can't be found/);
    assert.ok((await journal.listSavePoints()) !== null, 'save points are still readable');

    fs.mkdirSync(root, { recursive: true }); // and comes back, with a file changed while it was away
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'b.txt'), 'changed while away');
    assert.ok(await until(() => mewndo.folders()[0].status === 'protected', 6000), 'protected again');
    assert.match(resolvedEvents.find((r) => r.code === 'folder-unavailable').message, /is back/);
    assert.ok(journal.getIndex()['b.txt'], 'caught up on changes made while it was away');
    assert.strictEqual(journal.root, real);
  } finally { await mewndo.stop(); }
});

test('a folder missing at launch is listed as unavailable, can still be restored elsewhere, and resumes when back', async () => {
  const base = tempDir();
  const root = path.join(base, 'drive', 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  const dataDir = path.join(base, 'data');
  const first = createMewndo({ dataDir, journalOptions });
  const j1 = await first.protect(root);
  const sp = await j1.createSavePoint({ label: 'kept' });
  await first.stop();
  fs.renameSync(path.join(base, 'drive'), path.join(base, 'unplugged'));

  const mewndo = createMewndo({ dataDir, journalOptions, availabilityCheckMs: 100 });
  const warnings = [];
  mewndo.on('warning', (w) => warnings.push(w));
  await mewndo.start();
  try {
    assert.deepStrictEqual(mewndo.folders().map((f) => [f.status, f.files]), [['unavailable', 1]]);
    assert.ok(warnings.some((w) => w.code === 'folder-unavailable'));
    const journal = mewndo.journals()[0];
    assert.deepStrictEqual((await journal.listSavePoints()).map((s) => s.label), ['kept']);
    const copy = await journal.restore(sp.id, { into: path.join(base, 'recovered') });
    assert.strictEqual(copy.verified, true);
    assert.strictEqual(fs.readFileSync(path.join(base, 'recovered', 'a.txt'), 'utf8'), 'A');

    fs.renameSync(path.join(base, 'unplugged'), path.join(base, 'drive'));
    assert.ok(await until(() => mewndo.folders()[0].status === 'protected'), 'resumed once back');
  } finally { await mewndo.stop(); }
});

test('a watcher that fails is reported and restarted, and changes after the restart are captured', async () => {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  // Catch the native watcher so the test can make it fail.
  const realWatch = fs.watch;
  const watchers = [];
  fs.watch = (...args) => { const w = realWatch(...args); watchers.push(w); return w; };
  const journal = createJournal({ root, dataDir: path.join(base, 'data'), store: createStore(path.join(base, 'data', 'store')), watcher: 'native', ...journalOptions });
  const events = [];
  journal.on('watcher-error', (e) => events.push(`error ${e.code}`));
  journal.on('watcher-restarted', () => events.push('restarted'));
  try {
    await journal.start();
    watchers.at(-1).emit('error', Object.assign(new Error('watcher broke'), { code: 'EMFILE' }));
    assert.ok(await until(() => events.includes('restarted'), 6000), JSON.stringify(events));
    assert.deepStrictEqual(events, ['error EMFILE', 'restarted']);
    fs.writeFileSync(path.join(root, 'b.txt'), 'after the restart');
    assert.ok(await until(() => journal.getIndex()['b.txt']), 'the new watcher works');
  } finally {
    fs.watch = realWatch;
    await journal.stop();
  }
});

test('low disk space warns once, not on every check', async () => {
  const base = tempDir();
  fs.mkdirSync(path.join(base, 'p'));
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions, lowDiskBytes: Number.MAX_SAFE_INTEGER });
  const warnings = [];
  mewndo.on('warning', (w) => warnings.push(w.code));
  try {
    await mewndo.protect(path.join(base, 'p'));
    await mewndo.prune();
    await mewndo.prune();
    assert.deepStrictEqual(warnings.filter((c) => c === 'low-disk').length, 1);
  } finally { await mewndo.stop(); }
});

test('after an unclean shutdown, damaged and missing recent objects are found and the files saved again', async () => {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, `${n}.txt`), `content ${n}`);
  const dataDir = path.join(base, 'data');
  const first = createMewndo({ dataDir, journalOptions });
  await first.protect(root);
  await first.start();
  const index = first.journals()[0].getIndex();
  // Simulate a power cut: no clean stop (the running marker stays), one object damaged, one never reached disk.
  const objectFile = (h) => ['', '.gz'].map((ext) => path.join(dataDir, 'store', 'objects', h.slice(0, 2), h + ext)).find((f) => fs.existsSync(f));
  fs.writeFileSync(objectFile(index['a.txt'].hash), '');
  fs.rmSync(objectFile(index['b.txt'].hash));
  for (const j of first.journals()) await j.stop(); // let go of the folder, but don't stop Mewndo cleanly
  assert.ok(fs.existsSync(path.join(dataDir, 'running.json')));

  const again = createMewndo({ dataDir, journalOptions });
  const events = [];
  again.on('recovered', (r) => events.push(r));
  again.on('warning', (w) => events.push(w.code));
  await again.start();
  try {
    assert.deepStrictEqual(events.slice(0, 2), [{ damaged: 1, dropped: 2 }, 'unclean-shutdown']);
    while (again.folders()[0]?.status !== 'protected') await sleep(20);
    const j = again.journals()[0];
    const sp = await j.createSavePoint();
    const copy = await j.restore(sp.id, { into: path.join(base, 'copy') });
    assert.strictEqual(copy.verified, true, 'both files were stored again from disk');
    assert.strictEqual(fs.readFileSync(path.join(base, 'copy', 'a.txt'), 'utf8'), 'content a');
  } finally { await again.stop(); }
  assert.ok(!fs.existsSync(path.join(dataDir, 'running.json')), 'a clean stop removes the marker');

  const third = createMewndo({ dataDir, journalOptions });
  const later = [];
  third.on('recovered', (r) => later.push(r));
  await third.start();
  await third.stop();
  assert.deepStrictEqual(later, [], 'nothing to check after a clean stop');
});
