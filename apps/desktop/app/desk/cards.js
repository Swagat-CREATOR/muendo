// The Agent Inbox card stack: what the cards window shows and what each key does (spec §33.2, §33.3, §33.4,
// §33.10 Part E step 4). Plain state and plain functions, no Electron and no DOM, so tests run it with plain Node.
//
// Every card comes from the core as an `inbox.card` message (mewndo-proto InboxCard: id, kind, agent_id, title,
// body, options, risk, thumb, grace_ms). The renderer only displays what the core sent and sends back the user's
// answer: every decision lives in the core (§38.3).
//
// The 2 second grace (§33.4): an answer is held here while the grace bar drains, then sent. Esc during that time
// cancels it and reopens the card, and a second answer is ignored. The bar is a CSS animation lasting the card's
// own `grace_ms` and its `animationend` releases the answer, so there is no JS timer on this path (§33.10 speed
// rules). What it can't do: because the answer is held in the app, a crash during the grace loses it — the agent
// then waits for its hook timeout, which is the same outcome as never answering.

const VISIBLE = 3; // at most three cards; the rest collapse into "+N more" (§33.1)
const DEFAULT_GRACE_MS = 2_000;
const VOICE_HINT = 'Hold your Wispr Flow key and speak';

// The five kinds of §33.2. The Inbox engine (Part D) names them; these aliases keep the UI working if it uses the
// longer names from the spec table.
const ALIASES = {
  permission: 'permission', 'needs-permission': 'permission', 'needs_permission': 'permission',
  question: 'question', ask: 'question',
  done: 'done', stop: 'done',
  drift: 'drift', hold: 'drift', 'drift-hold': 'drift',
  receipt: 'receipt', 'receipt-warning': 'receipt', 'receipt_warning': 'receipt',
};
const normaliseKind = (kind) => ALIASES[String(kind ?? '').toLowerCase()] ?? 'question';

// The keys of §33.2, per kind. A number key answers with that option; Space opens a text box; V opens the same box
// with the Wispr Flow hint; U undoes the turn; E dismisses (also "clear" and "ignore" in the table).
const KEYS = {
  permission: {
    1: { action: 'answer', choice: 0, label: 'Allow once' },
    2: { action: 'answer', choice: 1, label: 'Always allow here' },
    3: { action: 'answer', choice: 2, label: 'Deny' },
    ' ': { action: 'text', hint: 'Add a reason' },
  },
  question: {
    ' ': { action: 'text', hint: 'Type your answer' },
    v: { action: 'voice', hint: VOICE_HINT },
  },
  done: {
    ' ': { action: 'text', hint: 'Reply' },
    v: { action: 'voice', hint: VOICE_HINT },
    u: { action: 'undo' },
    e: { action: 'dismiss', label: 'Clear' },
  },
  drift: {
    1: { action: 'answer', choice: 0, label: 'Resume with corrected brief' },
    2: { action: 'answer', choice: 1, label: 'Let it' },
    3: { action: 'answer', choice: 2, label: 'Stop and review' },
  },
  receipt: {
    1: { action: 'answer', choice: 0, label: 'Send back' },
    2: { action: 'undo', label: 'Undo turn' },
    e: { action: 'dismiss', label: 'Ignore' },
  },
};

// 1–9 pick an option on a Question card; the options come from the core, so only the ones it sent work.
function keyAction(card, rawKey) {
  const key = rawKey === 'Spacebar' ? ' ' : rawKey;
  const kind = normaliseKind(card?.kind);
  if (key === 'j' || key === 'J' || key === 'ArrowDown') return { action: 'move', delta: 1 };
  if (key === 'k' || key === 'K' || key === 'ArrowUp') return { action: 'move', delta: -1 };
  if (key === 'Escape') return { action: card?.state === 'answering' ? 'take-back' : 'leave' };
  if (key === 'Enter') return { action: 'confirm' };
  const lower = typeof key === 'string' && key.length === 1 ? key.toLowerCase() : key;
  if (kind === 'question' && /^[1-9]$/.test(String(key))) {
    const choice = Number(key) - 1;
    const label = card?.options?.[choice];
    return label ? { action: 'answer', choice, label } : null;
  }
  const own = KEYS[kind]?.[lower];
  if (own) {
    // A card whose core-sent options stop short doesn't offer a key for one it hasn't got.
    if (own.action === 'answer' && card?.options && !card.options[own.choice]) return null;
    return { ...own };
  }
  if (lower === 'e') return { action: 'dismiss' };
  if (lower === 'u' && card?.savepointId) return { action: 'undo' };
  return null;
}

// What the window shows for one card: its kind decides the body lines and the key hints.
function describe(card) {
  const kind = normaliseKind(card.kind);
  const hints = {
    permission: ['1 allow once', '2 always allow here', '3 deny', 'Space add a reason'],
    question: [`1–${Math.min(9, Math.max(1, card.options?.length ?? 1))} pick`, 'Space type', 'V voice'],
    done: ['Space reply', 'V voice reply', 'U undo turn', 'E clear'],
    drift: ['1 resume with corrected brief', '2 let it', '3 stop and review'],
    receipt: ['1 send back', '2 undo turn', 'E ignore'],
  }[kind];
  return {
    id: card.id,
    kind,
    agentId: card.agentId,
    title: card.title,
    // Two lines, as the core sends them: the UI never asks for more (§33.10 speed rules).
    lines: String(card.body ?? '').split('\n').slice(0, 2),
    options: card.options ?? [],
    risk: card.risk ?? 0,
    thumb: card.thumb ?? null,
    graceMs: card.graceMs,
    state: card.state,
    chosen: card.chosen ?? null, // the option answered with, for the answered look (design spec §11.3)
    at: card.at,
    hints,
  };
}

function fromMessage(body, at) {
  return {
    id: String(body.id),
    kind: normaliseKind(body.kind),
    agentId: body.agent_id ?? null,
    title: body.title ?? '',
    body: body.body ?? '',
    options: Array.isArray(body.options) ? body.options : [],
    risk: Number(body.risk ?? 0),
    thumb: body.thumb ?? null,
    graceMs: Number.isFinite(body.grace_ms) ? Number(body.grace_ms) : DEFAULT_GRACE_MS,
    urgency: Number.isFinite(body.urgency) ? Number(body.urgency) : null,
    at,
    state: 'open', // open -> answering (grace) -> sent -> released, or dismissed
    pending: null,
    savepointId: null,
  };
}

// now(): injected in tests so ordering is predictable.
function createCards({ now = Date.now } = {}) {
  const cards = new Map(); // id -> card, in the order the core sent them
  let selected = null;

  // The Router's urgency score first, then newest (§33.1 newest on top, Part D step 5).
  const score = (c) => (c.urgency ?? c.risk ?? 0);
  // The id breaks a remaining tie, exactly as mewndo-inbox's `stack` does: two cards that arrive in the same
  // millisecond must still have one order, or the stack would draw them differently on each redraw. Card ids are
  // ULIDs, which sort by the time they were made, so the higher id is the newer card.
  const byId = (a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const order = () => [...cards.values()].filter((c) => c.state !== 'dismissed')
    .sort((a, b) => score(b) - score(a) || b.at - a.at || byId(a, b));

  function keepSelected() {
    const open = order();
    if (!open.some((c) => c.id === selected)) selected = open[0]?.id ?? null;
    return selected;
  }

  return {
    // One core message. Returns the card it touched, or null when it was for something else.
    apply(event) {
      if (event.type === 'inbox.card' && event.body?.id) {
        const existing = cards.get(String(event.body.id));
        const card = fromMessage(event.body, existing?.at ?? now());
        // A card the core sends again while its answer waits keeps that answer: the core is the one authority on
        // what the card says, but a re-send must not silently throw away what the user just pressed.
        if (existing?.state === 'answering') Object.assign(card, { state: 'answering', pending: existing.pending, chosen: existing.chosen });
        cards.set(card.id, card);
        keepSelected();
        return card;
      }
      if (event.type === 'inbox.release' && event.body?.card_id) {
        const card = cards.get(String(event.body.card_id));
        if (!card) return null;
        card.state = 'released';
        card.savepointId = event.body.savepoint_id ?? null;
        // The agent has its answer. A Done or Receipt card stays, because its Undo is the point (§33.4); the rest
        // leave the stack.
        if (!['done', 'receipt'].includes(card.kind)) cards.delete(card.id);
        keepSelected();
        return card;
      }
      // The card's hook gave up, or the user answered in the terminal: nobody can use an answer to it any more.
      if (event.type === 'inbox.expired' && event.body?.card_id) {
        const card = cards.get(String(event.body.card_id));
        if (!card) return null;
        card.state = 'dismissed';
        cards.delete(card.id);
        keepSelected();
        return card;
      }
      return null;
    },

    list: order,
    // The top three and how many are hidden (§33.1 "+4 more").
    visible(n = VISIBLE) {
      const all = order();
      return { cards: all.slice(0, n), more: Math.max(0, all.length - n) };
    },
    count: () => order().length,
    get: (id) => cards.get(String(id)) ?? null,
    selected: () => cards.get(keepSelected()) ?? null,
    select(id) {
      if (cards.has(String(id))) selected = String(id);
      return cards.get(selected) ?? null;
    },
    // J/K between cards.
    move(delta) {
      const all = order();
      if (!all.length) return null;
      const i = Math.max(0, all.findIndex((c) => c.id === keepSelected()));
      selected = all[Math.min(all.length - 1, Math.max(0, i + delta))].id;
      return cards.get(selected);
    },

    // The answer waits for the grace bar. A second answer while one waits is ignored (§33.4).
    startAnswer(id, { choice = null, text = null, via = 'key' } = {}) {
      const card = cards.get(String(id));
      if (!card || card.state !== 'open') return null;
      card.state = 'answering';
      card.pending = { card_id: card.id, choice, text, via };
      card.chosen = choice;
      return { card, graceMs: card.graceMs };
    },
    // Esc during the grace: nothing was sent, so the card simply reopens.
    takeBack(id) {
      const card = cards.get(String(id));
      if (!card || card.state !== 'answering') return null;
      card.state = 'open';
      card.pending = null;
      card.chosen = null;
      return card;
    },
    // The grace bar's animation ended: the answer to send to the core, as an `inbox.answer` body.
    release(id) {
      const card = cards.get(String(id));
      if (!card || card.state !== 'answering') return null;
      const answer = card.pending;
      card.state = 'sent';
      card.pending = null;
      return answer;
    },
    dismiss(id) {
      const card = cards.get(String(id));
      if (!card) return null;
      card.state = 'dismissed';
      cards.delete(card.id);
      keepSelected();
      return card;
    },
  };
}

module.exports = { createCards, keyAction, describe, normaliseKind, KEYS, VISIBLE, DEFAULT_GRACE_MS, VOICE_HINT };
