const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createJournal, createStore, hashFile, TRIGGERS } = require('../engine');
const { tempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve with the first event matching pred, or fail after timeoutMs.
function waitFor(emitter, event, pred = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.off(event, on); reject(new Error(`timed out waiting for ${event}`)); }, timeoutMs);
    function on(x) { if (pred(x)) { clearTimeout(t); emitter.off(event, on); resolve(x); } }
    emitter.on(event, on);
  });
}

// A protected folder with a few files, plus a data folder outside it.
function setup(files = { 'a.txt': 'A', 'docs/b.txt': 'B' }) {
  const base = tempDir();
  const root = path.join(base, 'project');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const dataDir = path.join(base, 'data');
  return { base, root, dataDir, store: createStore(path.join(dataDir, 'store')) };
}

// Short timings so tests run fast. Callers must stop() the journal.
function journalFor({ root, dataDir, store }, extra = {}) {
  const j = createJournal({ root, dataDir, store, quietMs: 600, debounceMs: 50, writeFinishMs: 100, ...extra });
  j.on('warning', (e) => { throw e; });
  return j;
}

test('initial capture stores every file, builds the index and reports progress', async () => {
  const s = setup({ 'a.txt': 'A', 'docs/b.txt': 'B', 'docs/deep/c.txt': 'C' });
  const j = journalFor(s);
  const progress = [];
  j.on('progress', (p) => progress.push(p));
  await j.start();
  try {
    const idx = j.getIndex();
    for (const f of ['a.txt', 'docs/b.txt', 'docs/deep/c.txt']) {
      assert.strictEqual(idx[f].hash, await hashFile(path.join(s.root, f)));
      assert.ok(await s.store.has(idx[f].hash));
    }
    assert.strictEqual(idx.docs.type, 'directory');
    assert.deepStrictEqual(progress.at(-1), { phase: 'done', found: 5, toHash: 3, hashed: 3 });
    assert.deepStrictEqual(await j.listSavePoints(), []);
  } finally { await j.stop(); }
});

test('an edited file is captured: new content stored, index updated, change emitted', async () => {
  const s = setup();
  const j = journalFor(s);
  await j.start();
  try {
    const oldHash = j.getIndex()['a.txt'].hash;
    const changed = waitFor(j, 'change', (c) => c.path === 'a.txt');
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'A, edited');
    assert.deepStrictEqual(await changed, { path: 'a.txt', type: 'changed' });
    const newHash = j.getIndex()['a.txt'].hash;
    assert.strictEqual(newHash, await hashFile(path.join(s.root, 'a.txt')));
    assert.notStrictEqual(newHash, oldHash);
    assert.ok(await s.store.has(newHash));
    assert.ok(await s.store.has(oldHash), 'old version is still stored');

    const deleted = waitFor(j, 'change', (c) => c.path === 'docs/b.txt');
    fs.rmSync(path.join(s.root, 'docs/b.txt'));
    assert.deepStrictEqual(await deleted, { path: 'docs/b.txt', type: 'deleted' });
    assert.strictEqual(j.getIndex()['docs/b.txt'], undefined);
  } finally { await j.stop(); }
});

test('a save point scans first, so it is accurate even before the watcher reports', async () => {
  const s = setup();
  const j = journalFor(s, { writeFinishMs: 5000 }); // watcher is slow to report
  await j.start();
  try {
    fs.writeFileSync(path.join(s.root, 'new.txt'), 'just written');
    const sp = await j.createSavePoint({ label: 'checkpoint', trigger: 'agent', agent: 'claude' });
    assert.deepStrictEqual(
      { label: sp.label, trigger: sp.trigger, agent: sp.agent },
      { label: 'checkpoint', trigger: 'agent', agent: 'claude' },
    );
    const full = await j.getSavePoint(sp.id);
    assert.strictEqual(full.index['new.txt'].hash, await hashFile(path.join(s.root, 'new.txt')));
    await assert.rejects(j.getSavePoint('../index'), /invalid save point id/);
  } finally { await j.stop(); }
});

test('save point triggers are exactly the six allowed values', async () => {
  assert.deepStrictEqual(TRIGGERS, ['manual', 'brief', 'activity', 'agent', 'hook', 'before-undo']);
  const s = setup();
  const j = journalFor(s);
  await j.start();
  try {
    for (const trigger of TRIGGERS) assert.strictEqual((await j.createSavePoint({ trigger })).trigger, trigger);
    assert.deepStrictEqual((await j.listSavePoints()).map((sp) => sp.trigger), TRIGGERS);
    for (const bad of ['agent-hook', 'Manual', 'whenever', '', null, 42]) {
      await assert.rejects(j.createSavePoint({ trigger: bad }), /unknown trigger/, String(bad));
    }
    assert.strictEqual((await j.listSavePoints()).length, TRIGGERS.length);
  } finally { await j.stop(); }
});

test('save points and the index survive a restart', async () => {
  const s = setup();
  const j1 = journalFor(s);
  await j1.start();
  const sp = await j1.createSavePoint({ label: 'before refactor' });
  const index = j1.getIndex();
  await j1.stop();

  const j2 = journalFor(s);
  await j2.start();
  try {
    assert.deepStrictEqual(await j2.listSavePoints(), [sp]);
    assert.deepStrictEqual((await j2.getSavePoint(sp.id)).index, index);
    assert.deepStrictEqual(j2.getIndex(), index);
  } finally { await j2.stop(); }
});

test('activity save point holds the index from just before changes start after quiet', async () => {
  const s = setup();
  const j = journalFor(s); // quietMs 600
  await j.start();
  try {
    const before = j.getIndex();
    const sp = waitFor(j, 'savepoint');
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'agent was here');
    const meta = await sp;
    assert.strictEqual(meta.trigger, 'activity');
    assert.deepStrictEqual((await j.getSavePoint(meta.id)).index, before);

    // More changes during the same burst: no new save point.
    const second = waitFor(j, 'change', (c) => c.path === 'docs/b.txt');
    fs.writeFileSync(path.join(s.root, 'docs/b.txt'), 'and here');
    await second;
    assert.strictEqual((await j.listSavePoints()).length, 1);

    // After quiet, a new burst gets its own save point of the index just before it.
    await sleep(700);
    const mid = j.getIndex();
    const sp2 = waitFor(j, 'savepoint');
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'second burst');
    assert.deepStrictEqual((await j.getSavePoint((await sp2).id)).index, mid);
    assert.strictEqual((await j.listSavePoints()).length, 2);
  } finally { await j.stop(); }
});

test('while restoring, the index updates but no activity save point is made', async () => {
  const s = setup();
  const j = journalFor(s);
  await j.start();
  try {
    await j.setRestoring(true);
    const changed = waitFor(j, 'change', (c) => c.path === 'a.txt');
    fs.writeFileSync(path.join(s.root, 'a.txt'), 'restored content');
    await changed;
    assert.strictEqual(j.getIndex()['a.txt'].hash, await hashFile(path.join(s.root, 'a.txt')));
    fs.writeFileSync(path.join(s.root, 'docs/b.txt'), 'restored too'); // not yet seen by the watcher
    await j.setRestoring(false); // absorbs it while still flagged
    assert.strictEqual(j.getIndex()['docs/b.txt'].hash, await hashFile(path.join(s.root, 'docs/b.txt')));
    await sleep(300); // let the late watcher event arrive
    assert.deepStrictEqual(await j.listSavePoints(), []);
  } finally { await j.stop(); }
});

test('catch-up scan on restart picks up changes made while closed', async () => {
  const s = setup();
  const j1 = journalFor(s);
  await j1.start();
  const closedIndex = j1.getIndex();
  await j1.stop();

  fs.writeFileSync(path.join(s.root, 'a.txt'), 'edited while closed');
  fs.rmSync(path.join(s.root, 'docs/b.txt'));
  fs.writeFileSync(path.join(s.root, 'new.txt'), 'added while closed');

  const j2 = journalFor(s);
  const changes = [];
  j2.on('change', (c) => changes.push(c));
  await j2.start();
  try {
    const idx = j2.getIndex();
    assert.strictEqual(idx['a.txt'].hash, await hashFile(path.join(s.root, 'a.txt')));
    assert.strictEqual(idx['docs/b.txt'], undefined);
    assert.ok(await s.store.has(idx['new.txt'].hash));
    assert.deepStrictEqual(changes.sort((a, b) => a.path.localeCompare(b.path)), [
      { path: 'a.txt', type: 'changed' },
      { path: 'docs/b.txt', type: 'deleted' },
      { path: 'new.txt', type: 'added' },
    ]);
    // The state from before Mewndo was closed is kept as a save point.
    const [sp] = await j2.listSavePoints();
    assert.strictEqual(sp.trigger, 'activity');
    assert.deepStrictEqual((await j2.getSavePoint(sp.id)).index, closedIndex);
  } finally { await j2.stop(); }
});

test('two protected folders keep independent histories', async () => {
  const a = setup({ 'a.txt': 'folder A' });
  const b = { ...a, root: path.join(a.base, 'other') };
  fs.mkdirSync(b.root);
  fs.writeFileSync(path.join(b.root, 'b.txt'), 'folder B');
  const ja = journalFor(a);
  const jb = journalFor(b);
  await Promise.all([ja.start(), jb.start()]);
  try {
    const bIndex = jb.getIndex();
    const bChanges = [];
    jb.on('change', (c) => bChanges.push(c));

    const changed = waitFor(ja, 'change');
    fs.writeFileSync(path.join(a.root, 'a.txt'), 'A edited');
    await changed;
    const sp = await ja.createSavePoint({ label: 'A only' });
    await sleep(200);

    assert.deepStrictEqual(Object.keys(ja.getIndex()), ['a.txt']);
    assert.deepStrictEqual(jb.getIndex(), bIndex);
    assert.deepStrictEqual(bChanges, []);
    assert.ok((await ja.listSavePoints()).some((x) => x.id === sp.id));
    assert.deepStrictEqual(await jb.listSavePoints(), []);
  } finally { await Promise.all([ja.stop(), jb.stop()]); }
});

test('refuses a data folder inside the protected folder', async () => {
  const s = setup();
  const j = createJournal({ root: s.root, dataDir: path.join(s.root, 'mewndo-data'), store: s.store });
  await assert.rejects(j.start(), /must not be inside a protected folder/);
});

test('ignored folders do not trigger changes', async () => {
  const s = setup({ 'a.txt': 'A', 'node_modules/x/index.js': 'x' });
  const j = journalFor(s);
  const changes = [];
  j.on('change', (c) => changes.push(c));
  await j.start();
  try {
    assert.ok(!Object.keys(j.getIndex()).some((k) => k.startsWith('node_modules')));
    fs.writeFileSync(path.join(s.root, 'node_modules/x/index.js'), 'changed');
    fs.writeFileSync(path.join(s.root, 'node_modules/new.js'), 'new');
    await sleep(400);
    assert.deepStrictEqual(changes, []);
  } finally { await j.stop(); }
});
