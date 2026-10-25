// Connect agents (spec §22.2, §33.10 Parts C and F): installs the v1 hooks, which run mewndo-hook.exe. It forwards
// every hook to mewndo-core's Agent Desk, so permission questions, Done cards and receipts appear beside the dock.
//   Claude Code  ~/.claude/settings.json  the eight hooks of integrations/claude-code/hooks/hooks.json (§38.4)
//   Codex        ~/.codex/hooks.json      PreToolUse, PermissionRequest, PostToolUse, Stop (integrations/codex)
//                ~/.codex/config.toml     notify = [<mewndo-hook.exe>, "codex", "notify"], for the Done card
//   Cursor       ~/.cursor/hooks.json     beforeShellExecution, beforeMCPExecution, afterAgentResponse, stop
// Same rules as the v0 installers (claude-hooks.js, agent-hooks.js): the exact change is shown first (plan), the
// user's own hooks and settings stay, a timestamped backup is written next to a file before it changes, and
// installing twice changes nothing. The v1 hooks replace Mewndo's v0 ones (the save-point script, the HTTP Guard
// and the guard script), which are taken out: Claude Code's v1 hooks ask for a save point on every prompt and the
// core's Router is the guard for all three. Remove takes out exactly Mewndo's entries, v0 or v1, and puts a user's
// own Codex `notify` back.
// What it can't do: install without mewndo-hook.exe (it refuses); change a settings file that is a link (it
// refuses, plot.md rule 2: add the hooks by hand); make the agents load the files (a running agent may need a
// restart). Codex and Cursor have not been tried on a real run (docs/known-issues.md).
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('./store');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const EXE = 'mewndo-hook.exe'; // Windows only (spec §28.9): the plugin's hooks run it by this exact name
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe'; // what the plugin's hooks.json runs
// The path the shipped integrations/codex and integrations/cursor files carry (mewndo-core codex.rs EXE_PLACEHOLDER).
const EXE_PLACEHOLDER = 'C:\\Users\\<you>\\AppData\\Local\\Mewndo\\bin\\mewndo-hook.exe';

// Mewndo's own entries: v1 hooks run mewndo-hook, v0 ones the save-point or guard script or the HTTP Guard.
function ours(h) {
  const command = String(h?.command ?? '');
  return /mewndo-hook(\.exe)?"?(\s|$)/i.test(command) || command.includes('mewndo-savepoint') || command.includes('mewndo-guard')
    || /^http:\/\/127\.0\.0\.1:\d+\/guard$/.test(String(h?.url ?? ''));
}

const AGENTS = {
  claude: { name: 'Claude Code', files: ({ home, env }) => ({ hooks: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json') }) },
  codex: {
    name: 'Codex',
    files: ({ home, env }) => {
      const dir = env.CODEX_HOME || path.join(home, '.codex');
      return { hooks: path.join(dir, 'hooks.json'), config: path.join(dir, 'config.toml') };
    },
  },
  cursor: { name: 'Cursor', files: ({ home }) => ({ hooks: path.join(home, '.cursor', 'hooks.json') }) },
};
const CONNECT_AGENTS = Object.keys(AGENTS);

const ABOUT = {
  claude: [
    "Claude Code will run Mewndo's hook program (mewndo-hook.exe) when a session starts, on every prompt (a save point "
      + 'before the turn), before and after every tool, on permission prompts and notifications, and when it stops. '
      + 'Permission questions appear as cards beside the dock; a finished turn gets a Done card with its receipt.',
    "What it can't do: while Mewndo isn't running, Claude Code carries on as usual (the hook still refuses actions on "
      + "paths Mewndo's rules protect, from a cached list). Two details of Claude Code's hooks are unverified: whether "
      + 'its own "ask" reaches the permission hook, and how a question it asks you is answered from a hook. '
      + 'Sessions that are already open keep their old hooks until they restart.',
  ],
  codex: [
    'Codex will run mewndo-hook.exe before and after every tool, on permission requests and when it stops, and '
      + "config.toml gets a notify line so a finished turn becomes a Done card. Mewndo only ever refuses; Codex's own "
      + 'approval prompt stays in charge of everything else.',
    "What it can't do: Codex has not been tried with these hooks on a real run, so cards may not appear yet. Hosted "
      + "tools (such as web search) don't go through hooks. The hooks make no save points for Codex: Mewndo's own "
      + "(when it sees Codex start, and every 10 minutes while it runs) still happen. While Mewndo isn't running, Codex "
      + "carries on (protected paths are still refused). Codex runs one notify program: your own, if you have one, is "
      + 'kept commented out and comes back when you remove Mewndo.',
  ],
  cursor: [
    'Cursor will run mewndo-hook.exe before shell commands and MCP tool calls, after each response and when it stops. '
      + 'When a command needs your answer, it waits for you on the card beside the dock.',
    "What it can't do: Cursor has not been tried with these hooks on a real run; the hook names and the timeout field "
      + 'come from its documentation. A card nobody answers in time leaves Cursor to its own flow. The hooks make no save '
      + "points for Cursor: Mewndo's own still happen. While Mewndo isn't running, Cursor carries on (protected paths "
      + 'are still refused).',
  ],
};

function agentOf(agent) {
  const a = AGENTS[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  return a;
}

// --- mewndo-hook.exe -------------------------------------------------------------------------------------------

// Where the Claude Code plugin folder and its mewndo-hook.exe are. Installed: <resources>/claude-code/bin/ (package.json
// extraResources, build/stage-binaries.js). From source: the staged plugin, else what cargo built.
function hookExeCandidates({ resourcesDir = null, repoRoot = REPO_ROOT } = {}) {
  if (resourcesDir) {
    const plugin = path.join(resourcesDir, 'claude-code');
    return [{ exe: path.join(plugin, 'bin', EXE), plugin }];
  }
  const plugin = path.join(repoRoot, 'integrations', 'claude-code');
  return [{ exe: path.join(plugin, 'bin', EXE), plugin }, { exe: path.join(repoRoot, 'core', 'target', 'release', EXE), plugin }];
}

// { exe, plugin }, or an error saying where Mewndo looked.
async function findHookExe(options) {
  const candidates = hookExeCandidates(options);
  for (const c of candidates) {
    try {
      if ((await fsp.lstat(c.exe)).isFile()) return c;
    } catch { /* not there: try the next */ }
  }
  throw new Error(`Mewndo's hook program isn't there, so nothing was changed: ${candidates.map((c) => c.exe).join(' or ')}. `
    + 'Reinstalling Mewndo puts it back (from source: build it with `cargo build --release -p mewndo-hook`).');
}

// --- The hooks for each agent, with the real path ----------------------------------------------------------------

// Claude Code: the plugin's own hooks.json, with ${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe replaced by the real path.
// Forward slashes, as the v0 hooks use (claude-hooks.js): they work in every shell Claude Code runs hooks in,
// including Git Bash, where a backslash inside quotes can escape the next character. The plugin already quotes it.
// On Windows Claude Code runs command hooks in Git Bash unless a hook names its shell, and many people don't have
// Git Bash, so every hook then fails. There each hook says "shell": "powershell" and starts with `& `, PowerShell's
// way to run a quoted path.
function claudeHooks(template, exe, { windows = process.platform === 'win32' } = {}) {
  const real = exe.replace(/\\/g, '/');
  const hooks = structuredClone(template?.hooks);
  if (!hooks || typeof hooks !== 'object') throw new Error("The Claude Code plugin's hooks file has no hooks, so nothing was changed.");
  for (const groups of Object.values(hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      if (!String(h.command).includes(PLUGIN_ROOT)) throw new Error(`The Claude Code plugin's hooks file runs something other than ${EXE}, so nothing was changed.`);
      h.command = h.command.split(PLUGIN_ROOT).join(real);
      if (windows) {
        h.shell = 'powershell';
        h.command = `& ${h.command}`;
      }
    }
  }
  return { hooks };
}

// Codex: integrations/codex/hooks.json for a real path (mewndo-core codex.rs `hooks_json`, which built that file).
function codexHooks(exe) {
  const run = (event, timeout) => [{ matcher: '*', hooks: [{ type: 'command', command: `"${exe}" codex ${event}`, timeout }] }];
  return { hooks: { PreToolUse: run('pre-tool', 5), PermissionRequest: run('permission', 300), PostToolUse: run('post-tool', 5), Stop: run('stop', 5) } };
}

// Cursor: integrations/cursor/hooks.json for a real path. Cursor lists commands per event, with a format version.
function cursorHooks(exe) {
  const run = (event) => [{ command: `"${exe}" cursor ${event}`, timeout_ms: 30000 }];
  return { version: 1, hooks: { beforeShellExecution: run('shell'), beforeMCPExecution: run('mcp'), afterAgentResponse: run('response'), stop: run('stop') } };
}

// --- JSON hook files ----------------------------------------------------------------------------------------------

// Mewndo's entries taken out of a hooks object: { hooks, removed (the entries taken out) }. Claude Code and Codex
// group hooks under a matcher ({ hooks: [...] }); Cursor lists them directly. An event left empty by this is dropped.
function strip(hooks, grouped) {
  const next = {};
  const removed = [];
  for (const [event, list] of Object.entries(hooks ?? {})) {
    if (!Array.isArray(list)) { next[event] = list; continue; }
    const before = removed.length;
    let kept;
    if (grouped) {
      kept = list.flatMap((g) => {
        if (!Array.isArray(g?.hooks) || !g.hooks.some(ours)) return [g];
        removed.push(...g.hooks.filter(ours));
        const rest = g.hooks.filter((h) => !ours(h));
        return rest.length ? [{ ...g, hooks: rest }] : [];
      });
    } else {
      removed.push(...list.filter(ours));
      kept = list.filter((h) => !ours(h));
    }
    if (kept.length || removed.length === before) next[event] = kept;
  }
  return { hooks: next, removed };
}

// The file with Mewndo's entries taken out and `add` put in: { next, replaced (older Mewndo entries that go) }.
function mergeHooks(current, add, grouped, file) {
  if (current.hooks !== undefined && (typeof current.hooks !== 'object' || current.hooks === null || Array.isArray(current.hooks))) {
    throw new Error(`"hooks" in ${file} isn't a list of events, so nothing was changed.`);
  }
  const { hooks, removed } = strip(current.hooks, grouped);
  for (const [event, list] of Object.entries(add.hooks)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`"${event}" in ${file} isn't a list, so nothing was changed.`);
    hooks[event] = [...(hooks[event] ?? []), ...list];
  }
  const next = { ...current, ...(add.version !== undefined && current.version === undefined ? { version: add.version } : {}), hooks };
  const adding = new Set(Object.values(add.hooks).flat().flatMap((x) => (grouped ? x.hooks : [x])).map((h) => JSON.stringify(h)));
  return { next, replaced: removed.filter((h) => !adding.has(JSON.stringify(h))).length };
}

// A settings file: { exists, text }. A link is refused (plot.md rule 2): writing would replace it with a plain file.
async function readFileOf(file, name) {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, text: '' };
    throw new Error(`${name}'s settings can't be read, so nothing was changed: ${file} (${e.message})`);
  }
  if (st.isSymbolicLink()) throw new Error(`${file} is a link, and Mewndo doesn't change files through links, so nothing was changed. Add the hooks shown here by hand.`);
  if (!st.isFile()) throw new Error(`${file} isn't a file, so nothing was changed.`);
  return { exists: true, text: await fsp.readFile(file, 'utf8') };
}

async function readJsonOf(file, name) {
  const f = await readFileOf(file, name);
  if (!f.exists || !f.text.trim()) return { ...f, value: {} };
  let value;
  try {
    value = JSON.parse(f.text);
  } catch (e) {
    throw new Error(`${name}'s settings can't be read, so nothing was changed: ${file} (${e.message})`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} doesn't hold a settings object, so nothing was changed.`);
  return { ...f, value };
}

const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

// --- Codex's config.toml: one notify line in a marked block -------------------------------------------------------
//
// A port of mewndo-core's `merge_notify`/`remove_notify` (core/crates/mewndo-core/src/agents/codex.rs), same markers,
// so either one can take out what the other put in. A pure function over the text: every byte outside the block is
// copied through unchanged (comments, blank lines, key order, CRLF). A user's own top-level `notify` is kept inside
// the block as `# mewndo:was` lines, and removing the block puts it back exactly. Installing is "remove, then
// insert", so installing twice changes nothing. It is a line scanner, not a TOML parser: it refuses a file that ends
// inside a multi-line string, a `notify` that never closes, or a file over 1 MB, rather than guess.

const MERGE_CAP = 1024 * 1024;
const BLOCK_BEGIN = '# mewndo:begin';
const BLOCK_END = '# mewndo:end';
const WAS_PREFIX = '# mewndo:was ';
const ADDED_NEWLINE = '# mewndo:added-final-newline';
const BEGIN_LINE = '# mewndo:begin  Added by Mewndo (Connect agents): Codex runs this when a turn finishes.';
const BEGIN_HELP = '#   Removing Codex in Mewndo, or deleting this block, restores what was here before.';

const tomlError = (why) => new Error(`Codex's config.toml ${why}, so nothing was changed.`);

// A TOML basic string. A Windows path needs its backslashes doubled, or Codex reads \U and \A as escapes.
function tomlString(s) {
  const escapes = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
  let out = '"';
  for (const c of s) {
    const code = c.codePointAt(0);
    out += escapes[c] ?? (code < 0x20 || code === 0x7f ? `\\u${code.toString(16).toUpperCase().padStart(4, '0')}` : c);
  }
  return `${out}"`;
}

const notifyLine = (exe) => `notify = [${tomlString(exe)}, "codex", "notify"]`;

// The lines of the text, each { start, end (after its terminator), inString: begins inside a """ or ''' string }.
function tomlLines(text) {
  const lines = [];
  let state = null;
  for (let start = 0; start < text.length;) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl + 1;
    lines.push({ start, end, inString: state !== null });
    state = afterLine(text.slice(start, end), state);
    start = end;
  }
  if (state !== null) throw tomlError('ends inside a multi-line string');
  return lines;
}

// The multi-line string state after this line: null, '"' or "'".
function afterLine(line, state) {
  for (let i = 0; i < line.length;) {
    if (state) {
      if (state === '"' && line[i] === '\\') { i += 2; continue; }
      if (line.startsWith(state.repeat(3), i)) { state = null; i += 3; continue; }
      i += 1;
    } else if (line[i] === '#') {
      return null; // the rest of the line is a comment
    } else if (line[i] === '"' || line[i] === "'") {
      const q = line[i];
      if (line.startsWith(q.repeat(3), i)) { state = q; i += 3; continue; }
      for (i += 1; i < line.length; i++) { // a single-line string: skip to its close
        if (q === '"' && line[i] === '\\') { i += 1; continue; }
        if (line[i] === q) { i += 1; break; }
      }
    } else {
      i += 1;
    }
  }
  return state;
}

// Where `= value` starts when this line assigns exactly `key` (bare or quoted), or -1.
function keyAssignment(trimmed, key) {
  for (const name of [key, `"${key}"`, `'${key}'`]) {
    if (!trimmed.startsWith(name)) continue;
    const rest = trimmed.slice(name.length);
    if (rest.trimStart().startsWith('=')) return name.length + rest.length - rest.trimStart().length;
  }
  return -1;
}

// One past the end of the value starting at `from`, terminator included: the end of its line unless a bracket,
// brace or string is still open. -1 when nothing ever closes it.
function valueEnd(text, from) {
  let depth = 0;
  let ml = null;
  let single = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (ml) {
      if (ml === '"' && c === '\\') i += 1;
      else if (text.startsWith(ml.repeat(3), i)) { ml = null; i += 2; }
    } else if (single) {
      if (single === '"' && c === '\\') i += 1;
      else if (c === single) single = null;
    } else if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), i)) { ml = c; i += 2; } else single = c;
    } else if (c === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1; // a comment runs to the end of its line
    } else if (c === '[' || c === '{') {
      depth += 1;
    } else if (c === ']' || c === '}') {
      depth -= 1;
    } else if (c === '\n' && depth <= 0) {
      return i + 1;
    }
  }
  return depth <= 0 && !ml && !single ? text.length : -1;
}

// [start, end] of the top-level `notify` assignment, or null. A `notify` after the first [table] is another key.
function findNotify(text, lines) {
  for (const line of lines) {
    if (line.inString) continue;
    const raw = text.slice(line.start, line.end);
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('[')) break;
    const eq = keyAssignment(trimmed, 'notify');
    if (eq < 0) continue;
    const end = valueEnd(text, line.start + (raw.length - trimmed.length) + eq + 1);
    if (end < 0) throw tomlError('has a notify value that is never closed');
    return [line.start, end];
  }
  return null;
}

// Where the top-level table ends: before the first [table] header and the comments and blank lines right above it.
function topLevelEnd(text, lines) {
  let at = lines.findIndex((l) => !l.inString && text.slice(l.start, l.end).trimStart().startsWith('['));
  if (at < 0) return text.length;
  while (at > 0) {
    const prev = lines[at - 1];
    const t = text.slice(prev.start, prev.end).trim();
    if (prev.inString || !(t === '' || t.startsWith('#'))) break;
    at -= 1;
  }
  return lines[at].start;
}

// Mewndo's block taken out, and the user's own notify put back exactly. Unchanged text when there is no block.
function removeNotify(text) {
  if (text.length > MERGE_CAP) throw tomlError('is over 1 MB');
  const lines = tomlLines(text);
  let out = '';
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.inString || !text.slice(line.start, line.end).trimStart().startsWith(BLOCK_BEGIN)) {
      out += text.slice(line.start, line.end);
      i += 1;
      continue;
    }
    let addedNewline = false;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const raw = text.slice(lines[j].start, lines[j].end);
      const trimmed = raw.trimStart();
      if (trimmed.startsWith(BLOCK_END)) break;
      if (trimmed.startsWith(ADDED_NEWLINE)) addedNewline = true;
      if (trimmed.startsWith(WAS_PREFIX)) {
        out += trimmed.slice(WAS_PREFIX.length).replace(/[\r\n]+$/, '') + (raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '');
      }
    }
    i = j < lines.length ? j + 1 : j;
    if (addedNewline) out = out.replace(/\r?\n$/, '');
  }
  return out;
}

// Mewndo's notify added, keeping every other byte. mergeNotify(mergeNotify(x)) === mergeNotify(x) and
// removeNotify(mergeNotify(x)) === x.
function mergeNotify(text, exe, { windows = process.platform === 'win32' } = {}) {
  const clean = removeNotify(text);
  const nl = clean.includes('\r\n') || (clean === '' && windows) ? '\r\n' : '\n';
  const lines = tomlLines(clean);
  const found = findNotify(clean, lines);
  const [from, to] = found ?? [topLevelEnd(clean, lines), topLevelEnd(clean, lines)];
  let block = `${BEGIN_LINE}${nl}${BEGIN_HELP}${nl}`;
  if (found) {
    for (const l of clean.slice(from, to).split(/(?<=\n)/)) block += `${WAS_PREFIX}${l.replace(/[\r\n]+$/, '')}${nl}`;
  }
  block += `${notifyLine(exe)}${nl}`;
  let out = clean.slice(0, from);
  if (from === clean.length && clean !== '' && !clean.endsWith('\n')) { // the last line had no newline: say so
    out += nl;
    block += `${ADDED_NEWLINE}${nl}`;
  }
  return `${out}${block}${BLOCK_END}${nl}${clean.slice(to)}`;
}

// --- Plan, install, remove ----------------------------------------------------------------------------------------

// The changes for one agent: [{ path, exists, before, after, changed }], how many older Mewndo entries go, and
// whether the user's own Codex notify gets set aside.
async function changesFor(agent, { home, env, exe, plugin }) {
  const a = agentOf(agent);
  const files = a.files({ home, env });
  const hooks = await readJsonOf(files.hooks, a.name);
  let add;
  if (agent === 'claude') {
    let template;
    try {
      template = JSON.parse(await fsp.readFile(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
    } catch (e) {
      throw new Error(`The Claude Code plugin's hooks file can't be read, so nothing was changed: ${path.join(plugin, 'hooks', 'hooks.json')} (${e.message})`);
    }
    add = claudeHooks(template, exe);
  } else {
    add = agent === 'codex' ? codexHooks(exe) : cursorHooks(exe);
  }
  const { next, replaced } = mergeHooks(hooks.value, add, agent !== 'cursor', files.hooks);
  const changes = [{ path: files.hooks, exists: hooks.exists, before: hooks.text, after: jsonText(next), changed: JSON.stringify(next) !== JSON.stringify(hooks.value), added: add }];
  let setsAsideNotify = false;
  if (files.config) {
    const config = await readFileOf(files.config, a.name);
    const after = mergeNotify(config.text, exe);
    setsAsideNotify = after.includes(`\n${WAS_PREFIX}`) || after.startsWith(WAS_PREFIX);
    changes.push({ path: files.config, exists: config.exists, before: config.text, after, changed: after !== config.text, added: notifyLine(exe) });
  }
  return { changes, replaced, setsAsideNotify };
}

// What connecting would do, without doing it: { agent, name, files, settingsPath, exists, installed, preview, note,
// about, changes }. `preview` is exactly what will be added; `changes` (the new file contents) is for install only.
// options: { home, env, resourcesDir (process.resourcesPath when installed), repoRoot }.
async function planConnect(agent, { home = os.homedir(), env = process.env, resourcesDir = null, repoRoot = REPO_ROOT } = {}) {
  const a = agentOf(agent);
  const { exe, plugin } = await findHookExe({ resourcesDir, repoRoot });
  const { changes, replaced, setsAsideNotify } = await changesFor(agent, { home, env, exe, plugin });
  const installed = changes.every((c) => !c.changed);
  const show = (c) => (typeof c.added === 'string' ? c.added : JSON.stringify(c.added, null, 2));
  const preview = changes.length === 1 ? show(changes[0]) : changes.map((c) => `${c.path}\n${show(c)}`).join('\n\n');
  const note = installed ? `Already connected; nothing needs to change. Remove takes Mewndo's hooks out of ${a.name} again.`
    : [
      changes.some((c) => c.exists) ? 'Everything else in these files stays as it is, and a backup of each one is saved next to it first.' : 'These files will be created.',
      replaced ? `Mewndo's older hooks (${replaced}) are taken out: these replace them.` : '',
      setsAsideNotify ? 'Your own notify line is kept, commented out, and comes back when you remove Mewndo.' : '',
    ].filter(Boolean).join(' ');
  return {
    agent, name: a.name, exe,
    files: changes.map((c) => c.path), settingsPath: changes.map((c) => c.path).join(' and '),
    exists: changes.some((c) => c.exists), installed, preview, note, about: ABOUT[agent], changes,
  };
}

// A copy of the file next to it, named for the time, never overwriting an earlier one.
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

// Write the changed files, each after a backup (temp file, then rename). Returns the backups made.
async function apply(changes) {
  const backups = [];
  for (const c of changes.filter((x) => x.changed)) {
    if (c.exists) backups.push(await backUp(c.path));
    await writeFileAtomic(c.path, c.after);
  }
  return backups;
}

// Connect (or update): the plan, plus `backups` and `backup` (all of them, as one line, or null).
async function installConnect(agent, options) {
  const plan = await planConnect(agent, options);
  const backups = await apply(plan.changes);
  return { ...plan, backups, backup: backups.length ? backups.join(' and ') : null };
}

// Take Mewndo's entries (v0 or v1) out of one agent's files and put a set-aside Codex notify back. Doesn't need
// mewndo-hook.exe. Returns { agent, removed, backups }.
async function removeConnect(agent, { home = os.homedir(), env = process.env } = {}) {
  const a = agentOf(agent);
  const files = a.files({ home, env });
  const changes = [];
  let removed = 0;
  const hooks = await readJsonOf(files.hooks, a.name);
  if (hooks.value.hooks && typeof hooks.value.hooks === 'object' && !Array.isArray(hooks.value.hooks)) {
    const s = strip(hooks.value.hooks, agent !== 'cursor');
    removed += s.removed.length;
    const next = { ...hooks.value, hooks: s.hooks };
    if (s.removed.length && !Object.keys(s.hooks).length) delete next.hooks;
    changes.push({ path: files.hooks, exists: true, after: jsonText(next), changed: s.removed.length > 0 });
  }
  if (files.config) {
    const config = await readFileOf(files.config, a.name);
    const after = removeNotify(config.text);
    if (after !== config.text) removed += 1;
    changes.push({ path: files.config, exists: config.exists, after, changed: after !== config.text });
  }
  return { agent, removed, backups: await apply(changes) };
}

// Uninstalling Mewndo: every agent, v0 and v1 entries. One agent's unreadable file doesn't stop the others.
async function removeAllConnect(options) {
  const results = [];
  for (const agent of CONNECT_AGENTS) {
    try {
      results.push(await removeConnect(agent, options));
    } catch (e) {
      results.push({ agent, removed: 0, backups: [], error: e.message });
    }
  }
  return results;
}

module.exports = {
  planConnect, installConnect, removeConnect, removeAllConnect, findHookExe, hookExeCandidates,
  claudeHooks, codexHooks, cursorHooks, mergeNotify, removeNotify, notifyLine, isMewndoHook: ours,
  CONNECT_AGENTS, EXE_PLACEHOLDER,
};
