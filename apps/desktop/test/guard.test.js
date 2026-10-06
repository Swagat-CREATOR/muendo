// Guard for Claude Code (spec §24.2): fake PreToolUse hook inputs, sent the way Claude Code's HTTP hook sends them,
// to Mewndo's local server, judged by the real mewndo-core. One per rule, plus the fallback when the core is gone.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { createMewndo, connectCore } = require('../engine');
const { fallbackVerdict } = require('../engine/guard');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const base = tempDir();
const root = path.join(base, 'project');
let core;
let client;
let mewndo;
let server;

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
  const dataDir = path.join(base, 'data');
  mewndo = createMewndo({ dataDir, core: client, hookServer: { port: 0 }, journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  await mewndo.start();
  await mewndo.protect(root);
  await mewndo.saveBrief(fs.realpathSync(root), 'Tidy src/app.js and delete legacy.txt when done.');
  server = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook.json'), 'utf8'));
});
after(async () => { await mewndo?.stop(); client?.close(); await core?.stop(); });

// What Claude Code POSTs to an HTTP PreToolUse hook (see the hooks reference), and what it gets back.
async function hook(toolName, toolInput, { token = server.token, sessionId = 'session-1' } = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}/guard`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mewndo-token': token },
    body: JSON.stringify({
      session_id: sessionId, cwd: root, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput,
      permission_mode: 'default', tool_use_id: 'toolu_test',
    }),
  });
  return { status: res.status, body: await res.json() };
}
const decision = (r) => r.body.hookSpecificOutput?.permissionDecision;

test('an out-of-scope delete is denied with a readable reason and advice', { skip }, async () => {
  const r = await hook('Bash', { command: 'rm ../outside.txt' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(decision(r), 'deny');
  assert.match(r.body.hookSpecificOutput.permissionDecisionReason, /^Mewndo: .*outside\.txt is outside the folders your brief covers/);
  assert.match(r.body.hookSpecificOutput.additionalContext, /Keep your changes inside the brief's folder/);
});

test('one fake hook input per rule gets the expected verdict', { skip }, async () => {
  const cases = [
    ['Write', { file_path: path.join(root, 'src/app.js'), content: 'x' }, 'allow'],
    ['Read', { file_path: path.join(root, 'src/app.js') }, 'allow'],
    ['Bash', { command: 'npm test' }, 'allow'],
    ['Write', { file_path: path.join(base, 'elsewhere.txt'), content: 'x' }, 'deny'], // write outside the scope
    ['Bash', { command: 'rm src/old.js' }, 'deny'], // a file the brief doesn't name
    ['Read', { file_path: path.join(root, '.env') }, 'deny'], // a secret
    ['Bash', { command: 'cat .env' }, 'deny'],
    ['Bash', { command: 'rm -rf src' }, 'ask'], // recursive delete
    ['Bash', { command: 'git reset --hard HEAD~1' }, 'ask'],
    ['Bash', { command: 'git clean -fdx' }, 'ask'],
    ['Bash', { command: 'git push --force origin main' }, 'ask'],
  ];
  for (const [tool, input, want] of cases) {
    const r = await hook(tool, input);
    assert.strictEqual(decision(r), want, `${tool} ${JSON.stringify(input)}: ${JSON.stringify(r.body)}`);
  }
  assert.deepStrictEqual((await hook('WebFetch', { url: 'https://example.com' })).body, {}, 'nothing to judge: no opinion');
});

test('an in-scope delete the brief names is allowed, after a save point', { skip }, async () => {
  const journal = mewndo.journals()[0];
  const before = (await journal.listSavePoints()).length;
  const r = await hook('Bash', { command: 'rm legacy.txt' });
  assert.strictEqual(decision(r), 'allow');
  const points = await journal.listSavePoints();
  assert.strictEqual(points.length, before + 1);
  assert.match(points.at(-1).label, /^Before Claude Code deletes: rm legacy\.txt/);
  assert.ok((await journal.getSavePoint(points.at(-1).id)).index['legacy.txt'], 'the file is in the save point');
});

test('a burst in one session is denied', { skip }, async () => {
  let last;
  for (let i = 0; i < 301 && decision(last ?? { body: {} }) !== 'deny'; i++) {
    last = await hook('Write', { file_path: path.join(root, `gen/f${i}.js`), content: 'x' }, { sessionId: 'busy' });
  }
  assert.strictEqual(decision(last), 'deny');
  assert.match(last.body.hookSpecificOutput.permissionDecisionReason, /Too many changes at once/);
});

test('without the token nothing is judged', { skip }, async () => {
  const r = await hook('Bash', { command: 'rm -rf src' }, { token: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('if the core can\'t answer, harmless actions pass and destructive ones are denied (or all pass with fail-open)', async () => {
  assert.strictEqual(fallbackVerdict({ kind: 'shell', command: 'npm test' }).decision, 'allow');
  assert.strictEqual(fallbackVerdict({ kind: 'write', path: '/x' }).decision, 'allow');
  for (const command of ['rm a.txt', 'rm -rf build', 'git reset --hard', 'git push -f', 'Remove-Item x', 'del /s *.log']) {
    assert.strictEqual(fallbackVerdict({ kind: 'shell', command }).decision, 'deny', command);
  }
  assert.strictEqual(fallbackVerdict({ kind: 'shell', command: 'rm -rf build' }, { failOpen: true }).decision, 'allow');

  // A Mewndo whose core is gone answers with those rules.
  const dead = connectCore(path.join(base, 'no-such-core.sock'));
  const m = createMewndo({ dataDir: path.join(base, 'data-dead'), core: dead, journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  try {
    const answer = (command) => m.guard({ session_id: 's', cwd: base, tool_name: 'Bash', tool_input: { command } });
    assert.strictEqual((await answer('rm notes.txt')).hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual((await answer('ls')).hookSpecificOutput.permissionDecision, 'allow');
    m.configure({ guardFailOpen: true });
    assert.strictEqual((await answer('rm notes.txt')).hookSpecificOutput.permissionDecision, 'allow');
  } finally { await m.stop(); }
});
