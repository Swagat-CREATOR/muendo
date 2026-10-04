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
  const { root, journal } = await nativeJournal({ 'a.txt': 'A' });
  const syncs = [];
  journal.on('change', (c) => syncs.push(c));
  try {
    const fd = fs.openSync(path.join(root, 'big.txt'), 'w');
    for (let i = 0; i < 5; i++) { fs.writeSync(fd, `part ${i}\n`); await sleep(100); } // writing for ~500 ms
    fs.closeSync(fd);
    await sleep(800);
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
