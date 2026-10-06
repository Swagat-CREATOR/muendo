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
  const destructive = action.kind === 'shell' ? DESTRUCTIVE.test(action.command) : false;
  return destructive
    ? { decision: 'deny', rule: 'fallback', reason: "Mewndo couldn't check this command in time, and it could delete or overwrite work. Try again in a moment, or ask the user to run it." }
    : { decision: 'allow', rule: 'fallback', reason: "Mewndo couldn't check this in time; it doesn't delete anything, so it may go ahead." };
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

module.exports = { actionFor, fallbackVerdict, claudeOutput, judge };
