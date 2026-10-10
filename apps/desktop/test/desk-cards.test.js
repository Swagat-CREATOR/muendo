// The Agent Inbox card stack (app/desk/cards.js): the keys of §33.2 per kind, the 2 s grace of §33.4 taking its
// duration from the card the core sent, and what happens to a card once its answer is released.
// Driven by a fake event source: the core is not running in these tests, so `inbox.card` and `inbox.release`
// messages are handed to apply() exactly as app/desk/core-client.js would deliver them.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  createCards, keyAction, describe, normaliseKind, KEYS, VISIBLE, DEFAULT_GRACE_MS, VOICE_HINT,
} = require('../app/desk/cards');

// One `inbox.card` message, in mewndo-proto's InboxCard shape (core/crates/mewndo-proto/src/lib.rs:229).
const cardEvent = (body) => ({
  type: 'inbox.card',
  body: {
    id: 'c1', kind: 'question', agent_id: 'a1', title: 'Which one?', body: 'line one\nline two',
    options: [], risk: 0, thumb: null, grace_ms: 2000, ...body,
  },
});
const releaseEvent = (body) => ({ type: 'inbox.release', body: { card_id: 'c1', savepoint_id: null, ...body } });

// A clock the test moves by hand, so card order is predictable.
function at(start = 1_000) {
  let t = start;
  return { now: () => (t += 1_000) };
}

test('the five kinds of §33.2, and the longer names from the spec table', () => {
  assert.deepStrictEqual(Object.keys(KEYS), ['permission', 'question', 'done', 'drift', 'receipt']);
  // The core sends the short names (mewndo-inbox CardKind::as_str); the aliases keep the spec's own wording working.
  for (const [sent, want] of [
    ['permission', 'permission'], ['needs-permission', 'permission'], ['needs_permission', 'permission'],
    ['question', 'question'], ['ask', 'question'],
    ['done', 'done'], ['stop', 'done'],
    ['drift', 'drift'], ['hold', 'drift'], ['drift-hold', 'drift'],
    ['receipt', 'receipt'], ['receipt-warning', 'receipt'], ['receipt_warning', 'receipt'],
    ['PERMISSION', 'permission'],
  ]) {
    assert.strictEqual(normaliseKind(sent), want, sent);
  }
  // A kind this app has never heard of is shown as a question, which has no destructive key, rather than dropped.
  assert.strictEqual(normaliseKind('something-new'), 'question');
  assert.strictEqual(normaliseKind(undefined), 'question');
});

test('§33.2 Needs permission: 1 allow once, 2 always allow here, 3 deny, Space add a reason', () => {
  const card = { kind: 'permission', options: ['Allow once', 'Always allow here', 'Deny', 'Add a reason'] };
  assert.deepStrictEqual(keyAction(card, '1'), { action: 'answer', choice: 0, label: 'Allow once' });
  assert.deepStrictEqual(keyAction(card, '2'), { action: 'answer', choice: 1, label: 'Always allow here' });
  assert.deepStrictEqual(keyAction(card, '3'), { action: 'answer', choice: 2, label: 'Deny' });
  assert.deepStrictEqual(keyAction(card, ' '), { action: 'text', hint: 'Add a reason' });
  assert.deepStrictEqual(keyAction(card, 'Spacebar'), { action: 'text', hint: 'Add a reason' }, 'the old DOM key name');
  assert.strictEqual(keyAction(card, '4'), null, 'a key §33.2 does not give this kind does nothing');
});

test('a permission card whose core-sent options stop short offers no key for the ones it has not got', () => {
  // The core is the one authority on what a card offers (§38.3). A card with two options must not let the user
  // press 3 and have the app invent a Deny the core never sent.
  const two = { kind: 'permission', options: ['Allow once', 'Deny'] };
  assert.deepStrictEqual(keyAction(two, '1'), { action: 'answer', choice: 0, label: 'Allow once' });
  assert.deepStrictEqual(keyAction(two, '2'), { action: 'answer', choice: 1, label: 'Always allow here' });
  assert.strictEqual(keyAction(two, '3'), null, 'no third option, so no third key');
});

test('§33.2 Question: 1-9 pick one of the core\'s own options, Space type, V voice', () => {
  const card = { kind: 'question', options: ['Use Postgres (Recommended)', 'Use SQLite', 'Ask me later'] };
  assert.deepStrictEqual(keyAction(card, '1'), { action: 'answer', choice: 0, label: 'Use Postgres (Recommended)' });
  assert.deepStrictEqual(keyAction(card, '3'), { action: 'answer', choice: 2, label: 'Ask me later' });
  assert.strictEqual(keyAction(card, '4'), null, 'only the options the core sent work');
  assert.strictEqual(keyAction(card, '0'), null, '1-9, not 0');
  assert.deepStrictEqual(keyAction(card, ' '), { action: 'text', hint: 'Type your answer' });
  assert.deepStrictEqual(keyAction(card, 'v'), { action: 'voice', hint: VOICE_HINT });
  assert.deepStrictEqual(keyAction(card, 'V'), { action: 'voice', hint: VOICE_HINT }, 'upper case too');
  // V says what to do, because Mewndo has no speech engine of its own (§33.5).
  assert.strictEqual(VOICE_HINT, 'Hold your Wispr Flow key and speak');
  // A question with nine options uses all nine keys.
  const nine = { kind: 'question', options: Array.from({ length: 9 }, (_, i) => `opt ${i + 1}`) };
  assert.deepStrictEqual(keyAction(nine, '9'), { action: 'answer', choice: 8, label: 'opt 9' });
});

test('§33.2 Done: Space reply, V voice reply, U undo turn, E clear', () => {
  const card = { kind: 'done', options: [] };
  assert.deepStrictEqual(keyAction(card, ' '), { action: 'text', hint: 'Reply' });
  assert.deepStrictEqual(keyAction(card, 'v'), { action: 'voice', hint: VOICE_HINT });
  assert.deepStrictEqual(keyAction(card, 'u'), { action: 'undo' });
  assert.deepStrictEqual(keyAction(card, 'e'), { action: 'dismiss', label: 'Clear' });
});

test('§33.2 Drift / Hold: 1 resume with corrected brief, 2 let it, 3 stop and review', () => {
  const card = { kind: 'drift' };
  assert.deepStrictEqual(keyAction(card, '1'), { action: 'answer', choice: 0, label: 'Resume with corrected brief' });
  assert.deepStrictEqual(keyAction(card, '2'), { action: 'answer', choice: 1, label: 'Let it' });
  assert.deepStrictEqual(keyAction(card, '3'), { action: 'answer', choice: 2, label: 'Stop and review' });
  assert.deepStrictEqual(keyAction(card, 'e'), { action: 'dismiss' }, 'E dismisses every card (§33.2 footnote)');
});

test('§33.2 Receipt warning: 1 send back, 2 undo turn, E ignore', () => {
  const card = { kind: 'receipt' };
  assert.deepStrictEqual(keyAction(card, '1'), { action: 'answer', choice: 0, label: 'Send back' });
  assert.deepStrictEqual(keyAction(card, '2'), { action: 'undo', label: 'Undo turn' });
  assert.deepStrictEqual(keyAction(card, 'e'), { action: 'dismiss', label: 'Ignore' });
});

test('the keys every card has: J/K move, Enter confirms, E dismisses, Esc takes back during the grace', () => {
  const card = { kind: 'question', options: ['a'] };
  for (const key of ['j', 'J', 'ArrowDown']) assert.deepStrictEqual(keyAction(card, key), { action: 'move', delta: 1 }, key);
  for (const key of ['k', 'K', 'ArrowUp']) assert.deepStrictEqual(keyAction(card, key), { action: 'move', delta: -1 }, key);
  assert.deepStrictEqual(keyAction(card, 'Enter'), { action: 'confirm' });
  assert.deepStrictEqual(keyAction(card, 'e'), { action: 'dismiss' });
  // Esc means two different things, and which one depends on the card's own state, not on the key.
  assert.deepStrictEqual(keyAction({ ...card, state: 'open' }, 'Escape'), { action: 'leave' });
  assert.deepStrictEqual(keyAction({ ...card, state: 'answering' }, 'Escape'), { action: 'take-back' });
  // U only offers an undo when there is a save point to go back to (§33.4).
  assert.strictEqual(keyAction(card, 'u'), null, 'nothing to undo yet');
  assert.deepStrictEqual(keyAction({ ...card, savepointId: 'sp1' }, 'u'), { action: 'undo' });
  // Anything else is not a Mewndo key.
  for (const key of ['q', 'Tab', 'F5', 'Shift', '-']) assert.strictEqual(keyAction(card, key), null, key);
});

test('a card is built from the core\'s message, two body lines only, and nothing is invented', () => {
  const cards = createCards(at());
  const card = cards.apply(cardEvent({
    kind: 'permission', title: 'Run npm test?', body: 'in shop\nnpm test -- --watch\nand a third line nobody shows',
    options: ['Allow once', 'Deny'], risk: 4, grace_ms: 2000,
  }));
  assert.strictEqual(card.id, 'c1');
  assert.strictEqual(card.agentId, 'a1');
  assert.strictEqual(card.state, 'open');
  const view = describe(card);
  // "The core sends the UI only what it shows: titles, two-line bodies" (§33.10 speed rules).
  assert.deepStrictEqual(view.lines, ['in shop', 'npm test -- --watch']);
  assert.deepStrictEqual(view.options, ['Allow once', 'Deny']);
  assert.deepStrictEqual(view.hints, ['1 allow once', '2 always allow here', '3 deny', 'Space add a reason']);
  assert.strictEqual(view.risk, 4);
  assert.strictEqual(view.thumb, null);
  // A question's hints count only the options the core actually sent.
  const q = describe(cards.apply(cardEvent({ id: 'c2', kind: 'question', options: ['a', 'b', 'c'] })));
  assert.deepStrictEqual(q.hints, ['1–3 pick', 'Space type', 'V voice']);
  const none = describe(cards.apply(cardEvent({ id: 'c3', kind: 'question', options: [] })));
  assert.deepStrictEqual(none.hints, ['1–1 pick', 'Space type', 'V voice']);
});

test('the grace bar takes its duration from the event, not from a constant in the app', () => {
  // §33.4 says 2 s, but the Inbox owns the setting (mewndo-inbox Card::to_proto takes `grace` as an argument), so
  // a user who set it to 5 s must get a 5 s bar, and the CSS animation is sized from this number.
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'slow', grace_ms: 5000 }));
  cards.apply(cardEvent({ id: 'off', grace_ms: 0 }));
  assert.strictEqual(cards.get('slow').graceMs, 5000);
  assert.strictEqual(describe(cards.get('slow')).graceMs, 5000);
  assert.strictEqual(cards.startAnswer('slow', { choice: 0 }).graceMs, 5000);
  // 0 is a real setting ("release at once"), not a missing value, so it must not fall back to 2 s.
  assert.strictEqual(cards.startAnswer('off', { choice: 0 }).graceMs, 0);
  // A core that sends no grace_ms at all, or junk, gets the §33.4 default rather than NaN.
  for (const grace_ms of [undefined, null, 'soon', NaN]) {
    cards.apply(cardEvent({ id: 'bad', grace_ms }));
    assert.strictEqual(cards.get('bad').graceMs, DEFAULT_GRACE_MS, String(grace_ms));
  }
  assert.strictEqual(DEFAULT_GRACE_MS, 2_000);
});

test('the 2 s grace: Esc takes the answer back, a second answer is ignored, release hands it over once', () => {
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'c1', kind: 'permission', options: ['Allow once', 'Always allow here', 'Deny'] }));
  // Nothing is sent while the bar drains: the answer is held here (§33.4).
  const started = cards.startAnswer('c1', { choice: 2, via: 'key' });
  assert.strictEqual(started.card.state, 'answering');
  assert.deepStrictEqual(started.card.pending, { card_id: 'c1', choice: 2, text: null, via: 'key' });
  // A second answer while one waits is ignored.
  assert.strictEqual(cards.startAnswer('c1', { choice: 0 }), null);
  assert.deepStrictEqual(cards.get('c1').pending, { card_id: 'c1', choice: 2, text: null, via: 'key' }, 'the first answer stands');
  // Esc during the grace: nothing was sent, so the card simply reopens.
  assert.strictEqual(cards.takeBack('c1').state, 'open');
  assert.strictEqual(cards.get('c1').pending, null);
  assert.strictEqual(cards.takeBack('c1'), null, 'and taking back twice does nothing');
  // Answering again now works, and the bar's animationend releases it.
  cards.startAnswer('c1', { choice: 0, via: 'click' });
  assert.deepStrictEqual(cards.release('c1'), { card_id: 'c1', choice: 0, text: null, via: 'click' });
  assert.strictEqual(cards.get('c1').state, 'sent');
  assert.strictEqual(cards.release('c1'), null, 'released once, never twice');
  assert.strictEqual(cards.takeBack('c1'), null, 'and Esc after it has gone cannot recall it');
});

test('a typed or dictated answer travels with how it was given, for the Receipt (§35)', () => {
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'c1', kind: 'question' }));
  cards.startAnswer('c1', { text: 'use Postgres', via: 'voice' });
  assert.deepStrictEqual(cards.release('c1'), { card_id: 'c1', choice: null, text: 'use Postgres', via: 'voice' });
});

test('a card the core re-sends while its answer waits keeps that answer', () => {
  // The core is the one authority on what the card says, but a re-send must not throw away what the user just
  // pressed: the agent would then wait for its hook timeout with an answer sitting unsent in the app.
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'c1', kind: 'permission', options: ['Allow once', 'Deny'], title: 'first' }));
  cards.startAnswer('c1', { choice: 1 });
  const again = cards.apply(cardEvent({ id: 'c1', kind: 'permission', options: ['Allow once', 'Deny'], title: 'second' }));
  assert.strictEqual(again.title, 'second', 'the core\'s newer text wins');
  assert.strictEqual(again.state, 'answering');
  assert.deepStrictEqual(cards.release('c1'), { card_id: 'c1', choice: 1, text: null, via: 'key' });
});

test('an answered card leaves the stack, except Done and Receipt, whose Undo is the point', () => {
  const cards = createCards(at());
  for (const [id, kind] of [['p', 'permission'], ['q', 'question'], ['d', 'done'], ['r', 'receipt'], ['x', 'drift']]) {
    cards.apply(cardEvent({ id, kind, options: ['a', 'b', 'c'] }));
  }
  assert.strictEqual(cards.count(), 5);
  for (const id of ['p', 'q', 'd', 'r', 'x']) {
    const card = cards.apply(releaseEvent({ card_id: id, savepoint_id: `sp-${id}` }));
    assert.strictEqual(card.state, 'released', id);
  }
  assert.deepStrictEqual(cards.list().map((c) => c.id).sort(), ['d', 'r'], 'Done and Receipt stay for their Undo');
  assert.strictEqual(cards.get('d').savepointId, 'sp-d', 'the save point the release wrote (§33.4)');
  assert.deepStrictEqual(keyAction(cards.get('d'), 'u'), { action: 'undo' });
  // A release for a card this app has never seen is not an error, just nothing.
  assert.strictEqual(cards.apply(releaseEvent({ card_id: 'never' })), null);
  // Anything that is not an inbox message is left alone.
  assert.strictEqual(cards.apply({ type: 'agent.status', body: { agent_id: 'a' } }), null);
  assert.strictEqual(cards.apply({ type: 'inbox.card', body: {} }), null, 'a card with no id is not a card');
});

test('the stack shows the top three and says how many are hidden', () => {
  const cards = createCards(at());
  for (let i = 0; i < 7; i++) cards.apply(cardEvent({ id: `c${i}` }));
  assert.strictEqual(VISIBLE, 3);
  const view = cards.visible();
  assert.strictEqual(view.cards.length, 3);
  assert.strictEqual(view.more, 4, '"+4 more" (§33.1)');
  assert.deepStrictEqual(cards.visible(10), { cards: cards.list(), more: 0 });
});

test('order: the Router\'s urgency first, then newest, and risk stands in while §38.5 cannot carry urgency', () => {
  // §33.10 Part D step 5 orders by the Router's urgency score, then by time. mewndo-proto's InboxCard has no
  // urgency field (lib.rs:229) and mewndo-inbox's Card::to_proto drops it, so until the protocol carries it the
  // app can only fall back to the card's risk. This test records that honestly: it is the app agreeing with the
  // core when it can and guessing a stand-in when it cannot.
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'old-risky', risk: 5 }));
  cards.apply(cardEvent({ id: 'new-calm', risk: 1 }));
  assert.deepStrictEqual(cards.list().map((c) => c.id), ['old-risky', 'new-calm'], 'risk stands in for urgency');
  cards.apply(cardEvent({ id: 'urgent', risk: 0, urgency: 9 }));
  assert.deepStrictEqual(cards.list().map((c) => c.id), ['urgent', 'old-risky', 'new-calm'], 'urgency wins when sent');
  // Equal scores: newest on top (§33.1).
  const same = createCards(at());
  same.apply(cardEvent({ id: 'first', risk: 2 }));
  same.apply(cardEvent({ id: 'second', risk: 2 }));
  assert.deepStrictEqual(same.list().map((c) => c.id), ['second', 'first']);
});

test('J/K move the selection and stop at the ends; a new card never moves it', () => {
  const cards = createCards(at());
  for (const id of ['a', 'b', 'c']) cards.apply(cardEvent({ id, risk: 0 }));
  // A card arriving while the user is reading another one must not move the selection under their hands: the
  // Inbox key picks the top card when answer mode starts (§33.3 step 1), nothing else does.
  assert.strictEqual(cards.selected().id, 'a', 'the card that was selected stays selected');
  assert.strictEqual(cards.list()[0].id, 'c', 'even though the newest is on top of the stack');
  assert.strictEqual(cards.select('c').id, 'c', 'answer mode selects the top card explicitly');
  assert.strictEqual(cards.move(1).id, 'b');
  assert.strictEqual(cards.move(1).id, 'a');
  assert.strictEqual(cards.move(1).id, 'a', 'J at the bottom stays');
  assert.strictEqual(cards.move(-1).id, 'b');
  assert.strictEqual(cards.select('c').id, 'c');
  assert.strictEqual(cards.move(-1).id, 'c', 'K at the top stays');
  assert.strictEqual(cards.select('never-sent'), cards.get('c'), 'selecting a card that does not exist changes nothing');
  // Dismissing the selected card selects the next one, so the keys never point at nothing.
  cards.dismiss('c');
  assert.strictEqual(cards.selected().id, 'b');
  cards.dismiss('b');
  cards.dismiss('a');
  assert.strictEqual(cards.selected(), null);
  assert.strictEqual(cards.move(1), null, 'and J on an empty stack does nothing');
  assert.strictEqual(cards.dismiss('a'), null, 'dismissing a card that is gone does nothing');
});

test('E dismisses a card locally without answering the agent', () => {
  const cards = createCards(at());
  cards.apply(cardEvent({ id: 'c1', kind: 'done' }));
  const gone = cards.dismiss('c1');
  assert.strictEqual(gone.state, 'dismissed');
  assert.strictEqual(cards.count(), 0);
  assert.strictEqual(cards.get('c1'), null);
  assert.strictEqual(cards.release('c1'), null, 'nothing is sent for a dismissed card');
});
