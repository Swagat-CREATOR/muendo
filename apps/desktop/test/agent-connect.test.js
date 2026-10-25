// Connect agents (engine/agent-connect.js): the v1 hooks that run mewndo-hook.exe, written into Claude Code's,
// Codex's and Cursor's settings under a temporary home folder. Shown first, backed up, installing twice changes
// nothing, the user's own hooks and notify stay, and removing puts the files back.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  planConnect, installConnect, removeConnect, removeAllConnect, isMewndoHook, claudeHooks, codexHooks, cursorHooks, mergeNotify, removeNotify,
  notifyLine, EXE_PLACEHOLDER,
} = require('../engine/agent-connect');
const { removeClaudeHooks } = require('../engine/claude-hooks');
const { tempDir } = require('./helpers');

const REPO = path.join(__dirname, '..', '..', '..');
const PLUGIN_HOOKS = path.join(REPO, 'integrations', 'claude-code', 'hooks', 'hooks.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const env = {}; // no CLAUDE_CONFIG_DIR or CODEX_HOME from the machine running the tests

// A home folder and an installed Mewndo's resources folder (with a stand-in mewndo-hook.exe), both with a space.
function setup({ exe = true } = {}) {
  const base = tempDir();
  const home = path.join(base, 'Ana Maria');
  const resourcesDir = path.join(base, 'Program Files', 'Mewndo', 'resources');
  fs.mkdirSync(path.join(resourcesDir, 'claude-code', 'hooks'), { recursive: true });
  fs.copyFileSync(PLUGIN_HOOKS, path.join(resourcesDir, 'claude-code', 'hooks', 'hooks.json'));
  if (exe) {
    fs.mkdirSync(path.join(resourcesDir, 'claude-code', 'bin'));
    fs.writeFileSync(path.join(resourcesDir, 'claude-code', 'bin', 'mewndo-hook.exe'), 'MZ');
  }
  fs.mkdirSync(home);
  const exePath = path.join(resourcesDir, 'claude-code', 'bin', 'mewndo-hook.exe');
  return { home, resourcesDir, exe: exePath, options: { home, env, resourcesDir } };
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const backupsOf = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.mewndo-backup-`));
const commands = (hooks) => Object.values(hooks).flat().flatMap((g) => (g.hooks ? g.hooks : [g])).map((h) => h.command ?? h.url);

// A user's settings with their own hooks, and Mewndo's v0 hooks (save-point script, HTTP Guard, guard script).
const V0_SAVEPOINT = { type: 'command', command: '"C:/Program Files/nodejs/node.exe" "C:/Mewndo/resources/app.asar.unpacked/bin/mewndo-savepoint.js"', timeout: 5 };
const V0_GUARD = { type: 'http', url: 'http://127.0.0.1:47821/guard', timeout: 5 };
const V0_SCRIPT = (agent) => `"C:/node.exe" "C:/Mewndo/bin/mewndo-guard.js" --agent ${agent}`;
const USER_CLAUDE = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }, V0_SAVEPOINT] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-lint.sh' }] }, { matcher: 'Bash|Write', hooks: [V0_GUARD] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
};

test('the Codex and Cursor hooks are the shipped integrations files, with the real path in place', () => {
  assert.deepStrictEqual(codexHooks(EXE_PLACEHOLDER), readJson(path.join(REPO, 'integrations', 'codex', 'hooks.json')));
  assert.deepStrictEqual(cursorHooks(EXE_PLACEHOLDER), readJson(path.join(REPO, 'integrations', 'cursor', 'hooks.json')));
  const snippet = fs.readFileSync(path.join(REPO, 'integrations', 'codex', 'config.snippet.toml'), 'utf8');
  assert.ok(snippet.includes(`${notifyLine(EXE_PLACEHOLDER)}\n`), 'the notify line is the one config.snippet.toml shows');
});

test('on Windows every Claude Code hook runs in PowerShell, so it works without Git Bash', () => {
  const exe = 'C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\Mewndo\\resources\\claude-code\\bin\\mewndo-hook.exe';
  const template = readJson(PLUGIN_HOOKS);
  const win = claudeHooks(template, exe, { windows: true }).hooks;
  const plain = claudeHooks(template, exe, { windows: false }).hooks;
  const hooks = Object.values(win).flat().flatMap((g) => g.hooks);
  assert.strictEqual(hooks.length, 8);
  for (const h of hooks) {
    assert.strictEqual(h.shell, 'powershell');
    assert.match(h.command, /^& "C:\/Users\/Ana Maria\/[^"]+\/mewndo-hook\.exe" claude [a-z-]+$/);
  }
  // Same events, matchers and timeouts as the plugin's file; only the shell and the `& ` differ.
  for (const [event, groups] of Object.entries(plain)) {
    groups.forEach((g, i) => {
      assert.strictEqual(win[event][i].matcher, g.matcher);
      g.hooks.forEach((h, j) => assert.strictEqual(win[event][i].hooks[j].timeout, h.timeout));
    });
  }
  // Remove still recognises them as Mewndo's.
  for (const h of hooks) assert.ok(isMewndoHook(h), h.command);
});

test('a path with a space is quoted whole in every command, for every agent', () => {
  const exe = 'C:\\Users\\Ana Maria\\AppData\\Local\\Programs\\Mewndo\\resources\\claude-code\\bin\\mewndo-hook.exe';
  const claude = commands(claudeHooks(readJson(PLUGIN_HOOKS), exe, { windows: false }).hooks);
  assert.strictEqual(claude.length, 8);
  for (const c of claude) assert.match(c, /^"C:\/Users\/Ana Maria\/AppData\/Local\/Programs\/Mewndo\/resources\/claude-code\/bin\/mewndo-hook\.exe" claude [a-z-]+$/);
  for (const c of commands(codexHooks(exe).hooks)) assert.match(c, /^"C:\\Users\\Ana Maria\\[^"]+\\mewndo-hook\.exe" codex [a-z-]+$/);
  for (const c of commands(cursorHooks(exe).hooks)) assert.match(c, /^"C:\\Users\\Ana Maria\\[^"]+\\mewndo-hook\.exe" cursor [a-z]+$/);
  // TOML: backslashes doubled, so Codex doesn't read \U and \A as escapes.
  assert.strictEqual(notifyLine(exe), 'notify = ["C:\\\\Users\\\\Ana Maria\\\\AppData\\\\Local\\\\Programs\\\\Mewndo\\\\resources\\\\claude-code\\\\bin\\\\mewndo-hook.exe", "codex", "notify"]');
});

test('without mewndo-hook.exe nothing is planned or written', async () => {
  const { home, options } = setup({ exe: false });
  for (const agent of ['claude', 'codex', 'cursor']) {
    await assert.rejects(installConnect(agent, options), /hook program isn't there.*mewndo-hook\.exe/);
  }
  assert.deepStrictEqual(fs.readdirSync(home), []);
});

test('Claude Code: into an empty home, the eight plugin hooks with the real path, and nothing else', async () => {
  const { home, exe, options } = setup();
  const plan = await planConnect('claude', options);
  assert.strictEqual(plan.installed, false);
  assert.strictEqual(plan.exists, false);
  assert.strictEqual(plan.settingsPath, path.join(home, '.claude', 'settings.json'));
  assert.ok(plan.about.length === 2 && plan.about[1].startsWith("What it can't do"));
  assert.ok(!fs.existsSync(plan.settingsPath), 'planning writes nothing');
  const result = await installConnect('claude', options);
  assert.strictEqual(result.backup, null);
  const settings = readJson(plan.settingsPath);
  assert.deepStrictEqual(Object.keys(settings), ['hooks']);
  assert.deepStrictEqual(Object.keys(settings.hooks), Object.keys(readJson(PLUGIN_HOOKS).hooks));
  assert.deepStrictEqual(JSON.parse(plan.preview), settings);
  const real = `"${exe.replace(/\\/g, '/')}"`;
  for (const c of commands(settings.hooks)) assert.ok(c.startsWith(`${real} claude `), c);
  assert.strictEqual(settings.hooks.PermissionRequest[0].hooks[0].timeout, 300);
});

test('Claude Code: the user\'s hooks and settings stay, v0 hooks go, a backup is kept, twice changes nothing', async () => {
  const { options, home } = setup();
  const file = path.join(home, '.claude', 'settings.json');
  write(file, JSON.stringify(USER_CLAUDE, null, 4));
  const original = fs.readFileSync(file, 'utf8');

  const plan = await planConnect('claude', options);
  assert.match(plan.note, /older hooks \(2\) are taken out/);
  const first = await installConnect('claude', options);
  assert.strictEqual(backupsOf(file).length, 1);
  assert.strictEqual(fs.readFileSync(first.backup, 'utf8'), original);

  const settings = readJson(file);
  assert.strictEqual(settings.model, 'opus');
  assert.deepStrictEqual(settings.permissions, USER_CLAUDE.permissions);
  const all = commands(settings.hooks);
  for (const mine of ['echo hello', 'my-lint.sh', 'say done']) assert.ok(all.includes(mine), mine);
  assert.ok(!all.some((c) => /mewndo-savepoint|\/guard$/.test(c)), 'the v0 save point and Guard are replaced');
  assert.deepStrictEqual(settings.hooks.SessionStart[0], { hooks: [{ type: 'command', command: 'echo hello' }] });
  assert.strictEqual(all.filter((c) => c.includes('mewndo-hook.exe')).length, 8);

  const afterFirst = fs.readFileSync(file, 'utf8');
  assert.strictEqual((await planConnect('claude', options)).installed, true);
  const second = await installConnect('claude', options);
  assert.strictEqual(second.backup, null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), afterFirst);
  assert.strictEqual(backupsOf(file).length, 1);

  await removeConnect('claude', { home, env });
  const back = readJson(file);
  const expected = structuredClone(USER_CLAUDE);
  expected.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo hello' }] }];
  expected.hooks.PreToolUse = [expected.hooks.PreToolUse[0]];
  assert.deepStrictEqual(back, expected, 'everything of the user\'s is back, with only Mewndo\'s entries gone');
  assert.strictEqual(backupsOf(file).length, 2);
});

test('Codex: hooks.json and the notify line into an empty home, then removed again', async () => {
  const { home, exe, options } = setup();
  const plan = await planConnect('codex', options);
  assert.deepStrictEqual(plan.files, [path.join(home, '.codex', 'hooks.json'), path.join(home, '.codex', 'config.toml')]);
  assert.ok(plan.preview.includes(notifyLine(exe)));
  await installConnect('codex', options);
  assert.deepStrictEqual(readJson(plan.files[0]), codexHooks(exe));
  assert.ok(fs.readFileSync(plan.files[1], 'utf8').includes(`${notifyLine(exe)}\n`));
  assert.strictEqual((await planConnect('codex', options)).installed, true);
  const removed = await removeConnect('codex', { home, env });
  assert.strictEqual(removed.removed, 5); // four hooks and the notify block
  assert.deepStrictEqual(readJson(plan.files[0]), {});
  assert.strictEqual(fs.readFileSync(plan.files[1], 'utf8'), '');
});

test('Codex: the user\'s own notify, comments and hooks survive, and removing restores the files', async () => {
  const { home, exe, options } = setup();
  const hooksFile = path.join(home, '.codex', 'hooks.json');
  const configFile = path.join(home, '.codex', 'config.toml');
  const userHooks = {
    hooks: {
      PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'audit.exe' }] }, { matcher: '.*', hooks: [{ type: 'command', command: V0_SCRIPT('codex') }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'hello.exe' }] }],
    },
  };
  write(hooksFile, JSON.stringify(userHooks, null, 2));
  const config = [
    '# my Codex settings',
    'model = "gpt-5-codex"   # the good one',
    'notify = ["python3", "C:\\\\tools\\\\notify.py"]  # pings my phone',
    '',
    '# work profile',
    '[profiles.work]',
    'notify = ["other"]',
    '',
  ].join('\r\n');
  write(configFile, config);

  const plan = await planConnect('codex', options);
  assert.match(plan.note, /older hooks \(1\) are taken out/);
  assert.match(plan.note, /Your own notify line is kept/);
  await installConnect('codex', options);
  assert.strictEqual(backupsOf(hooksFile).length, 1);
  assert.strictEqual(backupsOf(configFile).length, 1);
  assert.strictEqual(fs.readFileSync(path.join(path.dirname(configFile), backupsOf(configFile)[0]), 'utf8'), config);

  const hooks = readJson(hooksFile);
  assert.deepStrictEqual(hooks.hooks.SessionStart, userHooks.hooks.SessionStart);
  assert.deepStrictEqual(hooks.hooks.PreToolUse[0], userHooks.hooks.PreToolUse[0]);
  assert.ok(!commands(hooks.hooks).some((c) => c.includes('mewndo-guard')), 'the v0 guard script is replaced');
  const merged = fs.readFileSync(configFile, 'utf8');
  assert.ok(merged.includes(`# mewndo:was notify = ["python3", "C:\\\\tools\\\\notify.py"]  # pings my phone\r\n${notifyLine(exe)}\r\n`));
  assert.ok(merged.startsWith('# my Codex settings\r\nmodel = "gpt-5-codex"   # the good one\r\n'));
  assert.ok(merged.endsWith('# work profile\r\n[profiles.work]\r\nnotify = ["other"]\r\n'), 'a notify in another table is not touched');

  const afterFirst = [fs.readFileSync(hooksFile, 'utf8'), merged];
  await installConnect('codex', options);
  assert.deepStrictEqual([fs.readFileSync(hooksFile, 'utf8'), fs.readFileSync(configFile, 'utf8')], afterFirst, 'twice changes nothing');
  assert.strictEqual(backupsOf(configFile).length, 1);

  await removeConnect('codex', { home, env });
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), config, 'the user\'s notify is back, byte for byte');
  const expected = structuredClone(userHooks);
  expected.hooks.PreToolUse = [userHooks.hooks.PreToolUse[0]];
  assert.deepStrictEqual(readJson(hooksFile), expected);
});

test('Codex config.toml merge: idempotent, exact to remove, and refuses what it cannot read', () => {
  const exe = 'C:\\Mewndo\\mewndo-hook.exe';
  for (const text of ['', 'a = 1', 'a = 1\n', 'a = 1\r\n[x]\r\nb = 2\r\n', 'notify = [\n  "a", # one\n  "b",\n]\nmodel = "x"\n',
    'desc = """\nnotify = "not a key"\n"""\n', '"notify" = ["q"]\n[t]\n']) {
    const merged = mergeNotify(text, exe);
    assert.strictEqual(mergeNotify(merged, exe), merged, JSON.stringify(text));
    assert.strictEqual(removeNotify(merged), text, JSON.stringify(text));
    assert.strictEqual(merged.split(notifyLine(exe)).length, 2);
  }
  assert.ok(mergeNotify('desc = """\nnotify = "not a key"\n"""\n', exe).includes('notify = "not a key"\n'), 'text inside a string is not a key');
  assert.throws(() => mergeNotify('a = """\nnever closed\n', exe), /multi-line string/);
  assert.throws(() => mergeNotify('notify = ["a",\n', exe), /never closed/);
});

test('Cursor: merged with the user\'s own hooks and version, twice changes nothing, removed again', async () => {
  const { home, exe, options } = setup();
  const file = path.join(home, '.cursor', 'hooks.json');
  const user = { version: 1, hooks: { beforeShellExecution: [{ command: 'my-check.exe' }, { command: V0_SCRIPT('cursor') }], preToolUse: [{ command: V0_SCRIPT('cursor') }], afterFileEdit: [{ command: 'fmt.exe' }] } };
  write(file, JSON.stringify(user));
  const plan = await planConnect('cursor', options);
  assert.match(plan.note, /older hooks \(2\)/);
  await installConnect('cursor', options);
  const merged = readJson(file);
  assert.deepStrictEqual(merged.hooks.beforeShellExecution, [{ command: 'my-check.exe' }, ...cursorHooks(exe).hooks.beforeShellExecution]);
  assert.deepStrictEqual(merged.hooks.afterFileEdit, user.hooks.afterFileEdit);
  assert.strictEqual(merged.hooks.preToolUse, undefined, 'an event that only had the v0 guard is gone');
  const once = fs.readFileSync(file, 'utf8');
  await installConnect('cursor', options);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), once);
  assert.strictEqual(backupsOf(file).length, 1);
  await removeConnect('cursor', { home, env });
  assert.deepStrictEqual(readJson(file), { version: 1, hooks: { beforeShellExecution: [{ command: 'my-check.exe' }], afterFileEdit: [{ command: 'fmt.exe' }] } });
});

test('a settings file that is a link, or not JSON, is refused and left alone', async (t) => {
  const { home, options } = setup();
  const file = path.join(home, '.cursor', 'hooks.json');
  write(file, '{ not json');
  await assert.rejects(installConnect('cursor', options), /can't be read, so nothing was changed/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  const real = path.join(home, 'dotfiles-settings.json');
  write(real, '{}');
  fs.mkdirSync(path.join(home, '.claude'));
  try {
    fs.symlinkSync(real, path.join(home, '.claude', 'settings.json'));
  } catch {
    return t.skip('symbolic links to files need Developer Mode or admin rights on Windows');
  }
  await assert.rejects(installConnect('claude', options), /is a link/);
  assert.strictEqual(fs.readFileSync(real, 'utf8'), '{}');
});

test('uninstalling takes out every agent\'s v0 and v1 entries, and keeps the user\'s', async () => {
  const { home, options } = setup();
  const claudeFile = path.join(home, '.claude', 'settings.json');
  write(claudeFile, JSON.stringify(USER_CLAUDE));
  const codexConfig = path.join(home, '.codex', 'config.toml');
  write(codexConfig, 'notify = ["mine"]\n');
  for (const agent of ['claude', 'codex', 'cursor']) await installConnect(agent, options);

  // What the uninstaller runs (main.js --remove-claude-hooks): the v0 remover, then every agent's v1 entries.
  await removeClaudeHooks({ settingsPath: claudeFile });
  const results = await removeAllConnect({ home, env });
  assert.deepStrictEqual(results.map((r) => r.error), [undefined, undefined, undefined]);
  for (const file of [claudeFile, path.join(home, '.codex', 'hooks.json'), path.join(home, '.cursor', 'hooks.json')]) {
    assert.ok(!commands(readJson(file).hooks ?? {}).some((c) => /mewndo/.test(c)), file);
  }
  assert.ok(commands(readJson(claudeFile).hooks).includes('my-lint.sh'));
  assert.strictEqual(fs.readFileSync(codexConfig, 'utf8'), 'notify = ["mine"]\n');
  // Running it again finds nothing and writes nothing.
  assert.ok((await removeAllConnect({ home, env })).every((r) => r.removed === 0 && !r.backups.length));
});
