// Voice commands (spec §23.3): what the user said, as one intent with its slots. Rules for now; the decision
// model (spec §26) can replace them later behind the same function. Anything unclear comes back as 'unclear' with
// "did you mean" suggestions, never as a guess that acts.
//   brief { task } · stop { agent } · freeze · undo { agent | null, minutes } · resume { agent | null } · changes
// agents: the names to match ("Claude Code", "Codex"...); a name matches on any of its words ("stop Claude").

const NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, half: 30,
};

// What dictation tends to hear instead of agent names.
const SOUNDS_LIKE = { codecs: 'codex', codec: 'codex', codecks: 'codex', cloud: 'claude', clawed: 'claude', clod: 'claude', claud: 'claude', cursive: 'cursor', curser: 'cursor' };

function findAgent(text, agents) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => SOUNDS_LIKE[w] ?? w);
  const generic = new Set(['code', 'agent', 'the', 'ai']);
  return agents.find((name) => name.toLowerCase().split(/\s+/).some((w) => !generic.has(w) && words.includes(w))) ?? null;
}

function findMinutes(text) {
  const m = text.match(/\b(\d+|[a-z]+)\s*(?:more\s+)?(minutes?|mins?|hours?|hrs?)\b/);
  if (!m) return /\bhalf an hour\b/.test(text) ? 30 : null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBERS[m[1]];
  if (!n) return null;
  return /^h/.test(m[2]) ? n * 60 : n;
}

function parseIntent(said, { agents = [] } = {}) {
  const raw = String(said ?? '').trim();
  const text = raw.toLowerCase().replace(/[.!?]+$/, '');
  if (!text) return { intent: 'unclear', heard: raw, suggestions: [] };
  const agent = findAgent(text, agents);

  const brief = raw.match(/^\s*(?:brief|new brief|task)\s*[:,-]?\s+(.+)$/i);
  if (brief) return { intent: 'brief', task: brief[1].trim(), heard: raw };
  if (/\b(freeze|stop|brake|halt|pause)\b.*\b(everything|everyone|all|every agent|all agents)\b/.test(text) || /^freeze\b/.test(text)) {
    return { intent: 'freeze', heard: raw };
  }
  if (/\b(stop|brake|halt|pause|kill)\b/.test(text)) {
    if (agent) return { intent: 'stop', agent, heard: raw };
    return { intent: 'unclear', heard: raw, suggestions: agents.map((a) => ({ intent: 'stop', agent: a })) };
  }
  if (/\b(undo|revert|roll back|rollback|put back)\b/.test(text)) {
    const minutes = findMinutes(text);
    if (minutes) return { intent: 'undo', agent, minutes, heard: raw };
    return { intent: 'unclear', heard: raw, suggestions: [10, 30].map((m) => ({ intent: 'undo', agent, minutes: m })) };
  }
  if (/\b(resume|carry on|continue|unpause|go on)\b/.test(text)) return { intent: 'resume', agent, heard: raw };
  if (/\bwhat\b.*\b(changed?|did)\b|\bchanges\b/.test(text)) return { intent: 'changes', agent, heard: raw };
  return {
    intent: 'unclear', heard: raw,
    suggestions: [{ intent: 'changes', agent: null }, ...(agent ? [{ intent: 'stop', agent }] : [])],
  };
}

// Free speech or a command? The bar's mic hears both: "stop Claude" is for Mewndo, "Claude, stop editing the README
// and run the tests" is for Claude. A command has to lead what was said (after "hey Mewndo", "please" or an agent's
// name) and, for stop and resume, be short; anything else is a message for an agent, which the Router delivers.
//   { kind: 'command', intent }  act on it as today (undo and freeze still confirm first)
//   { kind: 'ask', intent }      a command missing a piece ("stop it"): "did you mean", as today
//   { kind: 'message', text, agent, intent }  send the words to an agent; agent is the one named, if any
//   { kind: 'empty', intent }    nothing was heard
// What it can't do: it is word rules, not understanding. "Pause Codex for a sec" is a command; "continue with the
// tests" is a message. Saying "Mewndo, ..." does not force a command.
const FILLER = new Set(['hey', 'hi', 'ok', 'okay', 'mewndo', 'please', 'can', 'could', 'would', 'you']);
const LEADS = /^(stop|brake|halt|pause|kill|freeze|undo|revert|roll ?back|rollback|put back|resume|carry on|continue|unpause|go on|what)\b/;
const SHORT = 4; // stop and resume with more than this many words after the verb's leading words are messages

function classify(said, { agents = [] } = {}) {
  const intent = parseIntent(said, { agents });
  const text = String(said ?? '').trim();
  if (!text) return { kind: 'empty', intent };
  if (intent.intent === 'brief') return { kind: 'command', intent };
  // The words that matter: fillers and agent names dropped from the front ("Claude, undo ...", "please stop Codex").
  const named = (w) => agents.some((name) => name.toLowerCase().split(/\s+/).includes(SOUNDS_LIKE[w] ?? w)) && !['code', 'agent', 'the', 'ai'].includes(w);
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  let i = 0;
  while (i < words.length && (FILLER.has(words[i]) || named(words[i]))) i++;
  const rest = words.slice(i);
  const led = LEADS.test(rest.join(' '));
  const short = rest.filter((w) => !named(w)).length <= SHORT;
  const message = { kind: 'message', text, agent: findAgent(text.toLowerCase(), agents), intent };
  if (intent.intent === 'unclear') return led && short ? { kind: 'ask', intent } : message;
  if (!led) return message;
  if (['stop', 'resume'].includes(intent.intent) && !short) return message;
  return { kind: 'command', intent };
}

// The suggestion or intent in words, for "did you mean" and confirmations.
function describe(i) {
  const who = i.agent ?? 'any agent';
  switch (i.intent) {
    case 'brief': return `Write a brief: "${i.task}"`;
    case 'stop': return `Stop ${i.agent}`;
    case 'freeze': return 'Freeze every agent';
    case 'undo': return `Undo what ${who} did in the last ${i.minutes} minutes`;
    case 'resume': return i.agent ? `Resume ${i.agent}` : 'Resume';
    case 'changes': return 'What changed today';
    default: return 'Something else';
  }
}

module.exports = { parseIntent, describe, classify };
