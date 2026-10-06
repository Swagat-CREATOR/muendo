// mewndo-core's scanner and change feed, used the way the app will: over the real pipe, with the real binary.
// The scanner must produce exactly v0's manifest; the feed (Windows) must get a delete to the app at once.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { scan } = require('../engine');
const { tempDir, linkDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const windowsOnly = skip || (process.platform !== 'win32' && 'the change feed runs on Windows (Mewndo v1 is a Windows app)');
const nothing = { info() {}, warn() {}, error() {} };

// A running core, its feed events, and a way to wait for one.
async function startCore(dir) {
  const events = [];
  const waiting = [];
  const core = createCore({
    binary: CORE_BINARY, runDir: dir, logDir: path.join(dir, 'logs'), log: nothing,
    onEvent: (e) => {
      e.receivedAt = performance.timeOrigin + performance.now();
      events.push(e);
      for (const w of [...waiting]) if (w.match(e)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(e); }
    },
  });
  core.start();
  await new Promise((resolve, reject) => {
    const t = setInterval(() => {
      const s = core.status().state;
      if (s === 'running') { clearInterval(t); resolve(); }
      if (s === 'failed' || s === 'missing') { clearInterval(t); reject(new Error(core.status().message)); }
    }, 10);
  });
  const next = (match, ms = 10_000) => new Promise((resolve, reject) => {
    const already = events.find(match);
    if (already) { events.splice(events.indexOf(already), 1); return resolve(already); }
    const w = { match, resolve };
    waiting.push(w);
    setTimeout(() => reject(new Error(`no such event; got ${JSON.stringify(events.slice(-5))}`)), ms).unref();
  });
  return { core, events, next };
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

test('Rust scans a folder exactly as v0 does, and picks up from a v0 manifest hashing only what changed', { skip }, async () => {
  const base = tempDir();
  const root = path.join(base, 'root');
  for (const [rel, text] of Object.entries({
    'a.txt': 'A', 'docs/b.txt': 'BB', 'docs/deep/c.txt': 'CCC', 'node_modules/pkg/index.js': 'ignored', '.git/HEAD': 'ref',
    'huge.bin': 'x'.repeat(2000), 'today.log': 'ignored by pattern', 'naïve café.md': 'unicode', 'r.docx.1a.mewndo-tmp': 'temp',
  })) write(root, rel, text);
  fs.mkdirSync(path.join(root, 'empty'));
  fs.mkdirSync(path.join(base, 'outside'));
  linkDir(path.join(base, 'outside'), path.join(root, 'outside-link'));
  const v0opts = { maxFileSize: 1000, ignorePatterns: ['*.log'] };
  const coreOpts = { max_file_size: 1000, ignore_patterns: ['*.log'] };

  const { core } = await startCore(base);
  try {
    const v0 = await scan(root, v0opts);
    const rust = await core.request('scan', { root, options: coreOpts }, { within: 60_000 });
    assert.deepStrictEqual(rust.manifest, v0);
    assert.strictEqual(rust.root, fs.realpathSync.native(root));

    // An agent edits one file; the v0 index is the starting point.
    write(root, 'docs/b.txt', 'edited');
    const again = await core.request('scan', { root, previous: v0, dirs: ['docs'], options: coreOpts }, { within: 60_000 });
    assert.strictEqual(again.hashed, 1, 'only the edited file: every other mtime matched v0\'s exactly');
    assert.deepStrictEqual(again.manifest, await scan(root, v0opts));
  } finally {
    await core.stop();
  }
});

test('a delete reaches the app over the pipe at once (spec §28: 10 to 100 ms)', { skip: windowsOnly }, async (t) => {
  const base = tempDir();
  const root = path.join(base, 'root');
  for (let i = 0; i < 50; i++) write(root, `f${i}.txt`, 'x');
  const { core, next } = await startCore(base);
  try {
    await core.request('watch', { root });
    await next((e) => e.kind === 'rescan');
    const ms = [];
    for (let i = 0; i < 50; i++) {
      const name = `f${i}.txt`;
      const gotIt = next((e) => e.kind === 'deleted' && e.path === name);
      const t0 = performance.timeOrigin + performance.now();
      fs.rmSync(path.join(root, name));
      ms.push((await gotIt).receivedAt - t0);
    }
    ms.sort((a, b) => a - b);
    const [p50, p95, max] = [ms[24], ms[47], ms[49]];
    t.diagnostic(`delete -> app over the pipe, 50 deletes: median ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
    assert.ok(p50 < 100, `median ${p50} ms`);
  } finally {
    await core.stop();
  }
});

test('changes made while the core was closed are caught up when it starts again', { skip: windowsOnly }, async () => {
  const base = tempDir();
  const root = path.join(base, 'root');
  write(root, 'keep/y.txt', 'y');
  write(root, 'old/x.txt', 'x');
  const cursor = path.join(base, 'state', 'cursor.json');

  let { core, next } = await startCore(base);
  await core.request('watch', { root, options: { cursor_file: cursor } });
  assert.strictEqual((await next((e) => e.kind === 'rescan')).dirs, undefined, 'first start: everything');
  const { usn } = await core.request('feed_position', { root });
  if (usn !== null) await core.request('feed_checkpoint', { root, usn }); // the index is saved
  await core.stop();

  write(root, 'new/n.txt', 'n');
  fs.rmSync(path.join(root, 'old', 'x.txt'));

  ({ core, next } = await startCore(base));
  try {
    await core.request('watch', { root, options: { cursor_file: cursor } });
    const { dirs, message } = await next((e) => e.kind === 'rescan');
    if (usn === null) {
      // A drive without an NTFS change journal (some USB and second disks): everything is rescanned, and it says so.
      assert.deepStrictEqual([dirs, message], [undefined, 'this drive keeps no change journal']);
      return;
    }
    for (const d of ['', 'new', 'old']) assert.ok(dirs.includes(d), `${JSON.stringify(d)} in ${JSON.stringify(dirs)}`);
    assert.ok(!dirs.includes('keep'));
  } finally {
    await core.stop();
  }
});
