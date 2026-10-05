// The native recursive watcher used on Windows and macOS (Node supports it on Linux too, so it is tested here).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createJournal, createStore, hashFile } = require('../engine');
const { tempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nativeJournal(files, extra = {}) {
  const base = tempDir();
  const root = path.join(base, 'project');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  fs.mkdirSync(root, { recursive: true });
  const dataDir = path.join(base, 'data');
  const journal = createJournal({
    root, dataDir, store: createStore(path.join(dataDir, 'store')), watcher: 'native', debounceMs: 50, writeFinishMs: 300, ...extra,
  });
  journal.on('warning', (e) => { throw e; });
  await journal.start();
  return { root, journal };
}

function nextChange(journal, pathName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no change for ${pathName}`)), timeoutMs);
    journal.on('change', function on(c) { if (c.path === pathName) { clearTimeout(t); journal.off('change', on); resolve(c); } });
  });
}

test('native watcher: captures edits, new files in new folders, and deletions', async () => {
  const { root, journal } = await nativeJournal({ 'a.txt': 'A', 'docs/b.txt': 'B' });
  try {
    const edited = nextChange(journal, 'a.txt');
    fs.writeFileSync(path.join(root, 'a.txt'), 'A2');
    await edited;
    assert.strictEqual(journal.getIndex()['a.txt'].hash, await hashFile(path.join(root, 'a.txt')));

    const added = nextChange(journal, 'new/deep/c.txt');
    fs.mkdirSync(path.join(root, 'new/deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'new/deep/c.txt'), 'C');
    await added;

    const deleted = nextChange(journal, 'docs/b.txt');
    fs.rmSync(path.join(root, 'docs/b.txt'));
    assert.deepStrictEqual(await deleted, { path: 'docs/b.txt', type: 'deleted' });
  } finally { await journal.stop(); }
});

test('native watcher: waits for writes to settle, so a half-written file is not captured', async () => {
  // An 800 ms settle time against 100 ms pauses between writes: even on a busy machine (tests run in parallel)
  // a pause never looks like the end of writing.
  const { root, journal } = await nativeJournal({ 'a.txt': 'A' }, { writeFinishMs: 800 });
  const syncs = [];
  journal.on('change', (c) => syncs.push(c));
  try {
    const fd = fs.openSync(path.join(root, 'big.txt'), 'w');
    for (let i = 0; i < 5; i++) { fs.writeSync(fd, `part ${i}\n`); await sleep(100); } // writing for ~500 ms
    fs.closeSync(fd);
    for (let i = 0; i < 40 && !syncs.length; i++) await sleep(100);
    await sleep(500); // a second, wrong sync would show up by now
    assert.deepStrictEqual(syncs, [{ path: 'big.txt', type: 'added' }], 'one sync, after writing finished');
    assert.strictEqual(journal.getIndex()['big.txt'].size, 35, 'the finished file, not part of it');
  } finally { await journal.stop(); }
});

test('native watcher: changes inside ignored folders do not trigger anything', async () => {
  const { root, journal } = await nativeJournal({ 'a.txt': 'A', 'node_modules/x/i.js': 'x' });
  const changes = [];
  journal.on('change', (c) => changes.push(c));
  try {
    fs.writeFileSync(path.join(root, 'node_modules/x/i.js'), 'changed');
    fs.writeFileSync(path.join(root, 'node_modules/x/j.js'), 'new');
    await sleep(700);
    assert.deepStrictEqual(changes, []);
  } finally { await journal.stop(); }
});

test('native watcher: syncs at least every 30 s even under constant change', async () => {
  const { root, journal } = await nativeJournal({ 'log.txt': '' }, { writeFinishMs: 1000 });
  try {
    // Writes every 100 ms never leave the 1 s of quiet a sync waits for; the 30 s cap must force one anyway.
    const start = Date.now();
    const changed = nextChange(journal, 'log.txt', 40_000);
    const writer = setInterval(() => fs.appendFileSync(path.join(root, 'log.txt'), 'line\n'), 100);
    try { await changed; } finally { clearInterval(writer); }
    const took = Date.now() - start;
    assert.ok(took >= 29_000 && took < 36_000, `synced after ${took} ms`);
  } finally { await journal.stop(); }
});

// Regression: past the wait cap, every watcher event during a running sync used to queue another full rescan:
// 558 rescans for one 5,000-file restore (about 8x slower). Scaled down: 600 files, a 200 ms cap. The broken
// version did 226 full rescans' worth of work here; the fixed one about 11.
for (const watcher of ['native', 'chokidar']) {
  test(`${watcher} watcher: a restore that writes many files doesn't trigger a rescan storm`, async () => {
    const base = tempDir();
    const root = path.join(base, 'project');
    for (let i = 0; i < 600; i++) {
      const dir = path.join(root, `d${i % 20}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}`);
    }
    const dataDir = path.join(base, 'data');
    const journal = createJournal({
      root, dataDir, store: createStore(path.join(dataDir, 'store')), watcher, debounceMs: 50, writeFinishMs: 100, maxWaitMs: 200,
    });
    journal.on('warning', (e) => { throw e; });
    await journal.start();
    try {
      const sp = await journal.createSavePoint();
      for (let i = 0; i < 600; i++) fs.rmSync(path.join(root, `d${i % 20}`, `f${i}.txt`));
      await sleep(500); // the watcher is still busy with the deletions when the restore starts
      // Work done by syncs during the restore, in entries looked at: a full rescan is 620. Many small partial
      // rescans are fine; hundreds of full ones are the storm.
      let looked = 0;
      journal.on('progress', (p) => { if (p.phase === 'done') looked += p.found; });
      const result = await journal.restore(sp.id);
      assert.strictEqual(result.verified, true);
      assert.ok(looked <= 40 * 620, `${looked} entries looked at during the restore (${(looked / 620).toFixed(1)} full rescans' worth)`);
    } finally { await journal.stop(); }
  });
}

// --- Rescanning only what changed (native watcher) -------------------------------------------------------------

async function bigJournal(dirs) {
  const files = {};
  for (let i = 0; i < dirs; i++) files[`d${i}/f.txt`] = `file ${i}`;
  return nativeJournal(files, { writeFinishMs: 100 });
}
const scanned = (journal) => {
  const runs = [];
  journal.on('progress', (p) => { if (p.phase === 'done') runs.push(p.found); });
  return runs;
};

test('native watcher: a change is captured by reading only its folder', async () => {
  const { root, journal } = await bigJournal(30);
  const runs = scanned(journal);
  try {
    const changed = nextChange(journal, 'd7/f.txt');
    fs.writeFileSync(path.join(root, 'd7/f.txt'), 'edited');
    await changed;
    assert.deepStrictEqual(runs, [1], 'one entry looked at, not 60');
    assert.strictEqual(journal.getIndex()['d7/f.txt'].hash, await hashFile(path.join(root, 'd7/f.txt')));
  } finally { await journal.stop(); }
});

test('native watcher: a quick save point with nothing pending scans nothing, and still sees a file written just before', async () => {
  const { root, journal } = await bigJournal(30);
  const runs = scanned(journal);
  try {
    const first = await journal.createSavePoint({ trigger: 'hook', quick: true });
    assert.deepStrictEqual(runs, [], 'nothing changed: no scan at all');
    fs.writeFileSync(path.join(root, 'd3/new.txt'), 'written right before the hook');
    const second = await journal.createSavePoint({ trigger: 'hook', quick: true, onlyIfChanged: true });
    assert.ok(second && second.id !== first.id, 'the new file made it into a new save point');
    assert.ok(journal.getIndex()['d3/new.txt']?.hash);
    assert.ok(runs.every((n) => n < 10), `only the changed folder was read: ${runs}`);
  } finally { await journal.stop(); }
});

test('native watcher: an unknown change (event overflow) makes the next sync read everything', async () => {
  const realWatch = fs.watch;
  let fire;
  // The journal's own watch is the first call (on Linux, Node then watches each subfolder itself).
  fs.watch = (p, o, cb) => { fire ??= cb; return realWatch(p, o, cb); };
  let parts;
  try { parts = await bigJournal(10); } finally { fs.watch = realWatch; }
  const { root, journal } = parts;
  const runs = scanned(journal);
  try {
    fs.writeFileSync(path.join(root, 'd2/f.txt'), 'changed while the event buffer overflowed');
    await sleep(50);
    runs.length = 0;
    fire('rename', null); // what Windows sends when its event buffer overflowed
    await nextChange(journal, 'd2/f.txt');
    assert.ok(runs.includes(20), `a full rescan (20 entries): ${runs}`);
  } finally { await journal.stop(); }
});
