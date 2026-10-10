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
function deliver(target, { agents = [], cards = [], lanes = [], text = '', via = 'key' } = {}) {
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
  const open = cards.find((c) => c.kind === 'done' && c.state === 'open' && agent && c.agentId === agent.agentId);
  if (open && agent) {
    const how = agent.kind === 'cursor' ? 'followup' : 'reply';
    return { how, cardId: open.id, agent: agent.name, answer: { card_id: open.id, choice: null, text, via } };
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

// The chip labels: "1 Claude · 2 Codex".
function chipLabels(chips, { agents = [] } = {}) {
  return chips.map((target) => {
    const command = commandOf(target);
    if (command) return `Mewndo: ${command}`;
    return agents.find((a) => sameTarget(a, target))?.name ?? String(target);
  });
}

module.exports = { THRESHOLD, decide, deliver, chipLabels, commandOf, COMMANDS };
