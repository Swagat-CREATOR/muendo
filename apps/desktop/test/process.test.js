// Brake's process control (core/src/process.rs), used the way the app will: over the real pipe, with the real
// mewndo-core binary. Freezes and resumes a test process tree, ends one, and never touches Mewndo itself.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = !fs.existsSync(CORE_BINARY) ? 'mewndo-core is not built: run `npm test` from the repository root'
  : process.platform !== 'win32' && 'process control runs on Windows (Mewndo v1 is a Windows app)';

const base = tempDir();
let core;
before(async () => {
  if (skip) return;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: CORE_BINARY, runDir: base, logDir: path.join(base, 'logs'), log: { info() {}, warn() {}, error() {} },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
});
after(async () => {
  for (const c of started) await core?.request('process_end', { pid: c.pid }).catch(() => {});
  await core?.stop();
});

const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function grows(file, ms) {
  const start = size(file);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (size(file) > start) return true;
  return false;
}

// cmd running `ping -t` (a line a second) into a file: a parent with a child that keeps writing.
const started = [];
async function pinger(name) {
  const out = path.join(base, `${name}.txt`);
  const child = spawn('cmd', ['/d', '/c', `ping -t 127.0.0.1 > "${out}"`], { windowsVerbatimArguments: true, stdio: 'ignore' });
  started.push(child);
  assert.ok(await grows(out, 10_000), 'ping is writing');
  return { child, out };
}

test('freezes a whole process tree and resumes it', { skip }, async () => {
  const { child, out } = await pinger('freeze');
  const frozen = await core.request('process_freeze', { pid: child.pid });
  assert.strictEqual(frozen.pids[0], child.pid, 'root first');
  assert.ok(frozen.pids.length >= 2, `cmd and its ping child: ${JSON.stringify(frozen)}`);
  await sleep(300); // a write in progress finishes first
  assert.ok(!(await grows(out, 2500)), 'nothing is written while frozen');

  const resumed = await core.request('process_resume', { pid: child.pid });
  assert.deepStrictEqual(resumed.pids, frozen.pids);
  assert.ok(await grows(out, 5000), 'writing again after resume');
  await core.request('process_end', { pid: child.pid }); // before the temp folder is removed
});

test('ends a whole process tree', { skip }, async () => {
  const { child, out } = await pinger('end');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ended = await core.request('process_end', { pid: child.pid });
  assert.ok(ended.pids.length >= 2, JSON.stringify(ended));
  await exited;
  await sleep(300);
  assert.ok(!(await grows(out, 2000)), 'ping is gone too');
});

test('never touches Mewndo itself or system processes, and says why', { skip }, async () => {
  const { pid } = await core.request('status');
  await assert.rejects(core.request('process_freeze', { pid }), /Mewndo itself/);
  await assert.rejects(core.request('process_freeze', { pid: process.pid }), /Mewndo itself/); // the app runs the core
  await assert.rejects(core.request('process_end', { pid: 4 }), /system process/);
  await assert.rejects(core.request('process_resume', { pid: 4_000_000_000 }), /no running process/);
});
