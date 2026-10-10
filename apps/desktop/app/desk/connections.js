// The Connections tab of the up-arrow panel, with real data (spec §23.8, v1 prompt P6.5). One row per connected
// app or account: its protection state, and a bubble for every agent using it.
// Plain functions, no Electron and no DOM, so tests run it with plain Node.
//
// How sure Mewndo is (the table in §23.8), and it always says so:
//   exact   — the action came through Mewndo's MCP tool, Mewndo's hooks, or a company audit log that names the
//             OAuth client that made the change. Shown as a solid bubble.
//   likely  — a change arrived while exactly one known agent session was active: time correlation, nothing more.
//             Shown as an outlined bubble with "likely" on hover.
//   unknown — no agent session was active, or more than one was and Mewndo cannot tell which: a grey "?".
// "exact" is never shown for a guess. With two sessions active the change stays unknown rather than being pinned
// on whichever one looks likelier, because consumer Gmail, Drive and Notion don't say which app changed what.

const PROTECTION = {
  protected: 'Protected',
  hold: 'Hold on',
  watch: 'Watch only',
  unavailable: 'Can\u2019t be connected',
};

// How long after a session ends a change can still be put down to it.
const SESSION_SLACK_MS = 60_000;
// A bubble pulses while the agent is acting (§23.8).
const PULSE_MS = 60_000;

const EXACT_SOURCES = new Set(['mcp', 'hooks', 'audit']);

// One change -> who did it and how sure that is.
//   change:   { accountId, at, source: 'mcp' | 'hooks' | 'audit' | 'poll', agent?, agentId?, what, undoable }
//   sessions: [{ agentId, agent, from, to }] agent sessions Mewndo knows about; to = null means still running.
function confidenceOf(change, sessions = []) {
  if (EXACT_SOURCES.has(change.source) && change.agent) {
    const how = { mcp: 'through Mewndo\u2019s MCP tool', hooks: 'through Mewndo\u2019s hooks', audit: 'named in the account\u2019s audit log' }[change.source];
    return { confidence: 'exact', agent: change.agent, agentId: change.agentId ?? null, why: how };
  }
  const active = sessions.filter((s) => change.at >= s.from && change.at <= (s.to ?? Infinity) + SESSION_SLACK_MS);
  if (active.length === 1) {
    return { confidence: 'likely', agent: active[0].agent, agentId: active[0].agentId ?? null, why: 'matched by time to a known agent session' };
  }
  if (active.length > 1) {
    return {
      confidence: 'unknown', agent: null, agentId: null,
      why: `${active.length} agent sessions were active, so Mewndo can\u2019t tell which made this change`,
    };
  }
  return { confidence: 'unknown', agent: null, agentId: null, why: 'no agent session was known to be active' };
}

const RANK = { exact: 3, likely: 2, unknown: 1 };
const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));
const plural = (n) => `${n} change${n === 1 ? '' : 's'}`;

// What one bubble is allowed to claim about how it knows. A bubble takes the shape of its strongest evidence --
// solid for exact, outlined for likely -- but a bubble covering both must not let the solid shape speak for the
// guess underneath it: it names the split instead. §23.8: the panel always says how sure it is, and "exact" is
// never shown for a guess.
function sureness(bubble) {
  const kinds = ['exact', 'likely'].filter((k) => bubble.counts[k]);
  if (kinds.length < 2) return bubble.confidence === 'likely' ? ' \u00b7 likely' : '';
  return ` \u00b7 ${bubble.counts.exact} exact, ${bubble.counts.likely} likely`;
}

// One row per account, with its agent bubbles. accounts: [{ id, app, account, protection, note? }].
function accountRows({ accounts = [], changes = [], sessions = [], now = Date.now() } = {}) {
  return accounts.map((account) => {
    const mine = changes.filter((c) => c.accountId === account.id).map((c) => ({ ...c, ...confidenceOf(c, sessions) }));
    const bubbles = new Map(); // agent name (or '?') -> bubble
    for (const c of mine) {
      const key = c.confidence === 'unknown' ? '?' : c.agent;
      const b = bubbles.get(key) ?? { agent: c.agent, confidence: c.confidence, changes: 0, counts: {}, lastAt: 0, why: c.why };
      b.changes += 1;
      b.counts[c.confidence] = (b.counts[c.confidence] ?? 0) + 1;
      if (RANK[c.confidence] > RANK[b.confidence]) { b.confidence = c.confidence; b.why = c.why; }
      b.lastAt = Math.max(b.lastAt, c.at);
      bubbles.set(key, b);
    }
    const rows = [...bubbles.values()]
      .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || b.lastAt - a.lastAt)
      .map((b) => ({
        agent: b.agent, confidence: b.confidence, changes: b.changes, ago: minutes(now - b.lastAt),
        // How many changes each level of certainty covers, so the UI can never round a guess up to a certainty.
        counts: { ...b.counts },
        pulsing: now - b.lastAt < PULSE_MS, why: b.why,
        hover: b.confidence === 'unknown'
          ? `${plural(b.changes)} \u00b7 ${minutes(now - b.lastAt)} min ago \u00b7 ${b.why}`
          : `${b.agent}${sureness(b)} \u00b7 ${plural(b.changes)} \u00b7 ${minutes(now - b.lastAt)} min ago`,
      }));
    return {
      id: account.id,
      app: account.app,
      account: account.account,
      protection: account.protection,
      protectionLabel: PROTECTION[account.protection] ?? PROTECTION.watch,
      // §23.8 Limits: a personal WhatsApp has no API, so the row says that instead of pretending to watch it.
      note: account.note ?? (account.protection === 'unavailable' ? 'No official API for this account, so Mewndo can\u2019t protect it.' : null),
      bubbles: rows,
      changes: mine.length,
      unknownChanges: mine.filter((c) => c.confidence === 'unknown').length,
    };
  });
}

// Tapping a row: the recent changes in that account, grouped by agent, with Undo (P6.5).
// A change Mewndo has no previous version for says so rather than offering an Undo that would fail.
function changesFor(accountId, { changes = [], sessions = [], now = Date.now(), limit = 20 } = {}) {
  const mine = changes.filter((c) => c.accountId === accountId)
    .map((c) => ({ ...c, ...confidenceOf(c, sessions) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
  const groups = new Map();
  for (const c of mine) {
    const key = c.confidence === 'unknown' ? '?' : c.agent;
    const g = groups.get(key) ?? { agent: c.agent, confidence: c.confidence, why: c.why, changes: [] };
    if (RANK[c.confidence] > RANK[g.confidence]) { g.confidence = c.confidence; g.why = c.why; }
    g.changes.push({
      id: c.id ?? null, at: c.at, ago: minutes(now - c.at), what: c.what ?? '',
      confidence: c.confidence, why: c.why,
      undo: c.undoable === true
        ? { can: true, label: 'Undo' }
        : { can: false, label: 'Undo', why: 'Mewndo has no earlier version of this to put back.' },
    });
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || b.changes[0].at - a.changes[0].at);
}

module.exports = { accountRows, changesFor, confidenceOf, PROTECTION, SESSION_SLACK_MS, PULSE_MS };
