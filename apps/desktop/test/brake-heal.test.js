// Brake, Heal and Resume (spec §24.3 to §24.5), with the real mewndo-core judging.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { createMewndo, connectCore } = require('../engine');
const { spawn } = require('node:child_process');
const { buildCard, rulesFor, writeManagedBlock, MAX_CHARS } = require('../engine/continue-card');
const { tempDir, CORE_BINARY } = require('./helpers');

const SCRIPT = path.join(__dirname, '..', 'bin', 'mewndo-savepoint.js');
// Runs the hook script as Claude Code would: hook JSON on stdin. Resolves { code, stdout }.
function runScript(env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

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
async function setup(name, files = ['src/app.js', 'notes.md', 'keep1.txt', 'keep2.txt', 'keep3.txt'], options = {}) {
  const root = path.join(base, name);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), `content of ${f}`);
  }
  const dataDir = path.join(base, `${name}-data`);
  const mewndo = createMewndo({ dataDir, core: client, journalOptions: { debounceMs: 50, writeFinishMs: 100 }, ...options });
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
  return { root: real, dataDir, mewndo, events, nextDrift, hookCall };
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

// Resume (spec §24.5).
test('Continue card: under 600 tokens however much changed, items labelled, rules per folder', () => {
  const many = Array.from({ length: 500 }, (_, i) => `src/module-${i}/a-rather-long-file-name-${i}.js`);
  const card = buildCard({
    folder: 'C:\\work', task: 'x'.repeat(2000), diff: { edited: many, created: many, moved: [], deleted: [] },
    agentSays: ['tests pass'], drifts: [{ reason: 'deleted docs/a.md', paths: ['docs/a.md'], healed: ['docs/a.md'] }],
    rules: ['Do not delete files in `docs/` unless I name them.'], newRules: ['Do not delete files in `docs/` unless I name them.'],
    reason: 'it deleted docs/a.md again',
  });
  assert.ok(card.length <= MAX_CHARS, `${card.length} characters`);
  assert.match(card, /Verified \(journal\): edited src\/module-0/);
  assert.match(card, /and \d+ more/);
  assert.match(card, /Mewndo put back docs\/a\.md/);
  assert.match(card, /unless I name them\. \(new\)/);
  assert.match(buildCard({ folder: 'f', diff: null, agentSays: ['wrote the parser'] }), /Agent says: wrote the parser/);
  assert.deepStrictEqual(rulesFor([{ paths: ['docs/a.md', 'docs/b.md', 'x.txt'] }]),
    ['Do not delete files in `docs/` unless I name them.', 'Do not delete `x.txt` unless I name it.']);
});

test('AGENTS.md: the managed block is added once, replaced on the next resume, and the rest kept', async () => {
  const file = path.join(base, 'agents-md', 'AGENTS.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# House rules\nUse tabs.');
  await writeManagedBlock(file, 'card one');
  await writeManagedBlock(file, 'card two');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# House rules\nUse tabs\.\n\n<!-- mewndo:continue -->\ncard two\n<!-- \/mewndo:continue -->\n$/);
});

test('Resume: Claude Code gets a verified Continue card through its SessionStart hook, once', { skip }, async () => {
  const { root, dataDir, mewndo, nextDrift, hookCall } = await setup('resume-claude', undefined, { hookServer: { port: 0 } });
  try {
    await hookCall('claude', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    fs.writeFileSync(path.join(root, 'src/app.js'), 'refactored');
    const drift = nextDrift();
    fs.rmSync(path.join(root, 'keep1.txt'));
    assert.strictEqual((await drift).action, 'healed');
    await mewndo.brake('Claude Code', { reason: 'the user pressed Brake' });
    await new Promise((r) => setTimeout(r, 300)); // the edit reaches the journal

    const r = await mewndo.resumeAgent('Claude Code');
    assert.strictEqual(r.command, 'claude --resume s1');
    assert.match(r.card, /Refactor src\/app\.js/);
    assert.match(r.card, /Verified \(journal\): edited src\/app\.js/);
    assert.match(r.card, /Mewndo braked you: the user pressed Brake/);
    assert.match(r.card, /Mewndo put back keep1\.txt/);
    assert.deepStrictEqual(r.newRules, ['Do not delete `keep1.txt` unless I name it.']);
    assert.match(r.card, /Do not delete `keep1\.txt` unless I name it\. \(new\)/);

    const hookInput = JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
    const first = await runScript({ MEWNDO_DATA_DIR: dataDir }, hookInput);
    assert.strictEqual(first.code, 0);
    const out = JSON.parse(first.stdout);
    assert.deepStrictEqual(out.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: r.card });
    assert.strictEqual((await runScript({ MEWNDO_DATA_DIR: dataDir }, hookInput)).stdout, '', 'only once');

    // The rule stays in the brief: the next card lists it again, no longer new.
    await mewndo.brake('Claude Code', { reason: 'again' });
    assert.match((await mewndo.resumeAgent('Claude Code')).card, /Do not delete `keep1\.txt` unless I name it\.\n/);
  } finally { await mewndo.stop(); }
});

test('Resume: Codex gets a block in AGENTS.md, Cursor a rules file and the clipboard, others the clipboard', { skip }, async () => {
  const { root, mewndo, hookCall } = await setup('resume-others');
  try {
    await hookCall('codex', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    await mewndo.brake('Codex', { reason: 'drift', freeze: false });
    const codex = await mewndo.resumeAgent('Codex');
    assert.deepStrictEqual([codex.inject, codex.command, codex.copy], ['AGENTS.md', 'codex resume s1', undefined]);
    assert.ok(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').includes(codex.card));

    await hookCall('cursor', { command: 'ls' });
    await mewndo.brake('Cursor', { reason: 'drift', freeze: false });
    const cursor = await mewndo.resumeAgent('Cursor');
    assert.deepStrictEqual([cursor.inject, cursor.copy], ['Cursor rules file', true]);
    const rules = fs.readFileSync(path.join(root, '.cursor/rules/mewndo-continue.mdc'), 'utf8');
    assert.match(rules, /^---\ndescription: Mewndo Continue card\nalwaysApply: true\n---\n# Mewndo Continue card/);

    await mewndo.brake('Aider', { reason: 'the user pressed Brake', freeze: false, folder: root });
    const other = await mewndo.resumeAgent('Aider', { agentSays: ['finished the parser'] });
    assert.deepStrictEqual([other.inject, other.copy], ['clipboard', true]);
    assert.match(other.card, /Agent says: finished the parser/);
  } finally { await mewndo.stop(); }
});

test('Let it: a refused action is allowed from then on for that agent only (drift card)', { skip }, async () => {
  const { root, mewndo, hookCall } = await setup('letit');
  try {
    const del = { tool_name: 'Bash', tool_input: { command: 'rm keep2.txt' } };
    const first = await hookCall('claude', del);
    assert.notStrictEqual(first.hookSpecificOutput.permissionDecision, 'allow', 'the brief does not name keep2.txt');
    mewndo.letIt('Claude Code', [{ kind: 'shell', command: 'rm keep2.txt', cwd: root }]);
    assert.strictEqual((await hookCall('claude', del)).hookSpecificOutput.permissionDecision, 'allow');
    assert.notStrictEqual((await hookCall('codex', del)).hookSpecificOutput.permissionDecision, 'allow', 'only for that agent');
  } finally { await mewndo.stop(); }
});

test('holds: approve runs the action once, cancel and the countdown drop it without running', async () => {
  const { createMewndo: create } = require('../engine');
  const { tempDir: temp } = require('./helpers');
  const mewndo = create({ dataDir: temp() });
  const lists = [];
  mewndo.on('holds-changed', (l) => lists.push(l.length));
  let ran = 0;
  const a = mewndo.hold({ agent: 'Codex', what: 'Delete 3 files', run: () => { ran++; return 'done'; } });
  const b = mewndo.hold({ agent: 'Codex', what: 'Delete 9 files', run: () => { ran++; } });
  mewndo.hold({ agent: 'Codex', what: 'Expires', ms: 50, run: () => { ran++; } });
  assert.deepStrictEqual(mewndo.holds().map((h) => h.what), ['Delete 3 files', 'Delete 9 files', 'Expires']);
  assert.ok(mewndo.holds().every((h) => h.expiresAt > h.createdAt && !('run' in h)));
  assert.strictEqual(await mewndo.approveHold(a), 'done');
  await assert.rejects(mewndo.approveHold(a), /already ended/);
  assert.strictEqual(mewndo.cancelHold(b), true);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual([ran, mewndo.holds().length], [1, 0]);
  assert.deepStrictEqual(lists, [1, 2, 3, 2, 1, 0]);
});

test('activity: a hooked agent acting in a folder is exact, with its newest action (the panel)', { skip }, async () => {
  const { root, mewndo, hookCall } = await setup('activity');
  try {
    await hookCall('claude', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    const a = mewndo.activity();
    assert.deepStrictEqual(a.folders.map((f) => [f.root, f.agent, f.confidence]), [[root, 'Claude Code', 'exact']]);
    const claude = a.agents.find((x) => x.name === 'Claude Code');
    assert.strictEqual(claude.last.text, 'Running npm test');
    assert.ok(claude.hookedAt > 0);
  } finally { await mewndo.stop(); }
});
