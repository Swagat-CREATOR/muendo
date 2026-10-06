const path = require('node:path');

// Guard (spec §24.2): an AI agent's hook asks before each action; Mewndo answers allow, deny or ask, with a reason
// the agent can read and what to do instead. The rules live in mewndo-core (core/src/policy.rs). If the core
// doesn't answer in time, these fallback rules decide: harmless actions pass, destructive ones (deletes, recursive
// deletes, hard resets, force-pushes, out-of-folder writes we can't check) are denied. failOpen lets everything
// pass instead.

// One planned action from a hook's tool call: what policy.rs judges. null: nothing to judge (a search, a web call).
function actionFor(toolName, input = {}, cwd) {
  const file = input.file_path ?? input.notebook_path ?? input.path;
  switch (toolName) {
    case 'Bash': case 'PowerShell': case 'shell': case 'Shell':
      return typeof input.command === 'string' ? { kind: 'shell', command: input.command, cwd } : null;
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return typeof file === 'string' ? { kind: 'write', path: file } : null;
    case 'Read':
      return typeof file === 'string' ? { kind: 'read', path: file } : null;
    default:
      return null;
  }
}

const DESTRUCTIVE = /(^|[\s;&|(])(rm|rmdir|del|erase|rd|unlink|shred|remove-item|ri|mv|move|move-item)(\s|$)|git\s+(reset\s+--hard|clean|push\s+.*(-f\b|--force|\s\+))|git\s+checkout\s+\./i;

// The rules when the core can't be asked: deny what could destroy work, allow the rest.
function fallbackVerdict(action, { failOpen = false } = {}) {
  if (failOpen) return { decision: 'allow', rule: 'fallback', reason: "Mewndo couldn't check this in time; the settings say to let it pass." };
  const destructive = action.kind === 'delete' || (action.kind === 'shell' && DESTRUCTIVE.test(action.command));
  return destructive
    ? { decision: 'deny', rule: 'fallback', reason: "Mewndo couldn't check this command in time, and it could delete or overwrite work. Try again in a moment, or ask the user to run it." }
    : { decision: 'allow', rule: 'fallback', reason: "Mewndo couldn't check this in time; it doesn't delete anything, so it may go ahead." };
}

// Every action in one hook call, for each agent's input format (Claude Code, Codex, Cursor). Empty: nothing to judge.
//   Codex apply_patch: each file the patch adds, updates, deletes or moves is an action. MCP calls (tool names
//   mcp__server__tool): any argument that looks like a path is checked as a read (secrets).
//   Cursor beforeShellExecution has no tool name, only a command.
function actionsFor(agent, input = {}) {
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : '.';
  const tool = String(input.tool_name ?? '');
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (agent === 'cursor' && !tool && typeof input.command === 'string') return [{ kind: 'shell', command: input.command, cwd }];
  if (tool === 'apply_patch') {
    const patch = [ti.command, ti.patch, ti.input].find((t) => typeof t === 'string') ?? '';
    const out = [];
    for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
      if (m[3]) out.push({ kind: 'write', path: path.resolve(cwd, m[3].trim()) });
      else out.push({ kind: m[1] === 'Delete' ? 'delete' : 'write', path: path.resolve(cwd, m[2].trim()) });
    }
    return out;
  }
  if (/^mcp__/.test(tool) || /^mcp[_:]/i.test(tool)) {
    return Object.values(ti).filter((v) => typeof v === 'string' && /[\\/]/.test(v) && v.length < 1024 && !/^https?:/.test(v))
      .map((p) => ({ kind: 'read', path: path.resolve(cwd, p) }));
  }
  const t = tool.toLowerCase();
  const file = ti.file_path ?? ti.notebook_path ?? ti.path ?? ti.target_file;
  if (agent === 'cursor' && t.includes('delete') && typeof file === 'string') return [{ kind: 'delete', path: path.resolve(cwd, file) }];
  if (agent === 'cursor' && (t.includes('write') || t.includes('edit')) && typeof file === 'string') return [{ kind: 'write', path: path.resolve(cwd, file) }];
  if (agent === 'cursor' && t.includes('read') && typeof file === 'string') return [{ kind: 'read', path: path.resolve(cwd, file) }];
  const one = actionFor(tool, ti, cwd);
  return one ? [one] : [];
}

const SEVERITY = { allow: 0, ask: 1, deny: 2 };
// Several actions: the strictest verdict decides; allowed deletes add up.
function strictest(verdicts) {
  const worst = verdicts.reduce((a, b) => (SEVERITY[b.decision] > SEVERITY[a.decision] ? b : a));
  return { ...worst, deletes: verdicts.reduce((n, v) => n + (v.deletes ?? 0), 0) };
}

// What to tell the agent so it corrects itself instead of retrying.
const ADVICE = {
  secret: 'Do not read or change this file. If the task needs a value from it, ask the user for just that value.',
  outside_scope: 'Keep your changes inside the brief\'s folder. If the task really needs this, stop and ask the user.',
  destructive: 'Prefer a narrower command that names the exact files. The user has been asked to confirm this one.',
  unnamed_delete: 'Do not delete it. If you think it must go, tell the user why and let them decide.',
  burst: 'Pause and summarise what you have changed so far for the user before going on.',
  fallback: 'Mewndo will be able to check again in a moment.',
};

// The body Claude Code reads from an HTTP PreToolUse hook (hookSpecificOutput, per the hooks reference).
function claudeOutput(verdict) {
  const out = { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: `Mewndo: ${verdict.reason}` };
  if (verdict.decision !== 'allow' && ADVICE[verdict.rule]) out.additionalContext = `Mewndo guard: ${ADVICE[verdict.rule]}`;
  return { hookSpecificOutput: out };
}

// The answer in each agent's own format. Codex has no "ask": the agent is refused and told to ask the user.
function outputFor(agent, verdict) {
  if (agent === 'claude') return claudeOutput(verdict);
  const advice = verdict.decision !== 'allow' && ADVICE[verdict.rule] ? ` ${ADVICE[verdict.rule]}` : '';
  if (agent === 'cursor') {
    return { permission: verdict.decision, user_message: `Mewndo: ${verdict.reason}`, agent_message: `${verdict.reason}${advice}` };
  }
  if (verdict.decision === 'allow') return {};
  const reason = verdict.decision === 'ask' ? `${verdict.reason} Ask the user to confirm, then they can run it.` : verdict.reason;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Mewndo: ${reason}${advice}` } };
}

// Ask the core, within `deadlineMs`. Anything wrong (no core, an error, too slow) gives the fallback verdict.
async function judge(core, { session, brief, action }, { deadlineMs = 1000, failOpen = false } = {}) {
  if (!core) return fallbackVerdict(action, { failOpen });
  let timer;
  try {
    const reply = await Promise.race([
      core.request('policy_check', { session, brief, action }, { within: deadlineMs }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), deadlineMs); }),
    ]);
    return { decision: reply.decision, rule: reply.rule, reason: reply.reason, deletes: reply.deletes };
  } catch {
    return fallbackVerdict(action, { failOpen });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { actionFor, actionsFor, strictest, fallbackVerdict, claudeOutput, outputFor, judge };
