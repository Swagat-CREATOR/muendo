// Continue card (spec §6H, §24.5): what an agent needs to carry on after a brake, kept under 600 tokens.
// Items marked "Verified" come from the journal (what really changed on disk); "Agent says" items are the agent's
// own claims, passed in as they are. What it can't do: Mewndo can't restore the agent's internal state, only give
// it this account of the work; and it can't check "Agent says" items.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./store');

const MAX_CHARS = 1800; // ponytail: ~3 characters per token keeps it under 600 tokens; a real tokenizer if it matters
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// One rule per folder an agent deleted from outside its brief: "Do not delete files in `docs/` unless I name them."
function rulesFor(drifts) {
  const rules = new Set();
  for (const d of drifts) {
    for (const p of d.paths ?? []) {
      const dir = path.posix.dirname(p);
      rules.add(dir === '.' ? `Do not delete \`${p}\` unless I name it.` : `Do not delete files in \`${dir}/\` unless I name them.`);
    }
  }
  return [...rules];
}

// task: the brief's text · diff: the journal's compare() since the task began · agentSays: [text] · drifts:
// [{ reason, paths, healed }] · rules: every rule of the brief · newRules: the ones added now · reason: the brake's.
function buildCard({ folder, task, diff, agentSays = [], drifts = [], rules = [], newRules = [], reason }) {
  const make = (n) => {
    const list = (items) => [...items.slice(0, n).map((s) => `- ${cut(s, 160)}`), ...(items.length > n ? [`- and ${items.length - n} more`] : [])];
    const done = [
      ...(diff?.edited ?? []).map((p) => `Verified (journal): edited ${p}`),
      ...(diff?.created ?? []).map((p) => `Verified (journal): created ${p}`),
      ...(diff?.moved ?? []).map((m) => `Verified (journal): moved ${m.from} to ${m.to}`),
      ...(diff?.deleted ?? []).map((p) => `Verified (journal): deleted ${p}`),
      ...agentSays.map((s) => `Agent says: ${s}`),
    ];
    const wrong = [...(reason ? [`Mewndo braked you: ${reason}.`] : []), ...drifts.map((d) => d.reason)];
    const healed = drifts.flatMap((d) => d.healed ?? []).map((p) => `Mewndo put back ${p}`);
    return [
      '# Mewndo Continue card',
      `Folder: ${folder}`,
      '## Task', cut(task || '(no brief was written for this folder)', 500),
      '## Done so far', ...(done.length ? list(done) : ['- Nothing changed on disk yet.']),
      ...(wrong.length ? ['## What went wrong', ...list(wrong)] : []),
      ...(healed.length ? ['## Healed', ...list(healed)] : []),
      ...(rules.length ? ['## Rules', ...list(rules.map((r) => (newRules.includes(r) ? `${r} (new)` : r)))] : []),
      'Carry on with the task. Stay inside the folder and the brief; ask the user before deleting anything the brief doesn\'t name.',
    ].join('\n');
  };
  let card = make(8);
  for (let n = 7; card.length > MAX_CHARS && n > 0; n--) card = make(n);
  return cut(card, MAX_CHARS);
}

// Put the card in a Mewndo-managed block of a text file (Codex: AGENTS.md), keeping everything else as it is.
const START = '<!-- mewndo:continue -->';
const END = '<!-- /mewndo:continue -->';
async function writeManagedBlock(file, text) {
  const old = await fsp.readFile(file, 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
  const block = `${START}\n${text}\n${END}`;
  const i = old.indexOf(START);
  const j = old.indexOf(END, i);
  const next = i >= 0 && j > i ? old.slice(0, i) + block + old.slice(j + END.length)
    : `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${block}\n`;
  if (next !== old) await writeFileAtomic(file, next);
}

module.exports = { buildCard, rulesFor, writeManagedBlock, MAX_CHARS };
