// Brake and Heal (spec §24.3, §24.4), with the real mewndo-core judging.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { createMewndo, connectCore } = require('../engine');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const base = tempDir();
let core;
let client;

before(async () => {
  if (skip) return;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: CORE_BINARY, runDir: base, logDir: path.join(base, 'logs'), log: { info() {}, warn() {}, error() {} },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
  client = connectCore(core.address);
});
after(async () => { client?.close(); await core?.stop(); });

// A protected folder with a brief, and Mewndo's events.
async function setup(name, files = ['src/app.js', 'notes.md', 'keep1.txt', 'keep2.txt', 'keep3.txt']) {
  const root = path.join(base, name);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), `content of ${f}`);
  }
  const mewndo = createMewndo({ dataDir: path.join(base, `${name}-data`), core: client, journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  await mewndo.start();
  await mewndo.protect(root);
  const real = fs.realpathSync(root);
  await mewndo.saveBrief(real, 'Refactor src/app.js. You may delete notes.md.');
  await mewndo.journals()[0].createSavePoint({ label: 'start' });
  const events = [];
  const waiting = [];
  mewndo.on('drift', (d) => { events.push(d); for (const w of waiting.splice(0)) w(d); });
  const nextDrift = (ms = 10_000) => new Promise((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => reject(new Error('no drift event')), ms).unref();
  });
  // A hooked agent session acting in the folder (what makes a session "active").
  const hookCall = (agent, input) => mewndo.guard({ session_id: 's1', conversation_id: 's1', cwd: real, ...input }, { agent });
  return { root: real, mewndo, events, nextDrift, hookCall };
}

test('Brake: Claude Code gets continue false; Codex and Cursor are refused until resumed', { skip }, async () => {
  const { mewndo, hookCall } = await setup('brake');
  try {
    const bash = { tool_name: 'Bash', tool_input: { command: 'npm test' } };
    assert.strictEqual((await hookCall('claude', bash)).hookSpecificOutput.permissionDecision, 'allow');
    const b = await mewndo.brake('Claude Code', { reason: 'the user pressed Brake' });
    assert.deepStrictEqual(b.frozen, [], 'a hooked agent is stopped at its hook, not frozen');
    assert.deepStrictEqual(await hookCall('claude', bash), { continue: false, stopReason: 'Mewndo stopped this session: the user pressed Brake.' });

    await mewndo.brake('Codex', { reason: 'drift', freeze: false });
    const codex = await hookCall('codex', bash);
    assert.strictEqual(codex.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(codex.hookSpecificOutput.permissionDecisionReason, /Mewndo stopped this session: drift\. Stop and wait/);
    await mewndo.brake('Cursor', { reason: 'drift', freeze: false });
    assert.strictEqual((await hookCall('cursor', { command: 'ls' })).permission, 'deny');

    await mewndo.resumeAgent('Claude Code');
    assert.strictEqual((await hookCall('claude', bash)).hookSpecificOutput.permissionDecision, 'allow');
    assert.deepStrictEqual(mewndo.braked().map((x) => x.agent).sort(), ['Codex', 'Cursor']);
  } finally { await mewndo.stop(); }
});

test('Heal: an unnamed file an agent deletes comes back once; the second time the agent is braked', { skip }, async () => {
  const { root, mewndo, nextDrift, hookCall } = await setup('heal');
  try {
    await hookCall('claude', { tool_name: 'Bash', tool_input: { command: 'npm test' } }); // a session is active
    const drift = nextDrift();
    fs.rmSync(path.join(root, 'keep1.txt'));
    const d = await drift;
    assert.strictEqual(d.action, 'healed');
    assert.deepStrictEqual(d.healed, ['keep1.txt']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'keep1.txt'), 'utf8'), 'content of keep1.txt');

    // Linux's watcher (Chokidar, dev only) misses a delete within ~100 ms of the file being written back.
    await new Promise((r) => setTimeout(r, 500));
    const again = nextDrift();
    fs.rmSync(path.join(root, 'keep1.txt'));
    const d2 = await again;
    assert.strictEqual(d2.action, 'braked', 'not fighting the agent');
    assert.match(d2.reason, /deleted keep1\.txt again/);
    assert.deepStrictEqual(mewndo.braked().map((x) => x.agent), ['Claude Code']);
    assert.ok(!fs.existsSync(path.join(root, 'keep1.txt')));
  } finally { await mewndo.stop(); }
});

test('Heal: a file the brief names may go; nothing is healed while no agent session is active', { skip }, async () => {
  const { root, mewndo, events, hookCall } = await setup('quiet');
  try {
    fs.rmSync(path.join(root, 'keep2.txt')); // the user, no agent around
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(events, []);
    assert.ok(!fs.existsSync(path.join(root, 'keep2.txt')), 'the user\'s own delete stays');

    await hookCall('claude', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    fs.rmSync(path.join(root, 'notes.md')); // named in the brief
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(events, []);
  } finally { await mewndo.stop(); }
});

test('three drifts in one task: the agent is braked and the task handed to the user', { skip }, async () => {
  const { root, mewndo, nextDrift, hookCall } = await setup('three');
  try {
    await hookCall('codex', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    for (const [i, f] of ['keep1.txt', 'keep2.txt', 'keep3.txt'].entries()) {
      const drift = nextDrift();
      fs.rmSync(path.join(root, f));
      const d = await drift;
      assert.strictEqual(d.action, i < 2 ? 'healed' : 'braked', f);
      if (i === 2) assert.strictEqual(d.handoff, true);
      await new Promise((r) => setTimeout(r, 300)); // the heal's own restore settles
    }
    assert.deepStrictEqual(mewndo.braked().map((x) => x.agent), ['Codex']);
  } finally { await mewndo.stop(); }
});
