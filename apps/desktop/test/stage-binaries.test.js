// The installer's packaging step (build/stage-binaries.js, spec §31.7 and Phase 8): what it stages into the Claude
// Code plugin, and what it refuses to package. Each test builds a throwaway repository tree in a temporary folder
// and points the script at it with MEWNDO_REPO_ROOT, so the real integrations/ folder is never written.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./helpers');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO, 'apps', 'desktop', 'build', 'stage-binaries.js');
const { programKind } = require(SCRIPT);

// The smallest file that reads as a Windows program for `machine`: "MZ", e_lfanew, then "PE\0\0" and the Machine.
function pe(machine = 0x8664) {
  const b = Buffer.alloc(512);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  return b;
}
const elf = () => Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...Buffer.alloc(120)]);

// A repository with everything the installer needs: the real package.json, installer.nsh, icon and plugin, and
// a main.js whose startCore() starts the core with --desk, as the real one does.
function repo({ core = pe(), hook = pe(), mainJs } = {}) {
  const root = tempDir();
  const desktop = path.join(root, 'apps', 'desktop');
  for (const dir of ['app', 'engine', 'bin', 'build']) fs.mkdirSync(path.join(desktop, dir), { recursive: true });
  for (const file of ['package.json', 'build/installer.nsh', 'build/icon.ico']) {
    fs.copyFileSync(path.join(REPO, 'apps', 'desktop', file), path.join(desktop, file));
  }
  fs.writeFileSync(path.join(desktop, 'app', 'main.js'), mainJs ?? [
    'function startCore() {',
    "  core = createCore({ args: ['--desk', deskDir(), '--data', dataDir(), '--rules', rulesFile()] });",
    '}',
    '',
  ].join('\n'));
  fs.cpSync(path.join(REPO, 'integrations', 'claude-code'), path.join(root, 'integrations', 'claude-code'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}bin`),
  });
  const release = path.join(root, 'core', 'target', 'release');
  fs.mkdirSync(release, { recursive: true });
  if (core) fs.writeFileSync(path.join(release, 'mewndo-core.exe'), core);
  if (hook) fs.writeFileSync(path.join(release, 'mewndo-hook.exe'), hook);
  return root;
}

function run(root, ...args) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, MEWNDO_REPO_ROOT: root },
    encoding: 'utf8',
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

const stagedHook = (root) => path.join(root, 'integrations', 'claude-code', 'bin', 'mewndo-hook.exe');

test('programKind tells a 64-bit Windows program from a Linux build, a 32-bit one and junk', () => {
  const dir = tempDir();
  const write = (name, bytes) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    return file;
  };
  assert.strictEqual(programKind(write('x64.exe', pe())), 'windows-x64');
  assert.strictEqual(programKind(write('x86.exe', pe(0x14c))), 'windows-0x14c');
  assert.strictEqual(programKind(write('arm64.exe', pe(0xaa64))), 'windows-0xaa64');
  assert.strictEqual(programKind(write('linux.exe', elf())), 'elf');
  assert.strictEqual(programKind(write('text.exe', 'MZ but not really a program')), null);
  assert.strictEqual(programKind(write('empty.exe', '')), null);
});

test('a good tree: --check writes nothing, and staging copies the hook into the plugin through a rename', () => {
  const root = repo();
  const checked = run(root, '--check');
  assert.strictEqual(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /checked integrations[\\/]claude-code[\\/]bin[\\/]mewndo-hook\.exe \(would copy\)/);
  assert.match(checked.stdout, /mewndo-core\.exe, mewndo-hook\.exe, claude-code/);
  assert.ok(!fs.existsSync(stagedHook(root)), '--check copies nothing');

  const staged = run(root);
  assert.strictEqual(staged.code, 0, staged.stderr);
  assert.deepStrictEqual(fs.readFileSync(stagedHook(root)), pe());
  assert.deepStrictEqual(fs.readdirSync(path.dirname(stagedHook(root))), ['mewndo-hook.exe'], 'no temp file left');
});

test('a Linux or 32-bit build named .exe is refused, and nothing is staged', () => {
  for (const [hook, kind] of [[elf(), 'elf'], [pe(0x14c), 'windows-0x14c'], [Buffer.from('hello'), 'not a program']]) {
    const root = repo({ hook });
    const out = run(root);
    assert.strictEqual(out.code, 1);
    assert.match(out.stderr, new RegExp(`mewndo-hook\\.exe is not a 64-bit Windows program \\(it is ${kind}\\)`));
    assert.match(out.stderr, /nothing was packaged/);
    assert.ok(!fs.existsSync(stagedHook(root)));
  }
  const out = run(repo({ core: elf() }), '--check');
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /mewndo-core\.exe is not a 64-bit Windows program \(it is elf\)/);
});

test('a missing binary is refused with how to build it', () => {
  const out = run(repo({ core: null }), '--check');
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /mewndo-core\.exe is missing from core\/target\/release/);
  assert.match(out.stderr, /cargo build --release/);
});

test('an app that would start the core without --desk is refused', () => {
  const mainJs = "function startCore() {\n  core = createCore({ args: ['--data', dataDir()] });\n}\n// '--desk' elsewhere\n";
  const out = run(repo({ mainJs }), '--check');
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /startCore\(\) does not start the core with '--desk'/);
});

test('a plugin hook that runs anything but the staged bin/mewndo-hook.exe is refused', () => {
  const root = repo();
  const hooksJson = path.join(root, 'integrations', 'claude-code', 'hooks', 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
  hooks.hooks.Stop[0].hooks[0].command = '${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe claude stop'; // unquoted
  fs.writeFileSync(hooksJson, JSON.stringify(hooks));
  const out = run(root, '--check');
  assert.strictEqual(out.code, 1);
  assert.match(out.stderr, /hooks\.json runs \$\{CLAUDE_PLUGIN_ROOT\}\/bin\/mewndo-hook\.exe claude stop, not the staged/);

  fs.writeFileSync(path.join(root, 'integrations', 'claude-code', '.claude-plugin', 'plugin.json'), '{ nope');
  assert.match(run(root, '--check').stderr, /plugin\.json is not readable JSON/);
});

test('the real repository: the config, the plugin and startCore all pass; only the release binaries can be missing', () => {
  // CI and this checkout have no Windows release build in core/target/release, so those lines are expected. Any
  // other problem is a real packaging regression.
  const out = spawnSync(process.execPath, [SCRIPT, '--check'], {
    env: { ...process.env, MEWNDO_REPO_ROOT: '' },
    encoding: 'utf8',
  });
  const problems = out.stderr.split('\n').filter((line) => line.startsWith('stage-binaries:'))
    .filter((line) => !/mewndo-(core|hook)\.exe is (missing from|not a 64-bit Windows program)|nothing was packaged/.test(line));
  assert.deepStrictEqual(problems, []);
});
