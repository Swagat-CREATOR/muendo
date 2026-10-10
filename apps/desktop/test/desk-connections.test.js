// The Connections tab of the up-arrow panel (app/desk/connections.js), v1 prompt P6.5 and spec §23.8.
//
// The one thing here that must never be wrong is how sure Mewndo says it is:
//   exact   only when the action came through Mewndo's MCP tool, Mewndo's hooks, or a company audit log that
//           names the OAuth client that made the change;
//   likely  only when a change is matched by time to exactly one known agent session;
//   unknown otherwise, shown as a grey "?" -- including when two sessions were active, because consumer Gmail,
//           Drive and Notion do not say which app changed what.
// "Exact" is never shown for a guess, and a guess is never shown without the word "likely" on it.
const { test } = require('node:test');
const assert = require('node:assert');
const { accountRows, changesFor, confidenceOf, PROTECTION, SESSION_SLACK_MS, PULSE_MS } = require('../app/desk/connections');

const NOW = 1_700_000_000_000;
const ago = (minutes) => NOW - minutes * 60_000;

const GMAIL = { id: 'gmail-1', app: 'Gmail', account: 'priya@gmail.com', protection: 'protected' };
const DRIVE = { id: 'drive-1', app: 'Google Drive', account: 'priya@gmail.com', protection: 'watch' };

// One agent session Mewndo knows about; `to: null` means it is still running.
const session = (agent, fromMinutes, toMinutes = null) => ({
  agentId: `id-${agent}`, agent, from: ago(fromMinutes), to: toMinutes === null ? null : ago(toMinutes),
});

const change = (over = {}) => ({
  id: 'ch-1', accountId: 'gmail-1', at: ago(5), source: 'poll', what: 'archived 3 threads', undoable: true, ...over,
});

test('exact: only Mewndo\'s MCP, Mewndo\'s hooks, or an audit log that names the client', () => {
  // These three are the only sources that know, rather than infer, who acted (§23.8's table).
  for (const [source, why] of [
    ['mcp', 'through Mewndo\u2019s MCP tool'],
    ['hooks', 'through Mewndo\u2019s hooks'],
    ['audit', 'named in the account\u2019s audit log'],
  ]) {
    const out = confidenceOf(change({ source, agent: 'Grok Bot', agentId: 'g1' }), []);
    assert.deepStrictEqual(out, { confidence: 'exact', agent: 'Grok Bot', agentId: 'g1', why }, source);
  }
  // Exact needs no session at all: the source itself named the agent.
  assert.strictEqual(confidenceOf(change({ source: 'mcp', agent: 'Grok Bot' }), []).confidence, 'exact');
  // And it stays exact even when several sessions were active, because it is not a time guess.
  const busy = [session('Grok Bot', 30), session('ChatGPT', 20), session('Meta Muse', 10)];
  assert.strictEqual(confidenceOf(change({ source: 'mcp', agent: 'Grok Bot' }), busy).confidence, 'exact');
});

test('a source that could be exact but names no agent is NOT exact', () => {
  // This is the case that would quietly turn a guess into a certainty: the change came through a trusted source
  // but that source did not say who. Without a name there is nothing to be exact about.
  for (const source of ['mcp', 'hooks', 'audit']) {
    for (const agent of [undefined, null, '']) {
      const out = confidenceOf(change({ source, agent }), [session('Grok Bot', 30)]);
      assert.notStrictEqual(out.confidence, 'exact', `${source} with agent ${JSON.stringify(agent)}`);
      assert.strictEqual(out.confidence, 'likely', 'it falls back to the time match, which says "likely"');
    }
  }
});

test('a polled change is never exact, however certain it looks', () => {
  // Consumer Gmail, Drive and Notion do not tell other apps which app made a change. A change Mewndo found by
  // polling therefore cannot be exact, even when the poll result carries an agent name from somewhere else.
  const out = confidenceOf(change({ source: 'poll', agent: 'Grok Bot', agentId: 'g1' }), [session('Grok Bot', 30)]);
  assert.strictEqual(out.confidence, 'likely');
  assert.strictEqual(out.why, 'matched by time to a known agent session');
  // An unknown source word is treated as untrusted, not as exact.
  for (const source of ['connector', 'webhook', 'MCP', 'hook', '', undefined]) {
    assert.notStrictEqual(confidenceOf(change({ source, agent: 'Grok Bot' }), []).confidence, 'exact', String(source));
  }
});

test('likely: exactly one known session was active at the time, and nothing more is claimed', () => {
  const one = [session('Grok Bot', 30)]; // still running
  const out = confidenceOf(change({ at: ago(5) }), one);
  assert.deepStrictEqual(out, {
    confidence: 'likely', agent: 'Grok Bot', agentId: 'id-Grok Bot', why: 'matched by time to a known agent session',
  });
  // A change before the session started is not that session's.
  assert.strictEqual(confidenceOf(change({ at: ago(40) }), one).confidence, 'unknown');
  // A change just after a session ended still counts, within the slack: a change takes a moment to show up.
  const ended = [session('Grok Bot', 30, 10)];
  assert.strictEqual(SESSION_SLACK_MS, 60_000);
  assert.strictEqual(confidenceOf(change({ at: ago(10) }), ended).confidence, 'likely', 'at the moment it ended');
  assert.strictEqual(confidenceOf(change({ at: ago(10) + SESSION_SLACK_MS }), ended).confidence, 'likely', 'one minute after');
  assert.strictEqual(confidenceOf(change({ at: ago(10) + SESSION_SLACK_MS + 1 }), ended).confidence, 'unknown', 'a millisecond past the slack');
  // The boundaries themselves are inside the session, not outside it.
  assert.strictEqual(confidenceOf(change({ at: ago(30) }), one).confidence, 'likely', 'the instant it started');
});

test('two sessions active: unknown, with the reason, rather than pinned on whichever looks likelier', () => {
  // This is the rule the spec is most explicit about: with more than one session active Mewndo cannot tell, and
  // says so, instead of picking the one that was busiest or started most recently.
  const two = [session('Grok Bot', 30), session('ChatGPT', 20)];
  const out = confidenceOf(change({ at: ago(5) }), two);
  assert.deepStrictEqual(out, {
    confidence: 'unknown', agent: null, agentId: null,
    why: '2 agent sessions were active, so Mewndo can\u2019t tell which made this change',
  });
  const three = [...two, session('Meta Muse', 10)];
  assert.match(confidenceOf(change({ at: ago(5) }), three).why, /^3 agent sessions were active/);
  // Two sessions where only one overlaps the change is still one: the count is of overlapping sessions.
  const onlyOneOverlaps = [session('Grok Bot', 30, 25), session('ChatGPT', 10)];
  const single = confidenceOf(change({ at: ago(5) }), onlyOneOverlaps);
  assert.deepStrictEqual([single.confidence, single.agent], ['likely', 'ChatGPT']);
});

test('no session known: unknown, and the reason says that and not something vaguer', () => {
  const out = confidenceOf(change({ at: ago(5) }), []);
  assert.deepStrictEqual(out, {
    confidence: 'unknown', agent: null, agentId: null, why: 'no agent session was known to be active',
  });
  assert.strictEqual(confidenceOf(change({ at: ago(5) })).confidence, 'unknown', 'with no sessions argument at all');
});

test('the three bubbles: a named solid one, a named outlined one, and a grey question mark', () => {
  const changes = [
    change({ id: 'a', source: 'mcp', agent: 'Grok Bot', at: ago(2) }),   // exact
    change({ id: 'b', source: 'poll', at: ago(6) }),                     // likely: one session
    change({ id: 'c', source: 'poll', at: ago(90) }),                    // unknown: nothing was running
  ];
  const sessions = [session('ChatGPT', 10)];
  const [row] = accountRows({ accounts: [GMAIL], changes, sessions, now: NOW });
  assert.strictEqual(row.changes, 3);
  assert.strictEqual(row.unknownChanges, 1);
  // Highest confidence first, so the certain ones read before the guesses.
  assert.deepStrictEqual(row.bubbles.map((b) => b.confidence), ['exact', 'likely', 'unknown']);
  const [exact, likely, unknown] = row.bubbles;
  assert.strictEqual(exact.agent, 'Grok Bot');
  assert.strictEqual(likely.agent, 'ChatGPT');
  // The grey "?" has no agent name on it at all: there is no name to put there.
  assert.strictEqual(unknown.agent, null);
  // Hover text (§23.8: "Grok Bot · 4 changes · 2 min ago"). Only the likely one carries the word "likely", and
  // the unknown one carries the reason instead of a name.
  assert.strictEqual(exact.hover, 'Grok Bot \u00b7 1 change \u00b7 2 min ago');
  assert.strictEqual(likely.hover, 'ChatGPT \u00b7 likely \u00b7 1 change \u00b7 6 min ago');
  assert.strictEqual(unknown.hover, '1 change \u00b7 90 min ago \u00b7 no agent session was known to be active');
  assert.doesNotMatch(exact.hover, /likely/, 'an exact bubble never says likely');
  assert.doesNotMatch(unknown.hover, /likely/, 'and nor does a question mark');
});

test('every unknown change collapses into one question mark, whatever the reason', () => {
  // Two different reasons for not knowing are still one "?" bubble: the user is told how many changes nobody can
  // be blamed for, not given one grey bubble per cause.
  const changes = [
    change({ id: 'a', at: ago(5) }),   // two sessions active
    change({ id: 'b', at: ago(300) }), // none active
  ];
  const sessions = [session('Grok Bot', 10), session('ChatGPT', 10)];
  const [row] = accountRows({ accounts: [GMAIL], changes, sessions, now: NOW });
  assert.strictEqual(row.bubbles.length, 1);
  assert.deepStrictEqual([row.bubbles[0].confidence, row.bubbles[0].changes], ['unknown', 2]);
  assert.strictEqual(row.unknownChanges, 2);
});

test('one agent, some changes exact and some only likely: the bubble shows the best and counts both', () => {
  const changes = [
    change({ id: 'a', source: 'poll', at: ago(20) }),                      // likely Grok Bot
    change({ id: 'b', source: 'mcp', agent: 'Grok Bot', at: ago(1) }),     // exact
  ];
  const [row] = accountRows({ accounts: [GMAIL], changes, sessions: [session('Grok Bot', 30)], now: NOW });
  assert.strictEqual(row.bubbles.length, 1, 'one agent, one bubble');
  const [b] = row.bubbles;
  assert.strictEqual(b.confidence, 'exact', 'the strongest evidence wins for the bubble');
  assert.strictEqual(b.changes, 2);
  assert.deepStrictEqual(b.counts, { likely: 1, exact: 1 }, 'but both counts are kept, so nothing is overstated');
  assert.strictEqual(b.ago, 1, 'the time is the most recent change');
  // And the hover says the split, rather than letting the solid bubble speak for the guess underneath it.
  assert.strictEqual(b.hover, 'Grok Bot \u00b7 1 exact, 1 likely \u00b7 2 changes \u00b7 1 min ago');
});

test('a bubble pulses only while the agent is acting', () => {
  assert.strictEqual(PULSE_MS, 60_000);
  const fresh = accountRows({ accounts: [GMAIL], changes: [change({ at: NOW - 30_000 })], sessions: [session('Grok Bot', 5)], now: NOW });
  assert.strictEqual(fresh[0].bubbles[0].pulsing, true);
  const stale = accountRows({ accounts: [GMAIL], changes: [change({ at: NOW - PULSE_MS })], sessions: [session('Grok Bot', 5)], now: NOW });
  assert.strictEqual(stale[0].bubbles[0].pulsing, false);
});

test('one row per account, with its protection state in the words §23.8 uses', () => {
  assert.deepStrictEqual(PROTECTION, {
    protected: 'Protected', hold: 'Hold on', watch: 'Watch only', unavailable: 'Can\u2019t be connected',
  });
  const accounts = [GMAIL, DRIVE, { id: 'wa', app: 'WhatsApp', account: 'personal', protection: 'unavailable' }];
  const rows = accountRows({ accounts, changes: [], sessions: [], now: NOW });
  assert.deepStrictEqual(rows.map((r) => r.protectionLabel), ['Protected', 'Watch only', 'Can\u2019t be connected']);
  assert.deepStrictEqual(rows.map((r) => r.id), ['gmail-1', 'drive-1', 'wa']);
  assert.deepStrictEqual(rows.map((r) => r.account), ['priya@gmail.com', 'priya@gmail.com', 'personal']);
  // §23.8 Limits: a personal WhatsApp has no official API, so the row says that instead of pretending to watch it.
  assert.match(rows[2].note, /No official API/);
  assert.strictEqual(rows[0].note, null, 'a protected account needs no excuse');
  // A protection word Mewndo does not know falls back to the weakest claim, never to "Protected".
  const odd = accountRows({ accounts: [{ id: 'x', app: 'X', account: 'x', protection: 'fully-secure' }], now: NOW });
  assert.strictEqual(odd[0].protectionLabel, 'Watch only');
  // Changes in one account never appear in another's row.
  const mixed = accountRows({ accounts, changes: [change({ accountId: 'drive-1', source: 'mcp', agent: 'Muse' })], sessions: [], now: NOW });
  assert.deepStrictEqual(mixed.map((r) => r.changes), [0, 1, 0]);
});

test('tapping a row: the recent changes grouped by agent, each with its own confidence', () => {
  const changes = [
    change({ id: 'a', source: 'mcp', agent: 'Grok Bot', at: ago(2), what: 'sent 1 email', undoable: false }),
    change({ id: 'b', source: 'poll', at: ago(8), what: 'archived 3 threads', undoable: true }),
    change({ id: 'c', source: 'poll', at: ago(400), what: 'deleted a label', undoable: true }),
  ];
  const groups = changesFor('gmail-1', { changes, sessions: [session('ChatGPT', 20)], now: NOW });
  assert.deepStrictEqual(groups.map((g) => [g.agent, g.confidence]), [['Grok Bot', 'exact'], ['ChatGPT', 'likely'], [null, 'unknown']]);
  // Newest first inside a group, with how long ago and what happened.
  assert.deepStrictEqual(groups[1].changes.map((c) => [c.id, c.ago, c.what]), [['b', 8, 'archived 3 threads']]);
  // Each change keeps its own confidence and reason, not the group's.
  assert.strictEqual(groups[2].changes[0].confidence, 'unknown');
  assert.strictEqual(groups[2].changes[0].why, 'no agent session was known to be active');
  // A change Mewndo has no earlier version of says so rather than offering an Undo that would fail.
  assert.deepStrictEqual(groups[0].changes[0].undo, { can: false, label: 'Undo', why: 'Mewndo has no earlier version of this to put back.' });
  assert.deepStrictEqual(groups[1].changes[0].undo, { can: true, label: 'Undo' });
  // Only a literal true is undoable: a missing or truthy-but-not-true flag is treated as "cannot".
  for (const undoable of [undefined, null, 1, 'yes', {}]) {
    const [g] = changesFor('gmail-1', { changes: [change({ source: 'mcp', agent: 'A', undoable })], now: NOW });
    assert.strictEqual(g.changes[0].undo.can, false, String(undoable));
  }
});

test('the change list is newest first and capped, and another account\'s changes never leak in', () => {
  const changes = Array.from({ length: 30 }, (_, i) => change({ id: `c${i}`, at: ago(i), source: 'mcp', agent: 'Grok Bot' }));
  changes.push(change({ id: 'other', accountId: 'drive-1', source: 'mcp', agent: 'Grok Bot', at: NOW }));
  const [group] = changesFor('gmail-1', { changes, now: NOW, limit: 20 });
  assert.strictEqual(group.changes.length, 20);
  assert.deepStrictEqual(group.changes.slice(0, 3).map((c) => c.id), ['c0', 'c1', 'c2'], 'newest first');
  assert.ok(!group.changes.some((c) => c.id === 'other'), 'the other account\'s change is not here');
  assert.deepStrictEqual(changesFor('nobody', { changes, now: NOW }), [], 'an account with no changes has no groups');
});

test('a row with no changes at all has no bubbles, not an empty question mark', () => {
  const [row] = accountRows({ accounts: [GMAIL], changes: [], sessions: [session('Grok Bot', 5)], now: NOW });
  assert.deepStrictEqual(row.bubbles, []);
  assert.deepStrictEqual([row.changes, row.unknownChanges], [0, 0]);
  assert.deepStrictEqual(accountRows(), [], 'and no accounts means no rows');
});
