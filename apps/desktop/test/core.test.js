// The app's side of mewndo-core: start it, check it, restart it, stop it. Uses the real binary (cargo builds it:
// `npm test` from the repository root does that first).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { tempDir } = require('./helpers');

const BINARY = path.join(__dirname, '..', '..', '..', 'core', 'target', 'debug', process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core');
const skip = fs.existsSync(BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';

const quietLog = () => {
  const lines = [];
  const add = (level) => (message, details) => lines.push(`${level} ${message} ${details ?? ''}`);
  return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR') };
};

// Resolves once the status reaches `state`.
function reach(core, want, ms = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stuck in ${core.status().state}, wanted ${want}`)), ms);
    (function poll() {
      if (core.status().state === want) { clearTimeout(timer); resolve(core.status()); } else setTimeout(poll, 10);
    }());
  });
}

function make(options = {}) {
  const dir = tempDir();
  const states = [];
  const log = quietLog();
  const core = createCore({
    binary: BINARY, runDir: dir, logDir: path.join(dir, 'logs'), log, onChange: (s) => states.push(s.state),
    restartAfterMs: 50, ...options,
  });
  return { core, states, log, dir };
}

test('starts the core, sees it alive, and stops it cleanly', { skip }, async () => {
  const { core, states, dir } = make();
  core.start();
  const s = await reach(core, 'running');
  assert.strictEqual(s.version, '0.1.0');
  assert.ok(s.pid > 0 && s.uptimeMs >= 0);
  await core.stop();
  assert.strictEqual(core.status().state, 'stopped');
  assert.deepStrictEqual(states, ['running', 'stopped']);
  assert.throws(() => process.kill(s.pid, 0), /ESRCH/, 'the core process is gone');
  const coreLog = fs.readFileSync(path.join(dir, 'logs', 'mewndo-core.log'), 'utf8');
  assert.match(coreLog, /INFO {2}mewndo-core 0\.1\.0 starting[\s\S]*shutdown requested by the app[\s\S]*mewndo-core stopped/);
});

test('a core that crashes is restarted', { skip }, async () => {
  const { core, states, log } = make();
  core.start();
  const first = await reach(core, 'running');
  process.kill(first.pid, 'SIGKILL');
  await reach(core, 'restarting');
  const second = await reach(core, 'running');
  assert.notStrictEqual(second.pid, first.pid);
  assert.ok(log.lines.some((l) => l.startsWith('ERROR mewndo-core stopped')));
  await core.stop();
});

test('three crashes within a minute: gives up and says so', { skip }, async () => {
  const { core, states } = make();
  core.start();
  for (let i = 0; i < 3; i++) {
    const s = await reach(core, 'running');
    process.kill(s.pid, 'SIGKILL');
    if (i < 2) await reach(core, 'restarting');
  }
  const s = await reach(core, 'failed');
  assert.match(s.message, /keeps stopping/);
  await core.stop();
});

test('a core that stops answering is restarted', { skip: skip || (process.platform === 'win32' && 'needs SIGSTOP') }, async () => {
  const { core, states } = make({ checkEveryMs: 30, answerWithinMs: 30 });
  core.start();
  const first = await reach(core, 'running');
  process.kill(first.pid, 'SIGSTOP'); // alive but frozen
  try {
    await reach(core, 'not-responding');
    const second = await reach(core, 'running');
    assert.notStrictEqual(second.pid, first.pid);
  } finally {
    try { process.kill(first.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await core.stop();
});

test('works from a data folder whose path is too long for a Unix socket', { skip }, async () => {
  const deep = path.join(tempDir(), 'a-folder-name-that-is-long-enough'.repeat(4));
  fs.mkdirSync(deep);
  const states = [];
  const core = createCore({ binary: BINARY, runDir: deep, logDir: deep, log: quietLog(), onChange: (s) => states.push(s.state) });
  core.start();
  await reach(core, 'running');
  await core.stop();
  assert.deepStrictEqual(states, ['running', 'stopped']);
});

test('a missing core binary is reported, not retried', async () => {
  const dir = tempDir();
  const states = [];
  const core = createCore({
    binary: path.join(dir, 'no-such-core'), runDir: dir, logDir: dir, log: quietLog(), onChange: (s) => states.push(s.state), restartAfterMs: 10,
  });
  core.start();
  const s = await reach(core, 'missing');
  assert.match(s.message, /was not found/);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(states, ['missing']);
});

test('requests carry the protocol version, and errors come back as errors', { skip }, async () => {
  const { core, states } = make();
  core.start();
  await reach(core, 'running');
  await assert.rejects(core.request('no_such_request'), (e) => e.code === 'unknown_type');
  assert.strictEqual((await core.request('status')).v, 1);
  await core.stop();
});
