// Guard test harness (spec §31.3 step 10): a scripted fake agent for each of Claude Code, Codex and Cursor sends
// hook inputs the way the real one does, through the same door (Claude Code: the HTTP hook; Codex and Cursor: the
// hook command bin/mewndo-guard.js), and does on disk only what it was allowed to. The real mewndo-core judges.
// Runs: in-scope edits, an out-of-scope delete, a secret file read, a recursive delete, a 300-file burst, and a run
// that drifts three times. Each checks the verdict, and where it applies the brake, the heal and the resume card.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCore } = require('../app/core');
const { createMewndo, connectCore } = require('../engine');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const GUARD = path.join(__dirname, '..', 'bin', 'mewndo-guard.js');
const NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// The fake agent. Each step's hook input is in that agent's own format; the answer comes back as
// { decision: allow | deny | ask | stop, text }. stop: Mewndo braked it.
function fakeAgent(kind, { dataDir, server }) {
  const stopped = (text) => /Mewndo stopped this session/.test(text ?? '');
  async function send(input) {
    if (kind === 'claude') {
      const res = await fetch(`http://127.0.0.1:${server.port}/guard`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mewndo-token': server.token }, body: JSON.stringify(input),
      });
      const body = await res.json();
      if (body.continue === false) return { decision: 'stop', text: body.stopReason };
      const out = body.hookSpecificOutput ?? {};
      return { decision: out.permissionDecision ?? 'allow', text: out.permissionDecisionReason ?? '' };
    }
    const { code, stdout } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD, '--agent', kind], { env: { ...process.env, MEWNDO_DATA_DIR: dataDir } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('exit', (c) => resolve({ code: c, stdout: out }));
      child.stdin.end(JSON.stringify(input));
    });
    const out = stdout.trim() ? JSON.parse(stdout) : {};
    if (kind === 'codex') {
      const text = out.hookSpecificOutput?.permissionDecisionReason ?? '';
      const decision = code === 2 ? 'deny' : out.hookSpecificOutput?.permissionDecision ?? 'allow';
      return { decision: stopped(text) ? 'stop' : decision, text };
    }
    return { decision: stopped(out.agent_message) ? 'stop' : out.permission ?? 'allow', text: out.agent_message ?? '' };
  }
  // The steps a script is made of, as each agent would send them.
  return {
    edit: (cwd, session, rel) => send({
      claude: { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, rel), old_string: 'a', new_string: 'b' } },
      codex: { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${rel}\n@@\n-a\n+b\n*** End Patch` } },
      cursor: { conversation_id: session, cwd, hook_event_name: 'preToolUse', tool_name: 'edit_file', tool_input: { target_file: path.join(cwd, rel) } },
    }[kind]),
    read: (cwd, session, rel) => send({
      claude: { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, rel) } },
      codex: { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `cat ${rel}` } },
      cursor: { conversation_id: session, cwd, hook_event_name: 'preToolUse', tool_name: 'Read', tool_input: { file_path: rel } },
    }[kind]),
    shell: (cwd, session, command) => send(kind === 'cursor'
      ? { conversation_id: session, cwd, hook_event_name: 'beforeShellExecution', command }
      : { session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
  };
}

// A Mewndo with a hook server; a folder with a brief, one without (for the burst), and a file outside both.
async function setup(kind) {
  const dir = path.join(base, kind);
  const project = path.join(dir, 'project');
  const open = path.join(dir, 'open');
  for (const f of ['src/app.js', 'notes.md', 'keep1.txt', 'keep2.txt', 'keep3.txt', '.env']) {
    fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
    fs.writeFileSync(path.join(project, f), `content of ${f}`);
  }
  fs.mkdirSync(open);
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(open, `f${i}.txt`), `${i}`);
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'not in the brief');
  const dataDir = path.join(dir, 'data');
  const mewndo = createMewndo({ dataDir, core: client, hookServer: { port: 0 }, journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  await mewndo.start();
  await mewndo.protect(project);
  await mewndo.protect(open);
  const root = fs.realpathSync(project);
  await mewndo.saveBrief(root, 'Refactor src/app.js. You may delete notes.md.');
  for (const j of mewndo.journals()) await j.createSavePoint({ label: 'start' });
  const server = JSON.parse(fs.readFileSync(path.join(dataDir, 'hook.json'), 'utf8'));
  const drifts = [];
  mewndo.on('drift', (d) => drifts.push(d));
  return { mewndo, root, open: fs.realpathSync(open), agent: fakeAgent(kind, { dataDir, server }), drifts };
}

const RECURSIVE = { claude: 'ask', codex: 'deny', cursor: 'ask' }; // Codex has no "ask": refused, told to ask the user

for (const kind of ['claude', 'codex', 'cursor']) {
  const name = NAMES[kind];
  test(`${name}: every scripted run gets the expected verdict, brake, heal and resume card`, { skip }, async () => {
    const { mewndo, root, open, agent, drifts } = await setup(kind);
    try {
      // In-scope edits: allowed, and the agent makes them.
      assert.strictEqual((await agent.edit(root, 'edits', 'src/app.js')).decision, 'allow', 'in-scope edit');
      fs.writeFileSync(path.join(root, 'src/app.js'), 'refactored');

      // An out-of-scope delete, a secret read, a recursive delete: refused or asked, with a reason it can read.
      const outside = await agent.shell(root, 'outside', 'rm ../outside.txt');
      assert.strictEqual(outside.decision, 'deny', 'out-of-scope delete');
      assert.match(outside.text, /outside\.txt is outside the folders your brief covers/);
      const secret = await agent.read(root, 'secret', '.env');
      assert.strictEqual(secret.decision, 'deny', 'secret read');
      assert.match(secret.text, /\.env is an environment file with secrets/);
      assert.strictEqual((await agent.shell(root, 'recursive', 'rm -rf src')).decision, RECURSIVE[kind], 'recursive delete');
      assert.ok(fs.existsSync(path.join(root, 'src/app.js')));

      // A 300-file burst: braked on the spot, and every further action refused until the user resumes it.
      const files = Array.from({ length: 300 }, (_, i) => `f${i}.txt`).join(' ');
      const burst = await agent.shell(open, 'burst', `rm ${files}`);
      assert.strictEqual(burst.decision, 'stop', 'burst');
      assert.match(burst.text, /too many changes at once/);
      assert.deepStrictEqual(mewndo.braked().map((b) => b.agent), [name]);
      assert.strictEqual((await agent.shell(root, 'burst', 'npm test')).decision, 'stop', 'braked until resumed');
      const afterBurst = await mewndo.resumeAgent(name);
      assert.match(afterBurst.card, /Mewndo braked you: it tried too many changes at once/);
      assert.strictEqual(fs.readdirSync(open).filter((f) => /^f\d+\.txt$/.test(f)).length, 300, 'nothing deleted');

      // A run that drifts three times: a harmless command, then deletes the hooks never saw. Healed twice, then
      // braked and handed to the user.
      assert.strictEqual((await agent.shell(root, 'drift', 'node tidy.js')).decision, 'allow');
      for (const [i, f] of ['keep1.txt', 'keep2.txt', 'keep3.txt'].entries()) {
        const before = drifts.length;
        fs.rmSync(path.join(root, f));
        for (let t = 0; drifts.length === before && t < 200; t++) await sleep(50);
        const d = drifts.at(-1);
        assert.strictEqual(d?.agent, name, `a drift for ${f}`);
        assert.strictEqual(d.action, i < 2 ? 'healed' : 'braked', f);
        await sleep(500); // the heal's own restore settles (Linux's dev watcher needs a moment)
      }
      assert.strictEqual(drifts.at(-1).handoff, true);
      assert.ok(fs.existsSync(path.join(root, 'keep1.txt')) && fs.existsSync(path.join(root, 'keep2.txt')), 'healed');
      assert.strictEqual((await agent.edit(root, 'drift', 'src/app.js')).decision, 'stop', 'braked after three drifts');

      // Resume: a verified Continue card, handed over the way this agent takes it.
      const r = await mewndo.resumeAgent(name);
      assert.match(r.card, /Refactor src\/app\.js/);
      assert.match(r.card, /Verified \(journal\): edited src\/app\.js/);
      assert.match(r.card, /went outside its brief three times/);
      assert.match(r.card, /Mewndo put back keep1\.txt/);
      assert.match(r.card, /Mewndo put back keep2\.txt/);
      assert.match(r.card, /Do not delete `keep3\.txt` unless I name it\. \(new\)/);
      assert.ok(r.card.length <= 1800);
      if (kind === 'claude') assert.deepStrictEqual([r.inject, r.command], ['SessionStart hook', 'claude --resume drift']);
      if (kind === 'codex') assert.ok(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').includes(r.card));
      if (kind === 'cursor') assert.ok(fs.readFileSync(path.join(root, '.cursor/rules/mewndo-continue.mdc'), 'utf8').includes(r.card));
      assert.strictEqual((await agent.edit(root, 'resumed', 'src/app.js')).decision, 'allow', 'resumed');
    } finally { await mewndo.stop(); }
  });
}
