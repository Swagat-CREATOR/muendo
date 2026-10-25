// Computer use in the app (spec §36): the On/Off switch's logic, the pinned cua-driver download, and adding
// `mewndo-core mcp-computer --agent <name>` to an agent's MCP settings. No Electron here, so tests run it with
// plain Node; computer-main.js wires it to the windows.
//
// The driver (decisions.md, "cua-driver"): one pinned release of Cua's cua-driver, never a script piped into a
// shell. Mewndo shows its size and where it comes from and downloads it only when the user presses Download. The
// archive must hash to the SHA-256 pinned below before it is unpacked, and every program in it must hash to its own
// pinned SHA-256 before anything is put in place; the core checks those again before it starts the driver
// (core/crates/mewndo-computer/src/vendor.rs, which holds the same values; a test compares the two files).
//
// What it can't do (CLAUDE.md rule 5): unpack without Windows' PowerShell (Expand-Archive); resume a broken
// download (it starts again); check a newer cua-driver (only this pinned one is ever accepted).
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { writeFileAtomic } = require('../engine/store');

const VERSION = '0.34.0';
const TAG = `cua-driver-rs-v${VERSION}`;
const RELEASES = 'https://github.com/trycua/cua/releases';

// Read from the release on 10 October 2026: each archive's size and SHA-256 (the release's own SHA256SUMS, which
// the downloaded bytes matched), and the SHA-256 of each program inside, hashed after the archive matched.
const ARCHES = {
  x64: {
    label: 'windows-x86_64',
    size: 31_316_916,
    unpacked: 87_545_626,
    sha256: 'f96cc1632bc88e6f268eab745277c1fc302bb0f7d123e04373e35afecad6439f',
    files: {
      'cua-driver.exe': '77f5cac754b42b6a8bae126414fc8f7487432ace93466967965188e24e9e53fb',
      'cua-driver-uia.exe': '1c737385f3cf008240ca8ff2a58ffc6810ebd382c14bd3dccb87ccbdc4ced556',
      'cua_driver_sdk.dll': '1dae9015f81bb81b093b12181a1970b0a5cb1c2c992684afc1c629bdfc41728d',
      'cua-cursor-theme.exe': 'bc289b8cc0a4b6a088019115880c260bda2fedc67047c9df6309a3774cd59e25',
      'cua_driver_node_runtime.node': 'ff9194fec31c3279b5ba8bf45dd76335892d9a558090d6ee646b3483400c1ec6',
    },
  },
  arm64: {
    label: 'windows-arm64',
    size: 29_456_947,
    unpacked: 74_840_858,
    sha256: 'bc07c7569456fb50a8c976209ceb09586f399af4391feb668b807a11abbd20e6',
    files: {
      'cua-driver.exe': '0af3e4d677b25bbbce32ed01c80aa8276cc8512d3f8a5b58433f26c0b0b349a4',
      'cua-driver-uia.exe': 'b552844d766e9b386e4e5c9f439de294534f0e93bf247ce70046a7be79060eb8',
      'cua_driver_sdk.dll': 'a05a0477f05854acd86ad879d24b7fe5670761c49d11035f77aa185f3ed3738a',
      'cua-cursor-theme.exe': '4963f0fc3308b695035cd5252d96949bbd07a7877093e463f1dc4fad2aaca406',
      'cua_driver_node_runtime.node': 'b264b75eb898a6035b0b2ddb8f9dc0e5d5a8da7bd240aeae3b2087249d6b9ed1',
    },
  },
};
// Copied beside the programs: Cua's licence and notices, which travel with the binaries.
const TEXT_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

function pin(arch) {
  const a = ARCHES[arch];
  if (!a) throw new Error(`cua-driver has no Windows build for ${arch}`);
  const asset = `cua-driver-rs-${VERSION}-${a.label}.zip`;
  return {
    arch, version: VERSION, tag: TAG, asset, folder: asset.replace(/\.zip$/, ''), size: a.size, unpacked: a.unpacked,
    sha256: a.sha256, files: a.files, url: `${RELEASES}/download/${TAG}/${asset}`, page: `${RELEASES}/tag/${TAG}`,
  };
}

const archOf = (arch = process.arch) => (arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null);

// %LOCALAPPDATA%\Mewndo\vendor\cua-driver, where `mewndo-core mcp-computer` looks (vendor.rs VENDOR_SUBPATH).
function vendorDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Mewndo', 'vendor', 'cua-driver') : null;
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Mewndo', 'vendor', 'cua-driver');
}

// SHA-256 of a file, streamed. A link is refused, never followed (plot.md rule 2).
async function hashFile(file) {
  const st = await fsp.lstat(file);
  if (!st.isFile()) throw new Error(`${file} is not a plain file`);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Every pinned program in `dir`, checked: { verified, missing, problem }. `p`: the pin (tests pass their own).
async function driverStatus(dir, arch, p = pin(arch)) {
  if (!dir) return { verified: false, missing: true, problem: 'Windows did not say where local app data goes (LOCALAPPDATA).' };
  for (const [name, want] of Object.entries(p.files)) {
    const file = path.join(dir, name);
    let got;
    try {
      got = await hashFile(file);
    } catch (e) {
      if (e.code === 'ENOENT') return { verified: false, missing: true, problem: null };
      return { verified: false, missing: false, problem: `${name} can't be checked: ${e.message}` };
    }
    if (got !== want) {
      return { verified: false, missing: false, problem: `${name} is not the pinned cua-driver ${VERSION} (its SHA-256 doesn't match), so it is never run. Download it again.` };
    }
  }
  return { verified: true, missing: false, problem: null };
}

// GET over HTTPS, following GitHub's redirect to its download host. Resolves { total, stream }. A connection that
// sends nothing for `stallMs` is dropped: a download has a deadline even though it is not a model call.
function httpsGet(url, { stallMs = 30_000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) return reject(new Error(`refusing a download that is not HTTPS: ${url}`));
    const req = https.get(url, { headers: { 'user-agent': 'Mewndo' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(httpsGet(new URL(res.headers.location, url).href, { stallMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`the download answered ${res.statusCode}`));
      }
      res.setTimeout(stallMs, () => res.destroy(new Error(`no data for ${stallMs / 1000} s`)));
      return resolve({ total: Number(res.headers['content-length']) || null, stream: res });
    });
    req.setTimeout(stallMs, () => req.destroy(new Error(`no answer for ${stallMs / 1000} s`)));
    req.on('error', reject);
  });
}

// Download the pinned archive to `dir`: to a .part file, hashing as it goes; the .part is renamed to the archive's
// name only when its size and SHA-256 are the pinned ones, and removed otherwise (it is Mewndo's own half-download,
// never a user file). onProgress({ received, total }).
async function download({ arch, dir, get = httpsGet, onProgress = () => {}, pinned = pin(arch) }) {
  const p = pinned;
  await fsp.mkdir(dir, { recursive: true });
  const part = path.join(dir, `${p.asset}.part`);
  const zip = path.join(dir, p.asset);
  const hash = crypto.createHash('sha256');
  let received = 0;
  try {
    const { stream } = await get(p.url);
    const out = fs.createWriteStream(part, { flags: 'w' });
    try {
      for await (const chunk of stream) {
        hash.update(chunk);
        received += chunk.length;
        if (received > p.size) throw new Error(`the download is larger than cua-driver ${VERSION} (${p.size} bytes)`);
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        onProgress({ received, total: p.size });
      }
    } finally {
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    }
    const got = hash.digest('hex');
    if (received !== p.size || got !== p.sha256) {
      throw new Error(`The download is not cua-driver ${VERSION}: expected ${p.size} bytes with SHA-256 ${p.sha256}, got ${received} bytes with ${got}. Nothing was installed.`);
    }
    await fsp.rename(part, zip);
    return zip;
  } catch (e) {
    await fsp.rm(part, { force: true });
    throw e;
  }
}

// Unpack with Windows' own PowerShell (Expand-Archive), into a fresh folder. Elsewhere, `unzip` (dev only).
function expandZip(zip, dest) {
  const quote = (s) => `'${s.replace(/'/g, "''")}'`;
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(dest)}`]]
    : ['unzip', ['-q', zip, '-d', dest]];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120_000 }, (e, _out, err) => (e ? reject(new Error(`the archive could not be unpacked: ${String(err || e.message).trim()}`)) : resolve()));
  });
}

// Unpack a verified archive into `dir`. Every program is checked against its pinned SHA-256 in the staging folder
// before the first one is moved into place, so a bad archive installs nothing. Then the archive and the staging
// folder (Mewndo's own files) are removed.
async function install({ arch, dir, zip, expand = expandZip, pinned = pin(arch) }) {
  const p = pinned;
  const staging = path.join(dir, `.staging-${crypto.randomUUID()}`);
  try {
    await expand(zip, staging);
    const from = path.join(staging, p.folder);
    for (const [name, want] of Object.entries(p.files)) {
      const got = await hashFile(path.join(from, name)).catch((e) => { throw new Error(`the archive has no usable ${name}: ${e.message}`); });
      if (got !== want) throw new Error(`${name} in the archive doesn't match its pinned SHA-256; nothing was installed.`);
    }
    for (const name of [...Object.keys(p.files), ...TEXT_FILES]) {
      const src = path.join(from, name);
      if (TEXT_FILES.includes(name) && !(await fsp.lstat(src).then((s) => s.isFile(), () => false))) continue;
      await fsp.rename(src, path.join(dir, name));
    }
    await writeFileAtomic(path.join(dir, 'mewndo-installed.json'), `${JSON.stringify({ version: VERSION, arch, sha256: p.sha256, at: new Date().toISOString() }, null, 2)}\n`);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.rm(zip, { force: true });
  }
  return driverStatus(dir, arch, p);
}

// --- The switch -------------------------------------------------------------------------------------------------

// What turning computer use on or off does: { on, restart, needsDownload }. On needs the verified driver; without
// it the switch stays off and the download is offered. Off always works and restarts the core without the flag.
function switchPlan({ want, driver }) {
  if (!want) return { on: false, restart: true, needsDownload: false };
  if (!driver?.verified) return { on: false, restart: false, needsDownload: true };
  return { on: true, restart: true, needsDownload: false };
}

// The core's extra arguments: `--computer-use` only when the user turned it on and the driver checked out.
const coreArgs = ({ on, driverVerified }) => (on === true && driverVerified === true ? ['--computer-use'] : []);

// One line for Settings: off, needs the driver, on and waiting, on and running, or paused by a takeover.
function statusText({ on, driver, coreRunning, coreHasFlag, paused, downloading }) {
  if (downloading) return 'Downloading cua-driver…';
  if (!on) return 'Off.';
  if (!driver?.verified) return driver?.problem ?? 'On, but cua-driver is not downloaded yet.';
  if (!coreRunning || !coreHasFlag) return 'On: Mewndo is starting its core with computer use…';
  if (paused) return 'Paused: you used the mouse or keyboard while an agent was acting. Choose Resume when you want it to carry on.';
  return 'On: cua-driver is checked and agents can ask to use the computer. Every action asks you first.';
}

// --- MCP settings for each agent ------------------------------------------------------------------------------

const SERVER = 'mewndo-computer';
const BEGIN = `# ${SERVER}:begin  Added by Mewndo (computer use). Removing it in Mewndo, or deleting this block, takes it out.`;
const END = `# ${SERVER}:end`;
const ADDED_NEWLINE = `# ${SERVER}:added-final-newline`;

const MCP_AGENTS = {
  claude: { name: 'Claude Code', file: ({ home, env }) => (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')), kind: 'json' },
  codex: { name: 'Codex', file: ({ home, env }) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), kind: 'toml' },
  cursor: { name: 'Cursor', file: ({ home }) => path.join(home, '.cursor', 'mcp.json'), kind: 'json' },
};

const serverArgs = (agent) => ['mcp-computer', '--agent', agent];
const jsonEntry = (agent, exe) => (agent === 'claude' ? { type: 'stdio', command: exe, args: serverArgs(agent), env: {} } : { command: exe, args: serverArgs(agent) });

// A TOML basic string (agent-connect.js does the same for Codex's notify line).
const tomlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const tomlBlock = (agent, exe, nl) => [BEGIN, `[mcp_servers.${SERVER}]`, `command = ${tomlString(exe)}`,
  `args = [${serverArgs(agent).map(tomlString).join(', ')}]`, END].join(nl) + nl;

// Mewndo's block taken out, and a final newline it added taken back. Unchanged text when there is none.
function removeTomlBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const endAt = text.indexOf(END, start);
  if (endAt < 0) throw new Error(`Codex's config.toml has the start of Mewndo's ${SERVER} block but not its end, so nothing was changed.`);
  let stop = endAt + END.length;
  if (text.startsWith('\r\n', stop)) stop += 2; else if (text[stop] === '\n') stop += 1;
  const block = text.slice(start, stop);
  let before = text.slice(0, start);
  if (block.includes(ADDED_NEWLINE)) before = before.replace(/\r?\n$/, '');
  return before + text.slice(stop);
}

// Codex: the block appended at the end, where a new [table] can't swallow any of the user's keys.
function mergeToml(text, agent, exe) {
  const clean = removeTomlBlock(text);
  if (new RegExp(`^\\s*\\[\\s*mcp_servers\\.("?)${SERVER}\\1\\s*\\]`, 'm').test(clean)) {
    throw new Error(`Codex's config.toml already has its own [mcp_servers.${SERVER}] section, so nothing was changed.`);
  }
  const nl = clean.includes('\r\n') ? '\r\n' : (process.platform === 'win32' && !clean ? '\r\n' : '\n');
  const needsNewline = clean !== '' && !clean.endsWith('\n');
  const block = needsNewline ? tomlBlock(agent, exe, nl).replace(nl, `${nl}${ADDED_NEWLINE}${nl}`) : tomlBlock(agent, exe, nl);
  return `${clean}${needsNewline ? nl : ''}${block}`;
}

async function readText(file, name) {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '' };
    throw new Error(`${name}'s settings can't be read, so nothing was changed: ${file} (${e.message})`);
  }
  if (st.isSymbolicLink()) throw new Error(`${file} is a link, and Mewndo doesn't change files through links, so nothing was changed. Add the server shown here by hand.`);
  if (!st.isFile()) throw new Error(`${file} isn't a file, so nothing was changed.`);
  return { exists: true, text: await fsp.readFile(file, 'utf8') };
}

function parseJson(text, file, name) {
  if (!text.trim()) return {};
  let value;
  try { value = JSON.parse(text); } catch (e) { throw new Error(`${name}'s settings can't be read, so nothing was changed: ${file} (${e.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} doesn't hold a settings object, so nothing was changed.`);
  if (value.mcpServers !== undefined && (typeof value.mcpServers !== 'object' || value.mcpServers === null || Array.isArray(value.mcpServers))) {
    throw new Error(`"mcpServers" in ${file} isn't a list of servers, so nothing was changed.`);
  }
  return value;
}

const ABOUT = 'The agent gets Mewndo\'s guarded computer tools (computer_click, computer_type_text and the rest) and '
  + 'run_skill for skills you recorded. Every action is checked by Mewndo and asks you first; it works only while '
  + 'Mewndo runs with computer use on.';

// What adding the server would change, without changing it: { agent, name, file, exists, installed, preview, note,
// about, after }.
async function planMcp(agent, { exe, home = os.homedir(), env = process.env }) {
  const a = MCP_AGENTS[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  if (!exe) throw new Error("Mewndo's core program wasn't found, so nothing was changed.");
  const file = a.file({ home, env });
  const { exists, text } = await readText(file, a.name);
  let after;
  let preview;
  if (a.kind === 'json') {
    const value = parseJson(text, file, a.name);
    const entry = jsonEntry(agent, exe);
    const next = { ...value, mcpServers: { ...(value.mcpServers ?? {}), [SERVER]: entry } };
    after = `${JSON.stringify(next, null, 2)}\n`;
    preview = JSON.stringify({ mcpServers: { [SERVER]: entry } }, null, 2);
    const installed = JSON.stringify(value.mcpServers?.[SERVER]) === JSON.stringify(entry);
    return { agent, name: a.name, file, exists, installed, preview, after, about: ABOUT, note: noteFor(installed, exists, a.name) };
  }
  after = mergeToml(text, agent, exe);
  preview = tomlBlock(agent, exe, '\n').trimEnd();
  const installed = after === text;
  return { agent, name: a.name, file, exists, installed, preview, after, about: ABOUT, note: noteFor(installed, exists, a.name) };
}

const noteFor = (installed, exists, name) => (installed
  ? `Already added; nothing needs to change. Remove takes it out of ${name} again.`
  : exists ? 'Everything else in this file stays as it is, and a backup is saved next to it first.' : 'This file will be created.');

// A copy next to the file, named for the time, never overwriting an earlier one (agent-connect.js does the same).
async function backUp(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let n = 1; ; n++) {
    const backup = `${file}.mewndo-backup-${stamp}${n > 1 ? `-${n}` : ''}`;
    try {
      await fsp.copyFile(file, backup, fsp.constants.COPYFILE_EXCL);
      return backup;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

async function installMcp(agent, options) {
  const plan = await planMcp(agent, options);
  if (plan.installed) return { ...plan, backup: null };
  const backup = plan.exists ? await backUp(plan.file) : null;
  await writeFileAtomic(plan.file, plan.after);
  return { ...plan, backup };
}

// Take Mewndo's server out (only Mewndo's: an entry the user changed by hand is still the one called mewndo-computer).
async function removeMcp(agent, { home = os.homedir(), env = process.env } = {}) {
  const a = MCP_AGENTS[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  const file = a.file({ home, env });
  const { exists, text } = await readText(file, a.name);
  if (!exists) return { agent, removed: false, backup: null };
  let after;
  if (a.kind === 'json') {
    const value = parseJson(text, file, a.name);
    if (!value.mcpServers?.[SERVER]) return { agent, removed: false, backup: null };
    const servers = { ...value.mcpServers };
    delete servers[SERVER];
    after = `${JSON.stringify({ ...value, mcpServers: servers }, null, 2)}\n`;
  } else {
    after = removeTomlBlock(text);
    if (after === text) return { agent, removed: false, backup: null };
  }
  const backup = await backUp(file);
  await writeFileAtomic(file, after);
  return { agent, removed: true, backup };
}

// What Settings shows under "What it can't do", from the code and docs/decisions.md.
const LIMITS = [
  'Every action an agent takes on your desktop (a click, typing, a key) shows a card and waits for you. Looking (screenshots, window lists) does not ask.',
  'If you move the mouse or press a key while an agent is acting, every action pauses until you choose Resume.',
  "Mewndo can't see what is under the pointer yet, so a card says \"click at 412, 230\", not the button's name: look at the app before you allow it.",
  'Typed text is shown on the card only as its length, because Mewndo cannot tell a password field from any other.',
  'A click has no undo. Mewndo records what happened, but it cannot put a sent email back.',
  'If Mewndo is not running, or nobody answers within about 5 minutes, the action is refused.',
  'None of this has been run on Windows yet: it is built and tested on Linux with a stand-in for cua-driver.',
];

module.exports = {
  VERSION, TAG, ARCHES, pin, archOf, vendorDir, hashFile, driverStatus, httpsGet, download, expandZip, install,
  switchPlan, coreArgs, statusText, planMcp, installMcp, removeMcp, mergeToml, removeTomlBlock, MCP_AGENTS, SERVER, LIMITS,
};
