// Guard for Codex and Cursor (spec §24.2): installs a hook that runs bin/mewndo-guard.js before the agent acts.
// The script asks Mewndo's local server and answers in that agent's format. Like the Claude Code installer: the
// exact change is shown first (plan), everything else in the file stays, the old file is backed up, and installing
// twice changes nothing.
//   Codex  ~/.codex/hooks.json   PreToolUse for shell commands, apply_patch file edits and MCP calls; denies with
//                                permissionDecision deny. Hosted tools (web search) aren't covered.
//   Cursor ~/.cursor/hooks.json  preToolUse and beforeShellExecution; denies with permission deny and an
//                                agent_message.
// What it can't do: if Mewndo isn't running, the script lets harmless actions pass and refuses deletes and other
// destructive commands, as when Mewndo can't answer in time.
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeFileAtomic } = require('./store');
const { hookCommand, findNode: whereIsNode, SCRIPT } = require('./claude-hooks');

const GUARD_SCRIPT = SCRIPT.replace(/mewndo-savepoint\.js$/, 'mewndo-guard.js');
const MARK = 'mewndo-guard';
const ours = (h) => String(h?.command ?? '').includes(MARK);

const AGENTS = {
  codex: {
    name: 'Codex',
    file: () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json'),
    hooks: (command) => ({
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, statusMessage: 'Mewndo guard', timeout: 5 }] }],
    }),
    // Codex groups hooks under a matcher, as Claude Code does.
    merge(current, add) {
      const next = structuredClone(current);
      next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
      for (const [event, groups] of Object.entries(add)) {
        const kept = (Array.isArray(next.hooks[event]) ? next.hooks[event] : []).flatMap((g) => {
          if (!Array.isArray(g?.hooks)) return [g];
          const hooks = g.hooks.filter((h) => !ours(h));
          return hooks.length ? [{ ...g, hooks }] : [];
        });
        next.hooks[event] = [...kept, ...groups];
      }
      return next;
    },
  },
  cursor: {
    name: 'Cursor',
    file: () => path.join(os.homedir(), '.cursor', 'hooks.json'),
    hooks: (command) => ({ preToolUse: [{ command }], beforeShellExecution: [{ command }] }),
    // Cursor lists commands per event, with a format version.
    merge(current, add) {
      const next = structuredClone(current);
      next.version ??= 1;
      next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
      for (const [event, entries] of Object.entries(add)) {
        const kept = (Array.isArray(next.hooks[event]) ? next.hooks[event] : []).filter((h) => !ours(h));
        next.hooks[event] = [...kept, ...entries];
      }
      return next;
    },
  },
};

// What installing would do: { agent, settingsPath, exists, installed, preview, merged }.
async function planAgentHooks(agent, { settingsPath, nodePath, findNode = whereIsNode } = {}) {
  const a = AGENTS[agent];
  if (!a) throw new Error(`unknown agent: ${agent}`);
  const file = settingsPath ?? a.file();
  const node = nodePath ?? (await findNode());
  let current = {};
  let exists = true;
  try {
    current = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') exists = false;
    else throw new Error(`${a.name}'s hooks file can't be read, so nothing was changed: ${file} (${e.message})`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error(`${a.name}'s hooks file doesn't hold a settings object, so nothing was changed: ${file}`);
  }
  const add = a.hooks(`${hookCommand(node, GUARD_SCRIPT)} --agent ${agent}`);
  const merged = a.merge(current, add);
  return {
    agent, settingsPath: file, exists,
    installed: JSON.stringify(merged) === JSON.stringify(current),
    preview: JSON.stringify({ hooks: add }, null, 2),
    merged,
  };
}

async function installAgentHooks(agent, options) {
  const plan = await planAgentHooks(agent, options);
  if (plan.installed) return { ...plan, backup: null };
  let backup = null;
  if (plan.exists) {
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

module.exports = { planAgentHooks, installAgentHooks, GUARD_SCRIPT, AGENT_HOOKS: Object.keys(AGENTS) };
