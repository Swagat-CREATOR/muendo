// Installs Mewndo's hooks into Claude Code's user settings: a save point at the start of every session and right
// before every Bash command, via bin/mewndo-savepoint.js. Everything else in the settings file stays as it was;
// a backup of the old file is kept next to it.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { writeFileAtomic } = require('./store');

// In the installed app, bin/ is unpacked next to app.asar (Node can't run a file inside the archive).
const SCRIPT = path.join(__dirname, '..', 'bin', 'mewndo-savepoint.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MARK = 'mewndo-savepoint'; // how Mewndo recognises its own hook entries

// Claude Code reads ~/.claude/settings.json, or CLAUDE_CONFIG_DIR when set.
const claudeSettingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

// Node, to run the script. Found on PATH, where `npm start` already needs it.
function findNode() {
  return new Promise((resolve, reject) => {
    execFile('node', ['-p', 'process.execPath'], { timeout: 5000, windowsHide: true }, (e, out) => {
      if (e) reject(new Error('Node.js was not found on this computer, but the hooks need it to run.'));
      else resolve(out.trim());
    });
  });
}

// Forward slashes work for Node in every shell Claude Code uses, including Git Bash on Windows.
const hookCommand = (nodePath, scriptPath = SCRIPT) => `"${nodePath.replace(/\\/g, '/')}" "${scriptPath.replace(/\\/g, '/')}"`;

function hooksFor(command) {
  const hook = { type: 'command', command, timeout: 5 };
  return {
    SessionStart: [{ hooks: [hook] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [hook] }],
  };
}

// What installing would do, without doing it: { settingsPath, exists, installed, preview, merged }.
// `preview` is exactly the JSON that will be added.
async function planClaudeHooks({ settingsPath = claudeSettingsPath(), nodePath } = {}) {
  const node = nodePath ?? (await findNode());
  let current = {};
  let exists = true;
  try {
    current = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') exists = false;
    else throw new Error(`Claude Code's settings file can't be read, so nothing was changed: ${settingsPath} (${e.message})`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`Claude Code's settings file doesn't hold a settings object, so nothing was changed: ${settingsPath}`);
  }
  const add = hooksFor(hookCommand(node));
  const merged = structuredClone(current);
  merged.hooks = merged.hooks && typeof merged.hooks === 'object' ? merged.hooks : {};
  for (const [event, groups] of Object.entries(add)) {
    // Older Mewndo entries (e.g. from before Mewndo moved) are replaced; other hooks are kept as they are.
    const kept = (Array.isArray(merged.hooks[event]) ? merged.hooks[event] : []).flatMap((g) => {
      const hooks = Array.isArray(g?.hooks) ? g.hooks.filter((h) => !String(h?.command ?? '').includes(MARK)) : g?.hooks;
      return Array.isArray(g?.hooks) && g.hooks.length && !hooks.length ? [] : [{ ...g, hooks }];
    });
    merged.hooks[event] = [...kept, ...groups];
  }
  return {
    settingsPath, exists,
    installed: JSON.stringify(merged) === JSON.stringify(current),
    preview: JSON.stringify({ hooks: add }, null, 2),
    merged,
  };
}

// Install (or update) the hooks. Returns the plan plus `backup`: where the previous settings file was copied.
async function installClaudeHooks(options) {
  const plan = await planClaudeHooks(options);
  if (plan.installed) return { ...plan, backup: null };
  let backup = null;
  if (plan.exists) { // never overwrite an earlier backup: the first one holds the settings from before Mewndo
    backup = `${plan.settingsPath}.mewndo-backup`;
    try {
      await fsp.copyFile(plan.settingsPath, backup, fsp.constants.COPYFILE_EXCL);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      backup = `${plan.settingsPath}.mewndo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fsp.copyFile(plan.settingsPath, backup, fsp.constants.COPYFILE_EXCL);
    }
  }
  await writeFileAtomic(plan.settingsPath, `${JSON.stringify(plan.merged, null, 2)}\n`);
  return { ...plan, backup };
}

// Take Mewndo's hooks out again (uninstalling Mewndo), keeping everything else. Returns { removed, backup }.
async function removeClaudeHooks({ settingsPath = claudeSettingsPath() } = {}) {
  let current;
  try {
    current = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch {
    return { removed: 0, backup: null }; // no settings file, or not one Mewndo can safely change
  }
  if (!current?.hooks || typeof current.hooks !== 'object') return { removed: 0, backup: null };
  const next = structuredClone(current);
  let removed = 0;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((g) => {
      if (!Array.isArray(g?.hooks)) return [g];
      const hooks = g.hooks.filter((h) => !String(h?.command ?? '').includes(MARK));
      removed += g.hooks.length - hooks.length;
      return hooks.length ? [{ ...g, hooks }] : [];
    });
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!removed) return { removed: 0, backup: null };
  if (!Object.keys(next.hooks).length) delete next.hooks;
  const backup = `${settingsPath}.mewndo-uninstall-backup`;
  await fsp.copyFile(settingsPath, backup);
  await writeFileAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { removed, backup };
}

module.exports = { planClaudeHooks, installClaudeHooks, removeClaudeHooks, claudeSettingsPath, hookCommand, SCRIPT };
