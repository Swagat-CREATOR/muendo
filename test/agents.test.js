const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const {
  matchAgents, loadAgents, createAgentWatcher, DEFAULT_AGENTS, createMewndo, startHookServer,
  planClaudeHooks, installClaudeHooks,
} = require('../engine');
const { tempDir } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCRIPT = path.join(__dirname, '..', 'bin', 'mewndo-savepoint.js');

// --- Recognising agents ---------------------------------------------------------------------------------------

test('recognises the default agents, and tells Claude Code from the Claude desktop app', () => {
  const ps = [
    { name: 'claude.exe', exe: 'C:\\Users\\a\\.local\\bin\\claude.exe', cmd: 'claude' },
    { name: 'claude.exe', exe: 'C:\\Users\\a\\AppData\\Local\\AnthropicClaude\\app-0.9.3\\claude.exe', cmd: '"…claude.exe" --type=renderer' },
    { name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js' },
    { name: 'Cursor.exe', exe: 'C:\\Users\\a\\AppData\\Local\\Programs\\cursor\\Cursor.exe', cmd: 'Cursor.exe' },
    { name: 'notepad.exe', exe: 'C:\\Windows\\notepad.exe', cmd: 'notepad.exe claude-notes.txt' },
  ];
  assert.deepStrictEqual([...matchAgents(ps, DEFAULT_AGENTS)].sort(), ['Claude Code', 'Claude desktop', 'Codex', 'Cursor']);

  const desktopOnly = [{ name: 'Claude', exe: '/Applications/Claude.app/Contents/MacOS/Claude', cmd: '/Applications/Claude.app/Contents/MacOS/Claude' }];
  assert.deepStrictEqual([...matchAgents(desktopOnly, DEFAULT_AGENTS)], ['Claude desktop'], 'macOS desktop app is not Claude Code');

  const linux = [
    { name: 'claude', exe: 'claude', cmd: 'claude --resume' },
    { name: 'node', exe: 'node', cmd: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
    { name: 'windsurf', exe: 'windsurf', cmd: '/usr/share/windsurf/windsurf' },
    { name: 'openclaw', exe: 'openclaw', cmd: 'openclaw gateway' },
  ];
  assert.deepStrictEqual([...matchAgents(linux, DEFAULT_AGENTS)].sort(), ['Claude Code', 'OpenClaw', 'Windsurf']);
  assert.deepStrictEqual([...matchAgents([{ name: 'bash', exe: 'bash', cmd: 'bash' }], DEFAULT_AGENTS)], []);
});

test('agents.json: created with the defaults, user additions apply, a broken file is kept and reported', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'agents.json');
  assert.deepStrictEqual((await loadAgents(file)).map((a) => a.name), DEFAULT_AGENTS.map((a) => a.name));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved._help && saved.agents.length === 6, 'written with a help text');

  saved.agents.push({ name: 'Antigravity', names: ['antigravity ide'] });
  fs.writeFileSync(file, JSON.stringify(saved));
  let processes = [{ name: 'Antigravity IDE.exe', exe: 'C:\\x\\Antigravity IDE.exe', cmd: '' }];
  const changes = [];
  const errors = [];
  const w = createAgentWatcher({ agentsFile: file, listProcesses: async () => processes, onChange: (c) => changes.push(c), onError: (e) => errors.push(e.message) });
  await w.check();
  assert.deepStrictEqual(changes, [{ started: ['Antigravity'], stopped: [], running: ['Antigravity'] }]);

  fs.writeFileSync(file, '{ not json');
  processes = [];
  await w.check();
  assert.deepStrictEqual(changes.at(-1), { started: [], stopped: ['Antigravity'], running: [] }, 'previous list still used');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /agents\.json can't be used/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json', 'the broken file is not overwritten');
  await w.check();
  assert.strictEqual(errors.length, 1, 'reported once, not on every check');
  w.stop();
});

// --- Agent save points ------------------------------------------------------------------------------------------

function folder(base, name, files) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), content);
  return root;
}

test('an agent starting makes a save point in every protected folder; while it runs, only folders that changed get more', async () => {
  const base = tempDir();
  const a = folder(base, 'a', { 'x.txt': 'x' });
  const b = folder(base, 'b', { 'y.txt': 'y' });
  let processes = [];
  const mewndo = createMewndo({
    dataDir: path.join(base, 'data'),
    journalOptions: { debounceMs: 50, writeFinishMs: 100 },
    agents: { intervalMs: 100, saveEveryMs: 400, listProcesses: async () => processes },
  });
  const agentEvents = [];
  mewndo.on('agents-changed', (list) => agentEvents.push(list.map((x) => x.name)));
  try {
    const ja = await mewndo.protect(a);
    const jb = await mewndo.protect(b);
    await mewndo.start();
    processes = [{ name: 'codex', exe: 'codex', cmd: 'codex' }];
    await sleep(400);
    assert.deepStrictEqual(mewndo.agents().map((x) => x.name), ['Codex']);
    assert.deepStrictEqual(agentEvents.at(-1), ['Codex']);
    for (const j of [ja, jb]) {
      const sps = await j.listSavePoints();
      assert.deepStrictEqual(sps.map((s) => [s.trigger, s.agent, s.label]), [['agent', 'Codex', 'Codex started']]);
    }

    fs.writeFileSync(path.join(a, 'x.txt'), 'changed by the agent');
    await sleep(1000); // two or more periodic ticks
    const aPoints = await ja.listSavePoints();
    const periodic = aPoints.filter((s) => s.label === 'While Codex was running');
    assert.strictEqual(periodic.length, 1, 'one periodic save point, only because a changed');
    assert.strictEqual(periodic[0].agentLikely, true);
    const activity = aPoints.find((s) => s.trigger === 'activity');
    assert.deepStrictEqual([activity.agent, activity.agentLikely], ['Codex', true], 'activity save point names the likely agent');
    assert.ok(!(await jb.listSavePoints()).some((s) => s.label === 'While Codex was running'), 'b did not change');

    processes = [];
    await sleep(300);
    assert.deepStrictEqual(mewndo.agents(), []);
  } finally { await mewndo.stop(); }
});

// --- The hook server and the script ---------------------------------------------------------------------------

async function withServer(fn) {
  const base = tempDir();
  const root = folder(base, 'project', { 'a.txt': 'A' });
  const dataDir = path.join(base, 'data');
  const mewndo = createMewndo({ dataDir, journalOptions: { debounceMs: 50, writeFinishMs: 100 }, hookServer: { port: 0 } });
  const journal = await mewndo.protect(root);
  await mewndo.start();
  try {
    const { port, token } = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook.json'), 'utf8'));
    await fn({ base, root, dataDir, journal, port, token });
  } finally { await mewndo.stop(); }
}

function post(port, { token, host = `127.0.0.1:${port}`, path: p = '/savepoint', body = {} }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host, 'x-mewndo-token': token ?? '', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('hook server: needs the token and a local host name; saves the folder the agent works in, only when it changed', async () => {
  await withServer(async ({ base, root, dataDir, journal, port, token }) => {
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dataDir, 'hook.json')).mode & 0o777, 0o600);
    assert.strictEqual((await post(port, { token: 'wrong' })).status, 401);
    assert.strictEqual((await post(port, { token, host: 'evil.example:80' })).status, 403);
    assert.strictEqual((await post(port, { token, path: '/other' })).status, 404);

    const sub = path.join(root, 'src');
    fs.mkdirSync(sub);
    const first = await post(port, { token, body: { agent: 'Claude Code', event: 'PreToolUse', cwd: sub, command: 'rm -rf build\n  && npm test' } });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.folder, fs.realpathSync(root));
    assert.deepStrictEqual([first.body.savePoint.trigger, first.body.savePoint.agent, first.body.savePoint.label],
      ['hook', 'Claude Code', 'Before Claude Code runs: rm -rf build && npm test']);
    assert.strictEqual(first.body.savePoint.agentLikely, undefined, 'exact, not a guess');

    const again = await post(port, { token, body: { agent: 'Claude Code', event: 'PreToolUse', cwd: root, command: 'ls' } });
    assert.strictEqual(again.body.savePoint, null, 'nothing changed: no new save point');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
    const third = await post(port, { token, body: { agent: 'Claude Code', event: 'PreToolUse', cwd: root, command: 'ls' } });
    assert.ok(third.body.savePoint, 'changed: a new save point');

    const outside = await post(port, { token, body: { agent: 'Claude Code', event: 'PreToolUse', cwd: base, command: 'ls' } });
    assert.deepStrictEqual(outside.body, { ok: true, savePoint: null, reason: 'not in a protected folder' });
    assert.strictEqual((await journal.listSavePoints()).filter((s) => s.trigger === 'hook').length, 2);
  });
});

// Runs the real script like Claude Code would: hook JSON on stdin. Resolves { code, ms, stdout }.
function runScript(env, stdin) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('exit', (code) => resolve({ code, ms: Date.now() - started, stdout }));
    child.stdin.end(stdin);
  });
}

test('mewndo-savepoint: asks Mewndo for a save point, prints nothing, exits 0 quickly', async () => {
  await withServer(async ({ root, dataDir, journal }) => {
    fs.writeFileSync(path.join(root, 'b.txt'), 'new');
    const hookInput = JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'SessionStart' });
    const r = await runScript({ MEWNDO_DATA_DIR: dataDir }, hookInput);
    assert.deepStrictEqual([r.code, r.stdout], [0, '']);
    assert.ok(r.ms < 1000, `took ${r.ms} ms`);
    await sleep(200);
    const sp = (await journal.listSavePoints()).find((s) => s.trigger === 'hook');
    assert.deepStrictEqual([sp?.agent, sp?.label], ['Claude Code', 'Claude Code session started']);
  });
});

test("mewndo-savepoint: still exits 0 within a second when Mewndo isn't set up, isn't running, or hangs", async () => {
  const dir = tempDir();
  const input = JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } });

  const notSetUp = await runScript({ MEWNDO_DATA_DIR: path.join(dir, 'nothing-here') }, input);
  assert.deepStrictEqual([notSetUp.code, notSetUp.stdout], [0, '']);
  assert.ok(notSetUp.ms < 1000, `not set up: ${notSetUp.ms} ms`);

  // hook.json points at a port nobody listens on.
  const free = http.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const deadPort = free.address().port;
  await new Promise((r) => free.close(r));
  fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ port: deadPort, token: 'a'.repeat(64) }));
  const notRunning = await runScript({ MEWNDO_DATA_DIR: dir }, input);
  assert.deepStrictEqual([notRunning.code, notRunning.stdout], [0, '']);
  assert.ok(notRunning.ms < 1000, `not running: ${notRunning.ms} ms`);

  // Something listens but never answers.
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ port: hang.address().port, token: 'a'.repeat(64) }));
  const hanging = await runScript({ MEWNDO_DATA_DIR: dir }, input);
  hang.closeAllConnections();
  await new Promise((r) => hang.close(r));
  assert.deepStrictEqual([hanging.code, hanging.stdout], [0, '']);
  assert.ok(hanging.ms < 1000, `hanging: ${hanging.ms} ms`);
});

// --- Installing the Claude Code hooks -----------------------------------------------------------------------------

test('Claude Code hooks: previewed exactly, merged without touching other settings, backed up, idempotent', async () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, 'settings.json');
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';

  const fresh = await planClaudeHooks({ settingsPath, nodePath });
  assert.strictEqual(fresh.exists, false);
  const preview = JSON.parse(fresh.preview);
  assert.deepStrictEqual(Object.keys(preview.hooks), ['SessionStart', 'PreToolUse']);
  assert.strictEqual(preview.hooks.PreToolUse[0].matcher, 'Bash');
  assert.match(preview.hooks.SessionStart[0].hooks[0].command, /^"C:\/Program Files\/nodejs\/node\.exe" ".*\/bin\/mewndo-savepoint\.js"$/);

  const existing = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] },
  };
  const original = `${JSON.stringify(existing, null, 2)}\n`;
  fs.writeFileSync(settingsPath, original);
  const installed = await installClaudeHooks({ settingsPath, nodePath });
  assert.strictEqual(fs.readFileSync(installed.backup, 'utf8'), original, 'backup is the old file');
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(after.model, 'opus');
  assert.deepStrictEqual(after.permissions, existing.permissions);
  assert.deepStrictEqual(after.hooks.Stop, existing.hooks.Stop);
  assert.deepStrictEqual(after.hooks.PreToolUse[0], existing.hooks.PreToolUse[0], "the user's own PreToolUse hook is kept");
  assert.deepStrictEqual(after.hooks.PreToolUse[1], preview.hooks.PreToolUse[0]);
  assert.deepStrictEqual(after.hooks.SessionStart, preview.hooks.SessionStart);

  const again = await installClaudeHooks({ settingsPath, nodePath });
  assert.deepStrictEqual([again.installed, again.backup], [true, null], 'installing twice changes nothing');

  // Mewndo moved (new Node path): the old entries are replaced, the first backup is never overwritten.
  const moved = await installClaudeHooks({ settingsPath, nodePath: 'D:\\node\\node.exe' });
  const afterMove = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(afterMove.hooks.SessionStart.length, 1);
  assert.strictEqual(afterMove.hooks.PreToolUse.length, 2);
  assert.match(afterMove.hooks.SessionStart[0].hooks[0].command, /D:\/node\/node\.exe/);
  assert.notStrictEqual(moved.backup, installed.backup);
  assert.strictEqual(fs.readFileSync(installed.backup, 'utf8'), original);
});

test('Claude Code hooks: a settings file that is not valid JSON is refused and left untouched', async () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, '{ "model": "opus", // a comment }');
  await assert.rejects(installClaudeHooks({ settingsPath, nodePath: '/usr/bin/node' }), /can't be read, so nothing was changed/);
  assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ "model": "opus", // a comment }');
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json'], 'no backup or temp files left');
});
