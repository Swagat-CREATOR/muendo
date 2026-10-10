// Stages the Rust binaries that the installer has to carry (prompt P8.2, spec §38.1), and checks the
// electron-builder config that will carry them. Run by `npm run dist -w apps/desktop` before electron-builder
// and safe to run on its own:
//
//   node apps/desktop/build/stage-binaries.js            copy, then report what was staged
//   node apps/desktop/build/stage-binaries.js --check     verify only; writes nothing, exits 1 on a problem
//
// Plain Node, CommonJS, no dependencies (plot.md). It does three things:
//
//   1. Copies `core/target/release/mewndo-hook.exe` to `integrations/claude-code/bin/mewndo-hook.exe`.
//      Every hook in `integrations/claude-code/hooks/hooks.json` runs `"${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe"`,
//      and that file is a build output, so it is not in the repository - `integrations/claude-code/README.md`
//      says "the build script copies it into bin/ as part of packaging". This is that build script. Without
//      this step the packaged plugin's hooks cannot start, which Claude Code treats as a hook that said
//      nothing: the agent carries on unguarded, silently. That is why a missing binary fails the build here
//      instead of being a warning.
//
//   2. Checks that every input electron-builder is told to copy exists, because electron-builder's own error
//      for a missing `extraResources` entry does not say which prompt or which binary it belonged to.
//
//   3. Checks what will actually run on the user's PC: each binary is a 64-bit Windows program (a Linux build
//      renamed to .exe, or a 32-bit one, would pass every other check and fail only after install), the plugin's
//      hooks.json runs exactly the binary that is staged into it, its plugin.json is readable, and the app starts
//      the core with `--desk` (without it the Agent Desk pipe never opens and every hook falls through).
//
// Why here and not in an electron-builder `afterPack` hook: the plugin copy has to happen *before* packaging,
// since `extraResources` copies the whole `integrations/claude-code` folder - including `bin/` - into the
// installed app.
//
// The write goes to a temp file and is then renamed into place (plot.md rule 4), so a failure part-way through
// never leaves half an .exe where a hook will try to run it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The repository root. Overridable so this script can be exercised against a throwaway tree in a test or by
// hand, without writing into the real integrations/ folder.
const ROOT = process.env.MEWNDO_REPO_ROOT
  ? path.resolve(process.env.MEWNDO_REPO_ROOT)
  : path.resolve(__dirname, '..', '..', '..');

const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const RELEASE = path.join(ROOT, 'core', 'target', 'release');
const PLUGIN = path.join(ROOT, 'integrations', 'claude-code');

// Windows is the only platform Mewndo installs on (spec §28.9), so the names are the Windows ones always -
// not `process.platform`'s. The plugin's hook commands run `bin\mewndo-hook.exe` by that exact name, and an
// installer made from a Linux-named binary could not work. On a non-Windows host the inputs are simply absent
// unless the release build was cross-compiled to Windows, and --check says so plainly.
const EXE = '.exe';

// What the installer must carry, and why. Keep in step with `build.extraResources` in package.json.
const BINARIES = [
  {
    name: `mewndo-core${EXE}`,
    why: 'the always-on service: hook server, Inbox, restores (§38.1)',
    // Shipped next to the app; app/main.js `coreBinary()` reads it from process.resourcesPath.
    to: 'resources',
  },
  {
    name: `mewndo-hook${EXE}`,
    why: 'the hook forwarder every agent action runs (§38.1, §33.10 Part B)',
    // Twice over: once next to the app, and once inside the Claude Code plugin folder, because the hook
    // commands address it through ${CLAUDE_PLUGIN_ROOT} and not through the app's resources.
    to: 'resources and the Claude Code plugin',
    plugin: path.join(PLUGIN, 'bin'),
  },
];

// x86-64, in the PE header's Machine field. Mewndo ships one Windows build (§28.9), and it is this one.
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

// What kind of program a file is, from its first bytes: 'windows-x64', another Windows architecture, 'elf'
// (a Linux build), 'mach-o', or null for anything else. Reads at most the first 4 KB.
function programKind(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    if (n >= 4 && head.readUInt32BE(0) === 0x7f454c46) return 'elf';
    if (n >= 4 && [0xfeedfacf, 0xcffaedfe].includes(head.readUInt32BE(0))) return 'mach-o';
    if (n < 64 || head.toString('latin1', 0, 2) !== 'MZ') return null;
    const pe = head.readUInt32LE(0x3c); // e_lfanew: where the "PE\0\0" signature is
    if (pe + 6 > n || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
    const machine = head.readUInt16LE(pe + 4);
    return machine === IMAGE_FILE_MACHINE_AMD64 ? 'windows-x64' : `windows-0x${machine.toString(16)}`;
  } finally {
    fs.closeSync(fd);
  }
}

// The Claude Code plugin as it will be installed: its manifest must be readable, and every hook command must run
// the binary this script stages into bin/, by that exact name. A hook that names another file cannot start, which
// Claude Code treats as a hook that said nothing.
function checkPlugin() {
  const manifest = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
  try {
    const plugin = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!plugin.name) problem('integrations/claude-code/.claude-plugin/plugin.json has no "name"');
  } catch (e) {
    problem(`integrations/claude-code/.claude-plugin/plugin.json is not readable JSON: ${e.message}`);
  }
  const hook = BINARIES.find((b) => b.plugin).name;
  for (const file of ['hooks.json', 'hooks.fallback.json']) {
    const where = path.join(PLUGIN, 'hooks', file);
    if (!fs.existsSync(where)) {
      if (file === 'hooks.json') problem('integrations/claude-code/hooks/hooks.json is missing');
      continue;
    }
    let hooks;
    try {
      hooks = JSON.parse(fs.readFileSync(where, 'utf8')).hooks;
    } catch (e) {
      problem(`integrations/claude-code/hooks/${file} is not readable JSON: ${e.message}`);
      continue;
    }
    const commands = Object.values(hooks || {}).flat().flatMap((group) => group.hooks || []).map((h) => h.command);
    if (!commands.length) problem(`integrations/claude-code/hooks/${file} has no hook commands`);
    for (const command of commands) {
      if (!String(command).startsWith(`"\${CLAUDE_PLUGIN_ROOT}/bin/${hook}" `)) {
        problem(`integrations/claude-code/hooks/${file} runs ${command}, not the staged bin/${hook}`);
      }
    }
  }
}

// The app must start the core with --desk (spec §33.10 Part A): that is what opens the pipe mewndo-hook.exe talks
// to. app/main.js builds the arguments in startCore(); a text check, because main.js needs Electron to load.
function checkCoreArgs() {
  const main = path.join(DESKTOP, 'app', 'main.js');
  let text = '';
  try {
    text = fs.readFileSync(main, 'utf8');
  } catch (e) {
    problem(`apps/desktop/app/main.js is not readable: ${e.message}`);
    return;
  }
  const start = text.indexOf('function startCore(');
  const body = start === -1 ? '' : text.slice(start, text.indexOf('\n}\n', start));
  if (!/args:\s*\[[^\]]*'--desk'/.test(body)) {
    problem("app/main.js startCore() does not start the core with '--desk', so the Agent Desk pipe would never open");
  }
}

function problem(message) {
  process.exitCode = 1;
  console.error(`stage-binaries: ${message}`);
}

// Copy through a temp file in the destination folder, then rename (plot.md rule 4). Same-folder so the rename
// is atomic rather than a cross-device copy.
function copyAtomic(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const temp = `${to}.staging-${process.pid}`;
  try {
    fs.copyFileSync(from, temp);
    fs.renameSync(temp, to);
  } catch (e) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing useful to do: the original error below is the one that matters.
    }
    throw e;
  }
}

// --- the electron-builder config ---------------------------------------------------------------------------------
// electron-builder cannot run on this machine (it needs Windows tooling to make an NSIS installer), so the most
// that can be done here is to check that the config is readable and that everything it points at exists. That
// is a long way from "the installer works": see the note in the root README.md.
function checkConfig() {
  const manifest = path.join(DESKTOP, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (e) {
    problem(`${manifest} is not readable JSON: ${e.message}`);
    return null;
  }
  const build = pkg.build;
  if (!build) {
    problem('package.json has no "build" block, so electron-builder has nothing to do');
    return null;
  }

  // Everything named in `files` is copied into the app, so a typo means a missing module at runtime.
  for (const pattern of build.files || []) {
    const top = String(pattern).split('/')[0];
    if (top !== 'package.json' && !fs.existsSync(path.join(DESKTOP, top))) {
      problem(`build.files names ${pattern}, but ${top} does not exist in apps/desktop`);
    }
  }

  // The inputs electron-builder copies from outside the app folder. The two release binaries are checked in
  // main(), which can say how to build them, so only the rest is checked here.
  for (const entry of build.extraResources || []) {
    const from = path.resolve(DESKTOP, entry.from);
    if (!from.startsWith(RELEASE) && !fs.existsSync(from)) {
      problem(`build.extraResources needs ${entry.from}, which is missing`);
    }
  }

  for (const [what, rel] of [
    ['win.icon', build.win && build.win.icon],
    ['nsis.include', build.nsis && build.nsis.include],
  ]) {
    if (!rel) problem(`build.${what} is not set`);
    else if (!fs.existsSync(path.join(DESKTOP, rel))) problem(`build.${what} points at ${rel}, which is missing`);
  }

  // P8.2: signed auto-updates wait on a certificate that does not exist. Nothing here may claim otherwise, so
  // the config must not carry an update feed or a signing identity.
  if (build.publish !== null) {
    problem('build.publish must be null until there is a code-signing certificate (P8.2); see README.md');
  }
  for (const claim of ['certificateFile', 'certificateSubjectName', 'certificateSha1', 'sign']) {
    if (build.win && build.win[claim] !== undefined) {
      problem(`build.win.${claim} is set, but there is no code-signing certificate; see README.md`);
    }
  }

  // The installer's own steps (start at login, and the uninstall questions) live in this file.
  const nsh = build.nsis && build.nsis.include && path.join(DESKTOP, build.nsis.include);
  if (nsh && fs.existsSync(nsh)) {
    const text = fs.readFileSync(nsh, 'utf8');
    for (const macro of ['customInstall', 'customUnInstall']) {
      if (!text.includes(`!macro ${macro}`)) problem(`${build.nsis.include} has no ${macro} macro`);
    }
    if (!text.includes('CurrentVersion\\Run')) {
      problem(`${build.nsis.include} does not set the Run key, so the core would not start at login (P8.2)`);
    }
  }
  return build;
}

function main(check = process.argv.includes('--check')) {
  const build = checkConfig();
  checkPlugin();
  checkCoreArgs();
  const staged = [];

  for (const binary of BINARIES) {
    const from = path.join(RELEASE, binary.name);
    if (!fs.existsSync(from)) {
      problem(
        `${binary.name} is missing from core/target/release (${binary.why}).\n` +
          '  Build it first:  cargo build --release --manifest-path core/Cargo.toml\n' +
          '  On a non-Windows host that produces a Linux binary, not an .exe: the installer needs a\n' +
          '  Windows build (--target x86_64-pc-windows-msvc, or a Windows machine).',
      );
      continue;
    }
    const kind = programKind(from);
    if (kind !== 'windows-x64') {
      problem(
        `core/target/release/${binary.name} is not a 64-bit Windows program (it is ${kind || 'not a program'}).\n` +
          '  Build it on Windows, or with --target x86_64-pc-windows-msvc, and copy that build here.',
      );
      continue;
    }
    if (!binary.plugin) continue;
    const to = path.join(binary.plugin, binary.name);
    if (check) {
      staged.push(`${path.relative(ROOT, to)} (would copy)`);
      continue;
    }
    try {
      copyAtomic(from, to);
      staged.push(path.relative(ROOT, to));
    } catch (e) {
      problem(`could not copy ${binary.name} to ${path.relative(ROOT, to)}: ${e.message}`);
    }
  }

  if (process.exitCode) {
    console.error('stage-binaries: nothing was packaged. Fix the above and run it again.');
    return;
  }
  const how = check ? 'checked' : 'staged';
  console.log(`stage-binaries: ${how} ${staged.length ? staged.join(', ') : 'nothing to copy'}`);
  if (build) {
    const names = (build.extraResources || []).map((e) => e.to).join(', ');
    console.log(`stage-binaries: the installer will carry ${names}`);
  }
  if (check) {
    console.log(
      'stage-binaries: config only. No installer was produced, and electron-builder has never run here.',
    );
  }
}

if (require.main === module) main();

module.exports = { main, programKind, BINARIES };
