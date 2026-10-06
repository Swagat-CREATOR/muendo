// Guard for Codex and Cursor: installing their hooks (shown first, backed up, twice changes nothing), and fake hook
// inputs run through bin/mewndo-guard.js, the way each agent runs it, against a running Mewndo and mewndo-core.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCore } = require('../app/core');
const { createMewndo, connectCore, planAgentHooks, installAgentHooks, GUARD_SCRIPT } = require('../engine');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const base = tempDir();
const root = path.join(base, 'project');
const dataDir = path.join(base, 'data');
let core;
let client;
let mewndo;

before(async () => {
  if (skip) return;
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of ['src/app.js', 'src/old.js', 'legacy.txt', '.env']) fs.writeFileSync(path.join(root, f), f);
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: CORE_BINARY, runDir: base, logDir: path.join(base, 'logs'), log: { info() {}, warn() {}, error() {} },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
  client = connectCore(core.address);
  mewndo = createMewndo({ dataDir, core: client, hookServer: { port: 0 }, journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  await mewndo.start();
  await mewndo.protect(root);
  await mewndo.saveBrief(fs.realpathSync(root), 'Tidy src/app.js and delete legacy.txt when done.');
});
after(async () => { await mewndo?.stop(); client?.close(); await core?.stop(); });

// Run the guard script as the agent would: hook input on stdin. Returns { code, out (parsed JSON or null), err }.
function runGuard(agent, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GUARD_SCRIPT, '--agent', agent], { env: { ...process.env, MEWNDO_DATA_DIR: dataDir, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out: out.trim() ? JSON.parse(out) : null, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Codex: shell commands, apply_patch edits and MCP calls get the expected verdicts', { skip }, async () => {
  const codex = (tool_name, tool_input) => runGuard('codex', { session_id: 'c1', cwd: root, hook_event_name: 'PreToolUse', tool_name, tool_input });
  const deny = (r) => r.out?.hookSpecificOutput?.permissionDecision === 'deny';

  const ok = await codex('Bash', { command: 'npm test' });
  assert.deepStrictEqual([ok.code, ok.out], [0, null], 'allowed: no output');
  const outside = await codex('Bash', { command: 'rm ../elsewhere.txt' });
  assert.ok(deny(outside), JSON.stringify(outside));
  assert.match(outside.out.hookSpecificOutput.permissionDecisionReason, /outside the folders your brief covers/);
  assert.ok(deny(await codex('Bash', { command: 'rm src/old.js' })), 'unnamed delete');
  const reset = await codex('Bash', { command: 'git reset --hard' });
  assert.ok(deny(reset), 'Codex has no "ask": refused, and told to ask the user');
  assert.match(reset.out.hookSpecificOutput.permissionDecisionReason, /Ask the user to confirm/);

  const patch = (body) => codex('apply_patch', { command: `*** Begin Patch\n${body}\n*** End Patch` });
  assert.deepStrictEqual((await patch('*** Update File: src/app.js\n@@\n-a\n+b')).out, null, 'editing a file in scope');
  assert.ok(deny(await patch('*** Delete File: src/old.js')), 'a patch deleting a file the brief does not name');
  assert.ok(deny(await patch('*** Add File: ../escape.js\n+x')), 'a patch writing outside the scope');

  assert.ok(deny(await codex('mcp__files__read_file', { path: path.join(root, '.env') })), 'an MCP call reading a secret');
  assert.deepStrictEqual((await codex('mcp__files__read_file', { path: path.join(root, 'src/app.js') })).out, null);
});

test('Cursor: preToolUse and beforeShellExecution get permission and an agent_message', { skip }, async () => {
  const shell = await runGuard('cursor', { conversation_id: 'k1', cwd: root, command: 'rm src/old.js' });
  assert.strictEqual(shell.code, 0);
  assert.strictEqual(shell.out.permission, 'deny');
  assert.match(shell.out.agent_message, /doesn't name/);
  assert.match(shell.out.user_message, /^Mewndo: /);
  const tool = await runGuard('cursor', { conversation_id: 'k1', cwd: root, tool_name: 'Shell', tool_input: { command: 'git push --force' } });
  assert.strictEqual(tool.out.permission, 'ask');
  assert.strictEqual((await runGuard('cursor', { conversation_id: 'k1', cwd: root, tool_name: 'Read', tool_input: { file_path: '.env' } })).out.permission, 'deny');
  assert.strictEqual((await runGuard('cursor', { conversation_id: 'k1', cwd: root, command: 'ls' })).out.permission, 'allow');
});

test('when Mewndo is not running, harmless actions pass and destructive ones are refused', async () => {
  const env = { MEWNDO_DATA_DIR: path.join(base, 'nothing-here') };
  const ls = await runGuard('codex', { cwd: base, tool_name: 'Bash', tool_input: { command: 'ls' } }, env);
  assert.deepStrictEqual([ls.code, ls.out], [0, null]);
  const rm = await runGuard('codex', { cwd: base, tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }, env);
  assert.strictEqual(rm.code, 2, 'Codex: exit code 2 blocks');
  assert.match(rm.err, /couldn't check this action/);
  const cursor = await runGuard('cursor', { cwd: base, command: 'git reset --hard' }, env);
  assert.deepStrictEqual([cursor.code, cursor.out.permission], [0, 'deny']);
});

test('installing: the exact change shown first, other hooks kept, a backup, and twice changes nothing', async () => {
  for (const agent of ['codex', 'cursor']) {
    const dir = tempDir();
    const settingsPath = path.join(dir, 'hooks.json');
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const fresh = await planAgentHooks(agent, { settingsPath, nodePath });
    assert.strictEqual(fresh.exists, false);
    const preview = JSON.parse(fresh.preview);
    const commands = [];
    JSON.stringify(preview, (k, v) => { if (k === 'command') commands.push(v); return v; });
    assert.ok(commands.length, fresh.preview);
    for (const c of commands) assert.match(c, new RegExp(`mewndo-guard\\.js" --agent ${agent}$`), c);

    const own = agent === 'codex'
      ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }
      : { version: 1, hooks: { afterFileEdit: [{ command: 'format.sh' }], beforeShellExecution: [{ command: 'audit.sh' }] } };
    const original = `${JSON.stringify(own, null, 2)}\n`;
    fs.writeFileSync(settingsPath, original);
    const installed = await installAgentHooks(agent, { settingsPath, nodePath });
    assert.strictEqual(fs.readFileSync(installed.backup, 'utf8'), original, `${agent}: backup is the old file`);
    const now = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (agent === 'codex') {
      assert.deepStrictEqual(now.hooks.Stop, own.hooks.Stop);
      assert.deepStrictEqual(now.hooks.PreToolUse[0], own.hooks.PreToolUse[0], 'their own hook is kept');
      assert.deepStrictEqual(now.hooks.PreToolUse[1], preview.hooks.PreToolUse[0]);
    } else {
      assert.strictEqual(now.version, 1);
      assert.deepStrictEqual(now.hooks.afterFileEdit, own.hooks.afterFileEdit);
      assert.deepStrictEqual(now.hooks.beforeShellExecution, [{ command: 'audit.sh' }, ...preview.hooks.beforeShellExecution]);
      assert.deepStrictEqual(now.hooks.preToolUse, preview.hooks.preToolUse);
    }
    const again = await installAgentHooks(agent, { settingsPath, nodePath });
    assert.deepStrictEqual([again.installed, again.backup], [true, null], `${agent}: installing twice changes nothing`);
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), `${JSON.stringify(now, null, 2)}\n`);

    fs.writeFileSync(settingsPath, '{ broken');
    await assert.rejects(installAgentHooks(agent, { settingsPath, nodePath }), /can't be read, so nothing was changed/);
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ broken');
  }
});
