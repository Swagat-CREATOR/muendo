const { test } = require('node:test');
const assert = require('node:assert');
const { createBurstDetector } = require('../engine/burst');

const many = (n, type) => Array.from({ length: n }, () => ({ type }));

function detector() {
  const clock = { t: 1_000_000 };
  return { clock, d: createBurstDetector({ now: () => clock.t }) };
}

test('20 deletions within a minute alert, 19 do not', () => {
  const { clock, d } = detector();
  assert.strictEqual(d.record(many(19, 'deleted')), null);
  clock.t += 30_000;
  assert.deepStrictEqual(d.record(many(1, 'deleted')), { deleted: 20, changed: 20 });
});

test('50 changes of any kind within a minute alert, 49 do not', () => {
  const { clock, d } = detector();
  assert.strictEqual(d.record([...many(30, 'changed'), ...many(10, 'added'), ...many(9, 'deleted')]), null);
  clock.t += 10_000;
  assert.deepStrictEqual(d.record(many(1, 'added')), { deleted: 9, changed: 50 });
});

test('a steady trickle never alerts: only changes within the same minute count', () => {
  const { clock, d } = detector();
  // 9 deletions every 35 s: any 60 s window holds at most two batches (18), 54 deletions in all.
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(d.record(many(9, 'deleted')), null, `batch ${i}`);
    clock.t += 35_000;
  }
});

test('alerts once per burst, and again for a new burst after a quiet minute', () => {
  const { clock, d } = detector();
  assert.ok(d.record(many(25, 'deleted')));
  clock.t += 5_000;
  assert.strictEqual(d.record(many(40, 'deleted')), null, 'same burst: no second alert');
  clock.t += 50_000;
  assert.strictEqual(d.record(many(30, 'changed')), null, 'still the same burst (no quiet minute yet)');
  clock.t += 61_000; // a whole minute with no changes
  assert.deepStrictEqual(d.record(many(20, 'deleted')), { deleted: 20, changed: 20 }, 'new burst alerts');
});

// --- Through a real journal and Mewndo ----------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { createJournal, createStore, createMewndo } = require('../engine');
const { tempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timings = { debounceMs: 50, writeFinishMs: 100 };

function project(base, count) {
  const root = path.join(base, 'project');
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, `d${i % 3}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}`);
  }
  return root;
}

async function journalFor(root, base) {
  const dataDir = path.join(base, 'data');
  const j = createJournal({ root, dataDir, store: createStore(path.join(dataDir, 'store')), ...timings });
  const bursts = [];
  j.on('burst', (b) => bursts.push(b));
  await j.start();
  return { j, bursts };
}

test('journal: deleting 23 files alerts once with the real numbers; a deleted folder counts its files only', async () => {
  const base = tempDir();
  const root = project(base, 40);
  const { j, bursts } = await journalFor(root, base);
  try {
    const files = fs.readdirSync(path.join(root, 'd0')).slice(0, 10).map((f) => path.join(root, 'd0', f));
    for (const f of files) fs.rmSync(f); // 10 files
    fs.rmSync(path.join(root, 'd1'), { recursive: true }); // a folder holding 13 files: 23 file deletions
    await j.sync();
    assert.deepStrictEqual(bursts, [{ deleted: 23, changed: 23 }]);
    fs.rmSync(path.join(root, 'd2'), { recursive: true });
    await j.sync();
    assert.strictEqual(bursts.length, 1, 'same burst, no second alert');
  } finally { await j.stop(); }
});

test("journal: Mewndo's own restores never alert", async () => {
  const base = tempDir();
  const root = project(base, 30);
  const { j, bursts } = await journalFor(root, base);
  try {
    const sp = await j.createSavePoint();
    fs.rmSync(path.join(root, 'd0'), { recursive: true });
    fs.rmSync(path.join(root, 'd1'), { recursive: true });
    await j.sync();
    assert.strictEqual(bursts.length, 1, 'the agent deleting 20 files alerts');
    await sleep(100);
    const result = await j.restore(sp.id); // writes 20 files back
    assert.strictEqual(result.verified, true);
    await sleep(500); // let late watcher events arrive
    await j.sync();
    assert.strictEqual(bursts.length, 1, 'putting them back did not alert');
  } finally { await j.stop(); }
});

test('journal: changes found by the catch-up scan at start do not alert', async () => {
  const base = tempDir();
  const root = project(base, 30);
  const first = await journalFor(root, base);
  await first.j.stop();
  fs.rmSync(path.join(root, 'd0'), { recursive: true });
  fs.rmSync(path.join(root, 'd1'), { recursive: true }); // 20 deletions while Mewndo was closed
  const second = await journalFor(root, base);
  try {
    assert.strictEqual(second.j.getIndex()['d0'], undefined, 'caught up');
    assert.deepStrictEqual(second.bursts, []);
  } finally { await second.j.stop(); }
});

test('mewndo: forwards bursts with the folder, but not while protection is paused', async () => {
  const base = tempDir();
  const root = project(base, 60);
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), journalOptions: timings });
  const bursts = [];
  mewndo.on('burst', (r, b) => bursts.push([r, b]));
  try {
    const j = await mewndo.protect(root);
    await mewndo.pauseProtection(60_000);
    fs.rmSync(path.join(root, 'd0'), { recursive: true }); // 20 files
    await j.sync(); // a save point or diff while paused still scans
    assert.deepStrictEqual(bursts, [], 'paused: no alert');
    await mewndo.resumeProtection();
    fs.rmSync(path.join(root, 'd1'), { recursive: true }); // 20 more
    await j.sync();
    assert.deepStrictEqual(bursts, [[fs.realpathSync(root), { deleted: 20, changed: 20 }]]);
  } finally { await mewndo.stop(); }
});
