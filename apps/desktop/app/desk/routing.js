// The Talk box's routing (spec §33.5, §33.10 Part H). The core's Router (§34.5) decides where the text goes; this
// file only works out how to deliver it, and what to show when it isn't sure. Plain functions, no Electron and no
// DOM, so tests run it with plain Node.
//
// Enter sends `route.request {text}`; the core answers `route.result {target, confidence, alternatives}`.
// Confidence 0.7 or higher is delivered; below that the top two appear as chips and the user presses 1 or 2
// (§33.5 step 3) — Mewndo never guesses silently.
const { parseIntent, describe: describeIntent } = require('../../engine/voice'); // plain text only, no engine work

const THRESHOLD = 0.7; // deliver at or above this (§33.10 Part H step 2)
const COMMANDS = ['undo', 'brake', 'stop', 'freeze', 'resume']; // Mewndo's own commands (§23.3, §24)

// A Router target that names Mewndo itself rather than an agent: "mewndo:undo", "mewndo.brake", "command:resume".
function commandOf(target) {
  const m = /^(?:mewndo|command)[:.](\w+)$/i.exec(String(target ?? ''));
  const name = m?.[1]?.toLowerCase();
  return name && COMMANDS.includes(name) ? (name === 'brake' ? 'stop' : name) : null;
}

// What the confirmation says when the words carry the command but not its slots: "undo" with no time in it,
// "stop" with no agent named. Filling those in from nothing would put a sentence in front of Confirm that the
// user never said ("the last undefined minutes"), so Mewndo asks for the missing piece instead, exactly as
// §23.3's "did you mean" does. Never a guess that acts.
const ASK_FOR = {
  undo: 'Undo how far back? Say how many minutes.',
  stop: 'Stop which agent?',
  freeze: 'Freeze every agent',
  resume: 'Resume which agent?',
};

// What to do with a `route.result`. Below the threshold the two best targets become chips 1 and 2.
function decide(result, { threshold = THRESHOLD } = {}) {
  const confidence = Number(result?.confidence ?? 0);
  const target = result?.target ?? null;
  const alternatives = Array.isArray(result?.alternatives) ? result.alternatives : [];
  if (!target) return { chips: alternatives.slice(0, 2), confidence };
  if (confidence >= threshold) return { deliver: target, confidence };
  return { chips: [target, ...alternatives].slice(0, 2), confidence };
}

const sameTarget = (agent, target) => {
  const t = String(target ?? '').toLowerCase();
  return [agent.agentId, agent.name, agent.kind].some((v) => String(v ?? '').toLowerCase() === t);
};

// How the text reaches that target (the table in §33.10 Part H step 3).
//   agents:  [{ agentId, kind, name, connection, status, laneId }] from `agent.status`
//   cards:   the open cards, so a Done card still waiting is a reply window still open
//   lanes:   [{ laneId, agentId }] from the core
// via: 'voice' when it was dictated, 'key' when typed — it travels with the answer for the Receipt (§35).
// canMessage: the core takes `agent.message` (it answers `agent.message.result`); an older core does not, and then
// the last row is still "can't reach".
function deliver(target, { agents = [], cards = [], lanes = [], text = '', via = 'key', canMessage = false } = {}) {
  const command = commandOf(target);
  if (command) {
    // Mewndo's own commands go through the v0 intent and its confirmation UI (§23.3): undo and freeze always show
    // what they will do before running. The command is the Router's; the slots are the user's words.
    const intent = parseIntent(text, { agents: agents.map((a) => a.name).filter(Boolean) });
    return { how: 'command', command, intent, confirm: intent.intent === command ? describeIntent(intent) : ASK_FOR[command] };
  }

  const lane = lanes.find((l) => String(l.laneId) === String(target))
    ?? lanes.find((l) => agents.some((a) => a.agentId === l.agentId && sameTarget(a, target)));
  const agent = agents.find((a) => sameTarget(a, target));

  // A lane is a terminal Mewndo owns: the text is written straight into it, followed by a carriage return.
  if (lane) return { how: 'lane', lane: lane.laneId, bytes: `${text}\r`, agent: agent?.name ?? null };

  // A Stop (Claude) or stop (Cursor) card still open means the agent's hook is still waiting for an answer: the
  // reply resolves that wait. The core turns it into `followup_message` for Cursor.
  // Codex's Done card never has a hook waiting behind it (its Stop can't wait), so it never takes this path.
  const open = agent?.kind !== 'codex'
    && cards.find((c) => c.kind === 'done' && c.state === 'open' && agent && c.agentId === agent.agentId);
  if (open && agent) {
    const how = agent.kind === 'cursor' ? 'followup' : 'reply';
    return { how, cardId: open.id, agent: agent.name, answer: { card_id: open.id, choice: null, text, via } };
  }

  // Otherwise the core is asked to get it there: at once to a hook that is waiting, or when the agent next stops.
  // Whether it could is the core's answer (`agent.message.result`), shown by resultText() below.
  if (canMessage && agent) {
    return { how: 'message', agent: agent.name, agentId: agent.agentId, body: { agent_id: agent.agentId, text, via } };
  }

  // Anything else can't be reached: a card says so and offers the one thing that would work.
  const name = agent?.name ?? String(target ?? 'that agent');
  return {
    how: 'unreachable',
    agent: name,
    card: {
      kind: 'question',
      agentId: agent?.agentId ?? null,
      title: `Can't reach ${name} outside a lane.`,
      body: `Mewndo has no way to send "${text}" to ${name} right now. A lane is a terminal Mewndo owns, so replies always reach it.`,
      options: ['Open a lane', 'Not now'],
    },
  };
}

// What the Talk box says once the core has answered `agent.message` or `agent.type` (or hasn't). Never "sent" unless
// the core said so: a reply that is late or that this app can't read says exactly that. options: what the box offers
// next. A `confirm` also carries the exact text the core would type (preview) and the offer to name in `agent.type`.
//   result: the `agent.message.result` body, or null when the core did not answer in time.
function resultText(result, name = 'the agent') {
  if (!result) {
    return { tone: 'failed', text: `Mewndo did not hear back from the core, so it can't say whether ${name} got that.`, options: [] };
  }
  switch (result.delivered) {
    case 'now': return { tone: 'sent', text: `Sent to ${name}.`, options: [] };
    case 'queued': return { tone: 'queued', text: `Queued: ${name} gets it when it finishes this step.`, options: [] };
    // The agent is idle at its prompt in a terminal its hook reported: the core can type the text there, but only
    // once the user has seen exactly what and where (docs/decisions.md, "Typing into an idle agent's terminal").
    // A confirm with no offer or no text to show is nothing the user could safely say yes to.
    case 'confirm': {
      const preview = String(result.preview ?? '');
      if (!result.offer_id || !preview) break;
      const reason = String(result.reason ?? '').trim() || `${name} is idle at its prompt. Type this into its terminal?`;
      return { tone: 'confirm', text: reason, preview, offerId: String(result.offer_id), options: ['Type it', 'Cancel'] };
    }
    case 'typed': return { tone: 'sent', text: `Typed into ${name}'s terminal.`, options: [] };
    case 'unsupported': {
      const why = String(result.reason ?? '').trim().replace(/\.$/, '');
      return {
        tone: 'failed',
        text: `Can't reach ${name}${why ? `: ${why}` : ''}.`,
        body: 'A lane is a terminal Mewndo owns, so replies always reach it.',
        options: ['Open a lane', 'Not now'],
      };
    }
    default: break;
  }
  return { tone: 'failed', text: `The core answered in a way this app doesn't understand, so ${name} may not have it.`, options: [] };
}

// The agent a dictated message goes to without asking the Router: the one agent there is. Two or more, or none,
// is the Router's call (and its chips when it isn't sure).
function onlyAgent(agents = []) {
  const live = agents.filter((a) => a?.agentId && a.status !== 'gone');
  return live.length === 1 ? live[0] : null;
}

// The chip labels: "1 Claude · 2 Codex".
function chipLabels(chips, { agents = [] } = {}) {
  return chips.map((target) => {
    const command = commandOf(target);
    if (command) return `Mewndo: ${command}`;
    return agents.find((a) => sameTarget(a, target))?.name ?? String(target);
  });
}

module.exports = { THRESHOLD, decide, deliver, chipLabels, commandOf, COMMANDS, resultText, onlyAgent };
