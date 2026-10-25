// The Agent Desk joined up (app/desk/desk.js): core events in, redraws and answers out. The Inbox engine and the
// Router are built in Rust but nothing routes their events to the app yet, so the whole thing is driven here by a
// fake event source — the same `inbox.card`, `inbox.release`, `agent.status` and `route.result` messages
// app/desk/core-client.js would deliver (spec §33.10 Part E and Part H, §38.5).
const { test } = require('node:test');
const assert = require('node:assert');
const { createDesk } = require('../app/desk/desk');

// A fake core: `emit(type, body)` plays a message, and `sent` records what the app sent back.
function fakeClient({ connected = true } = {}) {
  const listeners = new Map();
  return {
    sent: [],
    lanes: [],
    started: 0,
    stopped: 0,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, body) {
      for (const fn of listeners.get(type) ?? []) fn({ type, id: 'x', body });
    },
    listenerCount: (type) => (listeners.get(type)?.size ?? 0),
    send(type, body) { this.sent.push([type, body]); return connected; },
    sendLane(lane, data) { this.lanes.push([lane, String(data)]); return connected; },
    start() { this.started++; },
    stop() { this.stopped++; },
  };
}

// Fake windows: everything app/desk/windows.js does to a BrowserWindow, recorded instead.
function fakeUi() {
  return {
    sentTo: [],
    shown: [],
    hidden: [],
    laneOpened: null,
    send(name, channel, payload) { this.sentTo.push([name, channel, payload]); },
    showCards(options) { this.shown.push(['cards', options?.focus === true]); },
    hideCards() { this.hidden.push('cards'); },
    showTalk() { this.shown.push(['talk', true]); },
    hideTalk() { this.hidden.push('talk'); },
    showLanes(id) { this.laneOpened = id; },
    // The last state the cards window was told to draw.
    state() { return this.sentTo.filter(([n, c]) => n === 'cards' && c === 'cards:state').at(-1)?.[2] ?? null; },
  };
}

// A fake focus: koffi is not installed, so main.js gets one of these in practice too.
function fakeFocus({ available = true } = {}) {
  return {
    saves: 0,
    restores: 0,
    save() { this.saves++; return available ? 0x1234 : null; },
    restore() { this.restores++; return available; },
    reason: () => (available ? null : 'focus not restored: koffi is not installed.'),
    forget() {},
  };
}

function quietLog() {
  const lines = [];
  const add = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR') };
}

function makeDesk(options = {}) {
  const client = options.client ?? fakeClient();
  const ui = fakeUi();
  const focus = options.focus ?? fakeFocus();
  const log = quietLog();
  const problems = [];
  const ran = [];
  const agentCounts = [];
  const desk = createDesk({
    client, ui, focus, log,
    problem: (m) => problems.push(m),
    commands: (command, plan) => ran.push([command, plan.confirm]),
    onAgents: (a) => agentCounts.push(a.length),
    ...options.desk,
  });
  desk.start();
  return { desk, client, ui, focus, log, problems, ran, agentCounts };
}

const card = (over = {}) => ({
  id: 'c1', kind: 'permission', agent_id: 'a1', title: 'Run npm test?', body: 'in shop\nnpm test',
  options: ['Allow once', 'Always allow here', 'Deny'], risk: 2, thumb: null, grace_ms: 2000, ...over,
});
const agent = (over = {}) => ({ agent_id: 'a1', kind: 'claude-code', name: 'Claude Code', connection: 'Hooks', status: 'working', ...over });

test('a card from the core appears without taking focus, and the window draws what the core sent', () => {
  const { client, ui } = makeDesk();
  client.emit('inbox.card', card());
  // §33.3: a new card never takes focus. The user keeps typing in whatever app they were in.
  assert.deepStrictEqual(ui.shown, [['cards', false]]);
  const state = ui.state();
  assert.strictEqual(state.cards.length, 1);
  assert.strictEqual(state.cards[0].title, 'Run npm test?');
  assert.deepStrictEqual(state.cards[0].options, ['Allow once', 'Always allow here', 'Deny']);
  assert.strictEqual(state.cards[0].graceMs, 2000, 'the grace bar is sized from the card');
  assert.strictEqual(state.answerMode, false);
});

test('the Inbox key saves the foreground window, focuses the top card, and the card keys then work', () => {
  const { desk, client, ui, focus } = makeDesk();
  // With nothing to answer the key does nothing at all: no focus is taken and nothing is saved.
  assert.strictEqual(desk.openInbox(), false);
  assert.strictEqual(focus.saves, 0);
  assert.deepStrictEqual(ui.shown, []);
  client.emit('inbox.card', card({ id: 'old', risk: 0 }));
  client.emit('inbox.card', card({ id: 'new', risk: 5 }));
  assert.strictEqual(desk.openInbox(), true);
  assert.strictEqual(focus.saves, 1, 'the window the user was in is remembered first (§33.3 step 1)');
  assert.deepStrictEqual(ui.shown.at(-1), ['cards', true], 'and only now does the window take focus');
  assert.strictEqual(ui.state().answerMode, true);
  assert.strictEqual(ui.state().selectedId, 'new', 'the top card is focused');
  assert.strictEqual(desk.answerMode(), true);
});

test('1 answers the top card, the grace bar drains, and the answer then goes to the core', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('inbox.card', card());
  desk.openInbox();
  desk.handlers.key('1', 'c1');
  // Nothing is sent while the bar drains (§33.4): the answer is held in the app.
  assert.deepStrictEqual(client.sent, []);
  assert.strictEqual(ui.state().cards[0].state, 'answering');
  // The bar is a CSS animation; its animationend is what releases the answer.
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: 0, text: null, via: 'key' }]]);
  // The stack is empty, so the window goes and the keyboard goes back where it was (§33.10 Part E step 5).
  assert.deepStrictEqual(ui.hidden, ['cards']);
  assert.strictEqual(focus.restores, 1);
  assert.strictEqual(desk.answerMode(), false);
});

test('Esc during the grace takes the answer back; a second answer while one waits is ignored', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('inbox.card', card());
  desk.openInbox();
  desk.handlers.key('3', 'c1');
  desk.handlers.key('1', 'c1');
  assert.strictEqual(ui.state().cards[0].state, 'answering', 'still the first answer');
  desk.handlers.key('Escape', 'c1');
  assert.strictEqual(ui.state().cards[0].state, 'open', 'the card reopened');
  assert.deepStrictEqual(client.sent, [], 'nothing was ever sent');
  assert.deepStrictEqual(ui.hidden, [], 'and the window stays: the user is still answering');
  assert.strictEqual(focus.restores, 0);
  // Answering again works, and only then does it go.
  desk.handlers.key('1', 'c1');
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: 0, text: null, via: 'key' }]]);
});

test('Esc out of answer mode leaves the stack alone, hides the window and hands focus back', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('inbox.card', card());
  desk.openInbox();
  desk.handlers.key('Escape', 'c1');
  assert.deepStrictEqual(ui.hidden, ['cards']);
  assert.strictEqual(focus.restores, 1);
  assert.strictEqual(desk.answerMode(), false);
  assert.strictEqual(ui.state().cards.length, 1, 'the card is still waiting to be answered');
});

test('Space opens a text box on the card, and the typed answer carries how it was given', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card({ kind: 'question', options: ['a', 'b'] }));
  desk.openInbox();
  desk.handlers.key(' ', 'c1');
  assert.deepStrictEqual(ui.state().textFor, { cardId: 'c1', via: 'key', hint: 'Type your answer' });
  desk.handlers.text('c1', 'use Postgres', 'key');
  assert.strictEqual(ui.state().textFor, null, 'the box closes when the answer is given');
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: null, text: 'use Postgres', via: 'key' }]]);
});

test('V opens the same box with the Wispr Flow hint, and the answer is marked as voice', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card({ kind: 'done' }));
  desk.openInbox();
  desk.handlers.key('v', 'c1');
  assert.deepStrictEqual(ui.state().textFor, { cardId: 'c1', via: 'voice', hint: 'Hold your Wispr Flow key and speak' });
  desk.handlers.text('c1', 'thanks, now the README', 'voice');
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent.at(-1)[1].via, 'voice', 'via travels with the answer, for the Receipt (§35)');
});

test('a grace of 0 releases at once, because there is no animation to wait for', () => {
  const { desk, client } = makeDesk();
  client.emit('inbox.card', card({ grace_ms: 0 }));
  desk.openInbox();
  desk.handlers.key('1', 'c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: 0, text: null, via: 'key' }]]);
});

test('U undoes the turn with the save point the release wrote (§33.4)', () => {
  const { desk, client } = makeDesk();
  client.emit('inbox.card', card({ id: 'd1', kind: 'done' }));
  client.emit('inbox.release', { card_id: 'd1', savepoint_id: 'sp-7' });
  desk.openInbox();
  desk.handlers.key('u', 'd1');
  assert.deepStrictEqual(client.sent, [['inbox.undo', { card_id: 'd1', savepoint_id: 'sp-7' }]]);
});

test('E dismisses without answering the agent, and the window closes when the stack empties', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('inbox.card', card({ id: 'a', kind: 'done' }));
  client.emit('inbox.card', card({ id: 'b', kind: 'done' }));
  desk.openInbox();
  desk.handlers.key('e', 'a');
  assert.deepStrictEqual(client.sent, [], 'nothing is sent for a dismissed card');
  assert.deepStrictEqual(ui.hidden, [], 'one card left, so the window stays');
  desk.handlers.key('e', 'b');
  assert.deepStrictEqual(ui.hidden, ['cards']);
  assert.strictEqual(focus.restores, 1);
});

test('J and K move between cards and close any open text box', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card({ id: 'a', kind: 'question', risk: 0 }));
  client.emit('inbox.card', card({ id: 'b', kind: 'question', risk: 0 }));
  desk.openInbox();
  assert.strictEqual(ui.state().selectedId, 'b');
  desk.handlers.key(' ', 'b');
  assert.ok(ui.state().textFor);
  desk.handlers.key('j', 'b');
  assert.strictEqual(ui.state().selectedId, 'a');
  assert.strictEqual(ui.state().textFor, null, 'a half-typed answer is not carried to another card');
  desk.handlers.key('k', 'a');
  assert.strictEqual(ui.state().selectedId, 'b');
});

test('a click does exactly what the key does, so there is one set of rules', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card());
  // §33.3 step 3: clicking a card works without the Inbox key.
  desk.handlers.click('answer', 'c1', 2);
  assert.strictEqual(ui.state().cards[0].state, 'answering');
  desk.handlers.click('take-back', 'c1');
  assert.strictEqual(ui.state().cards[0].state, 'open');
  desk.handlers.click('answer', 'c1', 2);
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: 2, text: null, via: 'click' }]]);
});

test('a key for a card the core never sent, or an option it never offered, does nothing', () => {
  const { desk, client } = makeDesk();
  client.emit('inbox.card', card({ options: ['Allow once', 'Deny'] }));
  desk.openInbox();
  assert.strictEqual(desk.handlers.key('1', 'nope'), null, 'a card id the app does not have');
  assert.strictEqual(desk.handlers.key('3', 'c1'), null, 'a third option the core did not send');
  assert.strictEqual(desk.handlers.key('q', 'c1'), null, 'a key §33.2 does not define');
  assert.deepStrictEqual(client.sent, []);
});

test('an answer the core cannot be given is reported, not silently dropped', () => {
  // The answer is held in the app for the grace, so a core that goes away in those two seconds loses it. The
  // agent then waits for its hook timeout, which is the same outcome as nobody answering — and the user is told.
  const { desk, client, problems, log } = makeDesk({ client: fakeClient({ connected: false }) });
  client.emit('inbox.card', card());
  desk.openInbox();
  desk.handlers.key('1', 'c1');
  desk.handlers.graceEnd('c1');
  assert.ok(problems.some((p) => /did not reach the agent/.test(p)), JSON.stringify(problems));
  assert.ok(log.lines.some((l) => /the core is not connected/.test(l)));
});

test('the Talk key saves the foreground window and shows the one-line input', () => {
  const { desk, ui, focus } = makeDesk();
  desk.openTalk();
  assert.strictEqual(focus.saves, 1, 'Part H step 1: the same save as the Inbox key');
  assert.deepStrictEqual(ui.shown, [['talk', true]]);
});

test('Enter in the Talk box asks the core\'s Router; the app never routes by itself', () => {
  const { desk, client } = makeDesk();
  desk.openTalk();
  desk.handlers.talk('  tell Claude to also update the README  ');
  assert.deepStrictEqual(client.sent, [['route.request', { text: 'tell Claude to also update the README' }]]);
  assert.strictEqual(desk.talking().text, 'tell Claude to also update the README', 'trimmed, and kept for delivery');
});

test('an empty Talk box closes without asking the Router anything', () => {
  const { desk, client, ui, focus } = makeDesk();
  desk.openTalk();
  desk.handlers.talk('   ');
  assert.deepStrictEqual(client.sent, []);
  assert.deepStrictEqual(ui.hidden, ['talk']);
  assert.strictEqual(focus.restores, 1, 'and focus goes back to where the user was');
});

test('confidence 0.7 or more is delivered: a Claude reply window resolves the pending Stop', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('agent.status', agent());
  client.emit('inbox.card', card({ id: 'done-1', kind: 'done', agent_id: 'a1', options: [] }));
  desk.openTalk();
  desk.handlers.talk('also update the README');
  client.emit('route.result', { target: 'a1', confidence: 0.82, alternatives: [] });
  assert.deepStrictEqual(client.sent.at(-1), ['inbox.answer', {
    card_id: 'done-1', choice: null, text: 'also update the README', via: 'key',
  }]);
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
  assert.strictEqual(focus.restores, 1, 'and focus returns to the original window (Part H step 4)');
});

test('a lane target is written straight into its terminal', () => {
  const { desk, client } = makeDesk();
  // §38.5's agent.status has no lane id yet; when it gains one, this row of Part H's table starts working.
  client.emit('agent.status', agent({ lane_id: 'lane-3' }));
  assert.deepStrictEqual(desk.lanes(), [{ laneId: 'lane-3', agentId: 'a1' }]);
  desk.openTalk();
  desk.handlers.talk('npm test');
  client.emit('route.result', { target: 'lane-3', confidence: 0.9, alternatives: [] });
  assert.deepStrictEqual(client.lanes, [['lane-3', 'npm test\r']]);
});

test('below 0.7 the top two become chips, and pressing 1 or 2 delivers that one', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex', lane_id: 'lane-9' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a1', confidence: 0.5, alternatives: ['a2'] });
  const chips = ui.sentTo.filter(([, c]) => c === 'talk:chips').at(-1)[2];
  assert.deepStrictEqual(chips.chips, ['Claude Code', 'Codex'], 'the names the user knows');
  assert.strictEqual(chips.confidence, 0.5);
  assert.deepStrictEqual(client.lanes, [], 'nothing is delivered until the user chooses');
  desk.handlers.chip(2);
  assert.deepStrictEqual(client.lanes, [['lane-9', 'run the tests\r']]);
});

test('a chip the user did not get offered does nothing', () => {
  const { desk, client } = makeDesk();
  client.emit('agent.status', agent());
  desk.openTalk();
  desk.handlers.talk('hi');
  client.emit('route.result', { target: 'a1', confidence: 0.2, alternatives: [] });
  desk.handlers.chip(2);
  desk.handlers.chip(0);
  assert.deepStrictEqual(client.sent.filter(([t]) => t !== 'route.request'), []);
});

test('a Mewndo command goes to the confirmation UI of §23.3, not straight at the files', () => {
  const { desk, client, ran } = makeDesk();
  desk.openTalk();
  desk.handlers.talk('undo the last ten minutes');
  client.emit('route.result', { target: 'mewndo:undo', confidence: 0.95, alternatives: [] });
  assert.deepStrictEqual(ran, [['undo', 'Undo what any agent did in the last 10 minutes']]);
  assert.deepStrictEqual(client.lanes, [], 'nothing was written anywhere');
});

test('a target that cannot be reached says so plainly and offers nothing that would not work', () => {
  const { desk, client, problems } = makeDesk();
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /Can't reach Codex outside a lane\./);
  assert.match(problems[0], /A lane is a terminal Mewndo owns/);
});

test('a Router that answers with nothing useful says so, rather than guessing', () => {
  const { desk, client, problems, ui } = makeDesk();
  desk.openTalk();
  desk.handlers.talk('do the thing');
  client.emit('route.result', { target: null, confidence: 0, alternatives: [] });
  assert.deepStrictEqual(problems, ['Mewndo could not work out where that should go.']);
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
});

test('a route.result with no Talk box waiting is ignored', () => {
  const { client, problems } = makeDesk();
  client.emit('route.result', { target: 'a1', confidence: 0.9, alternatives: [] });
  assert.deepStrictEqual(problems, [], 'a late answer to a box the user already closed does nothing');
});

test('a Talk box with no core to ask says so instead of looking like it worked', () => {
  const { desk, problems, ui } = makeDesk({ client: fakeClient({ connected: false }) });
  desk.openTalk();
  desk.handlers.talk('tell Claude to stop');
  assert.ok(problems.some((p) => /not connected to the core/.test(p)));
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
});

test('agent.status builds the agent list the dock and the layout follow', () => {
  const { desk, client, agentCounts } = makeDesk();
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex', status: 'idle' }));
  assert.deepStrictEqual(desk.agents().map((a) => a.name), ['Claude Code', 'Codex']);
  // §33.1: two or more agents stand the pill up as the side dock, so the count is what the layout needs.
  assert.deepStrictEqual(agentCounts, [1, 2]);
  // The newest status for an agent replaces the old one, it does not add a second row.
  client.emit('agent.status', agent({ status: 'braked', last_line: 'npm test failed' }));
  assert.strictEqual(desk.agents().length, 2);
  assert.strictEqual(desk.agents()[0].status, 'braked');
  assert.strictEqual(desk.agents()[0].lastLine, 'npm test failed');
  // An agent that has gone leaves the list, so the dock stands back down.
  client.emit('agent.status', agent({ agent_id: 'a2', status: 'gone' }));
  assert.deepStrictEqual(desk.agents().map((a) => a.name), ['Claude Code']);
  assert.deepStrictEqual(agentCounts.at(-1), 1);
  // A status with no agent id is not an agent.
  client.emit('agent.status', { kind: 'codex', name: 'Codex' });
  assert.strictEqual(desk.agents().length, 1);
});

test('focus that cannot be handed back is said out loud, and nothing else changes', () => {
  // koffi is not installed, so this is what happens on a real machine today: the window hides, the card is
  // answered, and only the hand-back is missing.
  const { desk, client, ui, log } = makeDesk({ focus: fakeFocus({ available: false }) });
  client.emit('inbox.card', card());
  desk.openInbox();
  desk.handlers.key('1', 'c1');
  desk.handlers.graceEnd('c1');
  assert.deepStrictEqual(client.sent, [['inbox.answer', { card_id: 'c1', choice: 0, text: null, via: 'key' }]]);
  assert.deepStrictEqual(ui.hidden, ['cards']);
  assert.ok(log.lines.some((l) => /did not hand focus back: focus not restored: koffi is not installed/.test(l)), JSON.stringify(log.lines));
});

test('released cards: Done and Receipt stay for their Undo, the rest leave and the window closes', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card({ id: 'p', kind: 'permission' }));
  client.emit('inbox.card', card({ id: 'd', kind: 'done' }));
  desk.openInbox();
  client.emit('inbox.release', { card_id: 'p', savepoint_id: 'sp-1' });
  assert.deepStrictEqual(ui.state().cards.map((c) => c.id), ['d']);
  assert.deepStrictEqual(ui.hidden, [], 'the Done card is still there, so the window stays');
  client.emit('inbox.release', { card_id: 'd', savepoint_id: 'sp-2' });
  assert.deepStrictEqual(ui.state().cards.map((c) => c.id), ['d'], 'Done stays: its Undo is the point (§33.4)');
  assert.strictEqual(desk.cards().get('d').savepointId, 'sp-2');
});

test('the stack draws the top three and says how many are hidden', () => {
  const { client, ui } = makeDesk();
  for (let i = 0; i < 7; i++) client.emit('inbox.card', card({ id: `c${i}`, risk: 0 }));
  assert.strictEqual(ui.state().cards.length, 3);
  assert.strictEqual(ui.state().more, 4, '"+4 more" (§33.1)');
});

test('start subscribes to the four core messages and stop lets go of them', () => {
  const { desk, client } = makeDesk();
  assert.strictEqual(client.started, 1);
  for (const type of ['inbox.card', 'inbox.release', 'agent.status', 'route.result']) {
    assert.strictEqual(client.listenerCount(type), 1, type);
  }
  desk.stop();
  assert.strictEqual(client.stopped, 1);
  for (const type of ['inbox.card', 'inbox.release', 'agent.status', 'route.result']) {
    assert.strictEqual(client.listenerCount(type), 0, `${type} after stop`);
  }
  client.emit('inbox.card', card());
  assert.strictEqual(desk.cards().count(), 0, 'a stopped desk does not collect cards');
});

test('opening a lane from the lanes window is passed straight through', () => {
  const { desk, ui } = makeDesk();
  desk.handlers.lane('open', 'lane-2');
  assert.strictEqual(ui.laneOpened, 'lane-2');
  desk.handlers.lane('open', null);
  desk.handlers.lane('something-else', 'lane-2');
  assert.strictEqual(ui.laneOpened, 'lane-2', 'and nothing else is');
});

test('a card the core says has expired leaves the stack, and the window closes with it', () => {
  const { desk, client, ui } = makeDesk();
  client.emit('inbox.card', card());
  assert.strictEqual(desk.cards().count(), 1);
  client.emit('inbox.expired', { card_id: 'c1' });
  assert.strictEqual(desk.cards().count(), 0, 'nobody can use an answer to it any more');
  assert.ok(ui.hidden.includes('cards'), JSON.stringify(ui.hidden));
  client.emit('inbox.expired', { card_id: 'never-sent' }); // nothing to do, and nothing breaks
});

test("the core's inbox.undo goes to main's confirmation with the save point; one without a save point is said", () => {
  const { client, ran, problems } = makeDesk();
  client.emit('inbox.undo', { card_id: 'c1', savepoint_id: 'sp-7' });
  assert.deepStrictEqual(ran.map(([command]) => command), ['undo-to']);
  client.emit('inbox.undo', { card_id: 'c2', savepoint_id: null });
  assert.ok(problems.some((p) => /no save point/.test(p)), JSON.stringify(problems));
});

test("the core's budget.state reaches the dock as Rules only mode, on and off", () => {
  const seen = [];
  const { client } = makeDesk({ desk: { onBudget: (on) => seen.push(on) } });
  client.emit('budget.state', { rules_only: true });
  client.emit('budget.state', { rules_only: false });
  client.emit('budget.state', {});
  assert.deepStrictEqual(seen, [true, false, false]);
});

// --- agent.message, free speech, the card mic, inbox.hold, click-in and peek -------------------------------------

// A core that takes agent.message (speaks), with a clock the test fires by hand for the result deadline.
function messagingDesk({ refuses = [], dictation = false, connected = true } = {}) {
  const client = fakeClient({ connected });
  client.speaks = (type) => !refuses.includes(type);
  client.connected = () => connected;
  const timers = [];
  const desk = {
    schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    dictation: () => dictation,
  };
  const sizes = []; // sizeTalk: true while a typing offer is up
  desk.sizeTalk = (tall) => sizes.push(tall);
  const out = makeDesk({ client, desk });
  const statuses = () => out.ui.sentTo.filter(([n, ch]) => n === 'talk' && ch === 'talk:status').map(([, , p]) => p);
  return { ...out, timers, sizes, statuses, fire: () => timers.splice(0).forEach((t) => t.fn()) };
}

test('typed Talk text with no lane and no reply window goes as agent.message, and the box says "Sent"', () => {
  const { desk, client, ui, focus, statuses } = messagingDesk();
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  assert.deepStrictEqual(client.sent.at(-1), ['agent.message', { agent_id: 'a2', text: 'run the tests', via: 'key' }]);
  assert.deepStrictEqual(statuses().at(-1), { tone: 'sending', text: 'Sending to Codex…', options: [] });
  assert.strictEqual(focus.restores, 1, 'the keyboard goes back at once; the box stays to say what happened');
  assert.ok(!ui.hidden.includes('talk'));
  client.emit('agent.message.result', { agent_id: 'a2', delivered: 'now' });
  assert.deepStrictEqual(statuses().at(-1), { tone: 'sent', text: 'Sent to Codex.', options: [] });
});

test('queued says when the agent will get it; a late or repeated result is ignored', () => {
  const { desk, client, statuses, timers } = messagingDesk();
  client.emit('agent.status', agent());
  desk.openTalk();
  desk.handlers.talk('also update the README');
  client.emit('route.result', { target: 'a1', confidence: 0.9, alternatives: [] });
  assert.strictEqual(timers.length, 1, 'the deadline is armed');
  client.emit('agent.message.result', { agent_id: 'a1', delivered: 'queued' });
  assert.strictEqual(statuses().at(-1).text, 'Queued: Claude Code gets it when it finishes this step.');
  assert.strictEqual(timers.length, 0, 'and disarmed by the answer');
  const n = statuses().length;
  client.emit('agent.message.result', { agent_id: 'a1', delivered: 'now' });
  assert.strictEqual(statuses().length, n, 'nothing pending, nothing shown');
});

test('unsupported: the core\'s reason, said plainly (problem() when there is no offerLane)', () => {
  const { desk, client, ui, problems } = messagingDesk();
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  client.emit('agent.message.result', { agent_id: 'a2', delivered: 'unsupported', reason: 'Codex is not waiting and has no hook to take it' });
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
  assert.deepStrictEqual(problems, ["Can't reach Codex: Codex is not waiting and has no hook to take it. A lane is a terminal Mewndo owns, so replies always reach it."]);
});

test('unsupported with offerLane: "Open a lane" is offered for that agent', () => {
  const offered = [];
  const client = fakeClient();
  client.speaks = () => true;
  const { desk } = makeDesk({ client, desk: { offerLane: (card) => offered.push(card), schedule: () => null, cancel: () => {} } });
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  client.emit('agent.message.result', { agent_id: 'a2', delivered: 'unsupported', reason: 'no hook can take it' });
  assert.strictEqual(offered.length, 1);
  assert.strictEqual(offered[0].title, "Can't reach Codex: no hook can take it.");
  assert.deepStrictEqual(offered[0].options, ['Open a lane', 'Not now']);
});

test('a core that never answers agent.message: the deadline says so, never "sent"', () => {
  const { desk, client, statuses, fire } = messagingDesk();
  client.emit('agent.status', agent());
  desk.openTalk();
  desk.handlers.talk('hi');
  client.emit('route.result', { target: 'a1', confidence: 0.9, alternatives: [] });
  fire();
  assert.strictEqual(statuses().at(-1).tone, 'failed');
  assert.match(statuses().at(-1).text, /can't say whether Claude Code got that/);
});

test('an older core that refuses agent.message falls back to today\'s "can\'t reach"', () => {
  const { desk, client, problems, ui, timers } = messagingDesk();
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  client.emit('error', { message: 'unknown message type agent.message for a App connection' });
  assert.match(problems.at(-1), /Can't reach Codex outside a lane\./);
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
  assert.strictEqual(timers.length, 0);
  // Some other error is none of this code's business.
  client.emit('error', { message: 'unknown message type lane.open for a App connection' });
  assert.strictEqual(problems.length, 1);
});

// Claude Code idle at its prompt: the core answers agent.message with a typing offer.
function offered() {
  const m = messagingDesk();
  m.client.emit('agent.status', agent({ status: 'idle' }));
  m.desk.openTalk();
  m.desk.handlers.talk('use UTC\neverywhere');
  m.client.emit('route.result', { target: 'a1', confidence: 0.9, alternatives: [] });
  m.client.emit('agent.message.result', { agent_id: 'a1', delivered: 'confirm', offer_id: 'o1', preview: 'use UTC everywhere',
    reason: 'Claude Code is idle at its prompt. Type this into its terminal?' });
  m.confirms = () => m.ui.sentTo.filter(([n, ch]) => n === 'talk' && ch === 'talk:confirm').map(([, , p]) => p);
  return m;
}

test('an idle agent: the Talk box shows the reason and the exact text, and nothing is typed before "Type it"', () => {
  const { desk, client, ui, focus, sizes, confirms } = offered();
  assert.deepStrictEqual(confirms(), [{ text: 'Claude Code is idle at its prompt. Type this into its terminal?',
    preview: 'use UTC everywhere', options: ['Type it', 'Cancel'] }]);
  assert.strictEqual(client.sent.filter(([t]) => t === 'agent.type').length, 0, 'nothing typed yet');
  assert.deepStrictEqual(ui.shown.at(-1), ['talk', true], 'the box takes the keyboard so 1 and 2 work');
  assert.strictEqual(focus.saves, 2, 'and remembers the window the user was in first');
  assert.deepStrictEqual(sizes, [true], 'with room for the whole text');
  assert.deepStrictEqual(desk.offer(), { offerId: 'o1', agentId: 'a1', name: 'Claude Code' });
});

test('"Type it" (1) sends only the offer id, and the box says what the core did', () => {
  const { desk, client, focus, sizes, statuses, timers } = offered();
  const restored = focus.restores;
  desk.handlers.chip(1);
  assert.deepStrictEqual(client.sent.at(-1), ['agent.type', { offer_id: 'o1' }], 'no text: the core types what it showed');
  assert.deepStrictEqual(statuses().at(-1), { tone: 'sending', text: "Typing into Claude Code's terminal…", options: [] });
  assert.strictEqual(focus.restores, restored + 1, 'the keyboard goes back at once');
  assert.deepStrictEqual(sizes, [true, false]);
  assert.strictEqual(timers.length, 1, 'silence from the core is reported, never "typed"');
  client.emit('agent.message.result', { agent_id: 'a1', delivered: 'typed', offer_id: 'o1', reason: "Typed into Claude Code's terminal." });
  assert.deepStrictEqual(statuses().at(-1), { tone: 'sent', text: "Typed into Claude Code's terminal.", options: [] });
  assert.strictEqual(timers.length, 0);
  // Used: a second 1 types nothing.
  desk.handlers.chip(1);
  assert.strictEqual(client.sent.filter(([t]) => t === 'agent.type').length, 1);
});

test('Cancel (2), Esc or new words: nothing is typed, and a later 1 does nothing', () => {
  const { desk, client, ui, sizes } = offered();
  desk.handlers.chip(2);
  assert.strictEqual(desk.offer(), null);
  assert.deepStrictEqual(ui.hidden.at(-1), 'talk');
  assert.deepStrictEqual(sizes, [true, false]);
  desk.handlers.chip(1);
  assert.strictEqual(client.sent.filter(([t]) => t === 'agent.type').length, 0);

  const esc = offered();
  esc.desk.handlers.closeTalk();
  esc.desk.handlers.chip(1);
  assert.strictEqual(esc.client.sent.filter(([t]) => t === 'agent.type').length, 0);

  const replaced = offered();
  replaced.desk.say('something else');
  assert.strictEqual(replaced.desk.offer(), null);
  assert.strictEqual(replaced.client.sent.filter(([t]) => t === 'agent.type').length, 0);
});

test('typing that the core could not do: its reason, and the lane offer; an expired offer is matched by its id', () => {
  const { desk, client, problems } = offered();
  desk.handlers.chip(1);
  // The core no longer knows the offer, so it can't name the agent; it echoes the offer id instead.
  client.emit('agent.message.result', { agent_id: '', delivered: 'unsupported', offer_id: 'o1',
    reason: 'That offer was already used or replaced, so nothing was typed.' });
  assert.deepStrictEqual(problems, ["Can't reach Claude Code: That offer was already used or replaced, so nothing was typed. A lane is a terminal Mewndo owns, so replies always reach it."]);
  // An agent that started working again before the user confirmed gets it when it stops: the core says queued.
  const moved = offered();
  moved.desk.handlers.chip(1);
  moved.client.emit('agent.message.result', { agent_id: 'a1', delivered: 'queued', offer_id: 'o1' });
  assert.strictEqual(moved.statuses().at(-1).text, 'Queued: Claude Code gets it when it finishes this step.');
});

test('a confirm the app cannot act on is never shown as an offer', () => {
  const { desk, client, ui, statuses } = messagingDesk();
  client.emit('agent.status', agent({ status: 'idle' }));
  desk.openTalk();
  desk.handlers.talk('hi');
  client.emit('route.result', { target: 'a1', confidence: 0.9, alternatives: [] });
  client.emit('agent.message.result', { agent_id: 'a1', delivered: 'confirm', preview: 'hi' });
  assert.strictEqual(ui.sentTo.filter(([, ch]) => ch === 'talk:confirm').length, 0);
  assert.strictEqual(statuses().at(-1).tone, 'failed');
  assert.strictEqual(desk.offer(), null);
});

test('words said to the dock: one agent gets them directly, shown in the Talk box without taking focus', () => {
  const { desk, client, ui, focus, statuses } = messagingDesk();
  client.emit('agent.status', agent());
  assert.strictEqual(desk.say('make the button blue'), true);
  assert.deepStrictEqual(ui.shown.at(-1), ['talk', true], 'the fake records showTalk; the option says no focus');
  assert.strictEqual(focus.saves, 0, 'the user\'s app keeps the keyboard');
  assert.deepStrictEqual(ui.sentTo.find(([, ch]) => ch === 'talk:dictated')[2], { text: 'make the button blue' });
  assert.ok(!client.sent.some(([t]) => t === 'route.request'), 'one agent: no Router needed');
  assert.deepStrictEqual(client.sent.at(-1), ['agent.message', { agent_id: 'a1', text: 'make the button blue', via: 'voice' }]);
  client.emit('agent.message.result', { agent_id: 'a1', delivered: 'now' });
  assert.strictEqual(statuses().at(-1).text, 'Sent to Claude Code.');
});

test('words said with two agents go to the Router; unsure means chips, and a chip delivers', () => {
  const { desk, client, ui } = messagingDesk();
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex', lane_id: 'lane-9' }));
  desk.say('run the tests');
  assert.deepStrictEqual(client.sent.at(-1), ['route.request', { text: 'run the tests' }]);
  client.emit('route.result', { target: 'a1', confidence: 0.4, alternatives: ['a2'] });
  assert.deepStrictEqual(ui.sentTo.filter(([, ch]) => ch === 'talk:chips').at(-1)[2].chips, ['Claude Code', 'Codex']);
  desk.handlers.chip(2);
  assert.deepStrictEqual(client.lanes, [['lane-9', 'run the tests\r']]);
  assert.deepStrictEqual(ui.sentTo.filter(([, ch]) => ch === 'talk:status').at(-1)[2], { tone: 'sent', text: 'Sent to Codex.', options: [] });
});

test('words said with no core to route them are not sent anywhere, so main.js asks "did you mean"', () => {
  const { desk, client } = messagingDesk({ connected: false });
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  assert.strictEqual(desk.say('run the tests'), false);
  assert.strictEqual(desk.say('   '), false);
  assert.deepStrictEqual(client.sent, []);
});

test('the card mic: V listens, V again stops, the words land in the reply box and wait for Enter', () => {
  const { desk, client, ui } = messagingDesk({ dictation: true });
  client.emit('inbox.card', card({ id: 'd1', kind: 'done', options: [] }));
  desk.openInbox();
  assert.strictEqual(ui.state().mic, true);
  desk.handlers.key('v', 'd1');
  assert.deepStrictEqual(ui.state().textFor, { cardId: 'd1', via: 'voice', hint: 'Listening… press V or the mic to stop', mic: 'listening' });
  assert.deepStrictEqual(client.sent, [['inbox.hold', { card_id: 'd1' }]], 'the Stop hook is asked to keep waiting');
  desk.handlers.key('v', 'd1');
  assert.strictEqual(ui.state().textFor.mic, 'working');
  desk.handlers.dictated('d1', ' also update the README ');
  assert.deepStrictEqual(ui.state().textFor, { cardId: 'd1', via: 'voice', mic: null, draft: 'also update the README', hint: 'Check it, then Enter to send' });
  assert.deepStrictEqual(client.sent.map(([t]) => t), ['inbox.hold'], 'speaking alone sends nothing to the agent');
  desk.handlers.text('d1', 'also update the README', 'voice');
  desk.handlers.graceEnd('d1');
  assert.deepStrictEqual(client.sent.at(-1), ['inbox.answer', { card_id: 'd1', choice: null, text: 'also update the README', via: 'voice' }]);
});

test('the card mic hearing nothing says so; a dictation for a box that closed is dropped', () => {
  const { desk, client, ui } = messagingDesk({ dictation: true });
  client.emit('inbox.card', card({ id: 'q1', kind: 'question', options: ['a'] }));
  desk.openInbox();
  desk.handlers.key('v', 'q1');
  desk.handlers.key('v', 'q1');
  desk.handlers.dictated('q1', '');
  assert.match(ui.state().textFor.hint, /didn't catch that/);
  assert.ok(!client.sent.some(([t]) => t === 'inbox.hold'), 'hold is for Done cards, whose Stop hook waits');
  desk.handlers.key('Escape', 'q1');
  assert.strictEqual(desk.handlers.dictated('q1', 'late words'), null);
});

test('inbox.hold: on focus of a Done card\'s reply box, at most once every few seconds, never to a core that refused it', () => {
  const { desk, client } = messagingDesk();
  client.emit('inbox.card', card({ id: 'd1', kind: 'done', options: [] }));
  assert.strictEqual(desk.handlers.hold('d1'), true);
  assert.strictEqual(desk.handlers.hold('d1'), false, 'not again straight away');
  assert.strictEqual(desk.handlers.hold('nope'), false);
  assert.deepStrictEqual(client.sent, [['inbox.hold', { card_id: 'd1' }]]);
  const old = messagingDesk({ refuses: ['inbox.hold'] });
  old.client.emit('inbox.card', card({ id: 'd1', kind: 'done', options: [] }));
  assert.strictEqual(old.desk.handlers.hold('d1'), false);
  assert.deepStrictEqual(old.client.sent, []);
});

test('a card that appears takes no focus; clicking into it enters answer mode, and answering hands focus back', () => {
  const { desk, client, ui, focus } = makeDesk();
  client.emit('inbox.card', card({ id: 'd1', kind: 'done', options: ['Looks good, ship it', 'Show me the screens'] }));
  assert.deepStrictEqual(ui.shown, [['cards', false]]);
  assert.strictEqual(focus.saves, 0);
  desk.handlers.click('select', 'd1');
  assert.strictEqual(focus.saves, 1, 'the app the user was in is saved first');
  assert.deepStrictEqual(ui.shown.at(-1), ['cards', true]);
  assert.strictEqual(desk.answerMode(), true);
  desk.handlers.click('select', 'd1');
  assert.strictEqual(focus.saves, 1, 'a second click saves nothing new');
  desk.handlers.key('2', 'd1'); // a next step
  desk.handlers.graceEnd('d1');
  assert.deepStrictEqual(client.sent.at(-1), ['inbox.answer', { card_id: 'd1', choice: 1, text: null, via: 'key' }]);
  assert.strictEqual(focus.restores, 1);
});

test('peek (hovering "Claude needs you") shows the stack without focus, and only when there is something', () => {
  const { desk, client, ui, focus } = makeDesk();
  assert.strictEqual(desk.peek(), false);
  client.emit('inbox.card', card());
  ui.shown.length = 0;
  assert.strictEqual(desk.peek(), true);
  assert.deepStrictEqual(ui.shown, [['cards', false]]);
  assert.strictEqual(focus.saves, 0);
});

test('the Talk box opened from an agent\'s row goes straight to that agent, without asking the Router', () => {
  const { desk, client } = makeDesk();
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex', lane_id: 'lane-9' }));
  desk.openTalk('Codex');
  assert.strictEqual(desk.talking().to, 'Codex');
  desk.handlers.talk('run the tests');
  assert.ok(!client.sent.some(([type]) => type === 'route.request'), 'no Router: the row already said which agent');
  assert.deepStrictEqual(client.lanes, [['lane-9', 'run the tests\r']]);
});

test('words said to the dock\'s mic while the Talk box is aimed at an agent go to that agent', () => {
  const { desk, client } = makeDesk();
  client.emit('agent.status', agent());
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex', lane_id: 'lane-9' }));
  desk.openTalk('Codex');
  assert.strictEqual(desk.say('add a loading spinner'), true);
  assert.ok(!client.sent.some(([type]) => type === 'route.request'));
  assert.deepStrictEqual(client.lanes, [['lane-9', 'add a loading spinner\r']]);
});

test('the dock\'s Inbox clicked with nothing to answer shows "All clear" without taking focus', () => {
  const { desk, client, ui, focus } = makeDesk();
  assert.strictEqual(desk.showEmptyInbox(), true);
  assert.deepStrictEqual(ui.shown.at(-1), ['cards', false], 'shown beside the dock, focus stays with the user');
  assert.strictEqual(focus.saves, 0);
  assert.strictEqual(ui.state().empty, true);
  desk.handlers.click('close-empty');
  assert.strictEqual(ui.state().empty, false);
  assert.deepStrictEqual(ui.hidden.at(-1), 'cards');
  // With a card waiting, the empty view is never shown: the card is.
  client.emit('inbox.card', card());
  assert.strictEqual(desk.showEmptyInbox(), false);
});

test('a reply on a Codex Done card goes as agent.message: no hook waits behind that card', () => {
  const { desk, client } = messagingDesk();
  client.emit('agent.status', agent({ agent_id: 'a2', kind: 'codex', name: 'Codex' }));
  client.emit('inbox.card', card({ id: 'd2', kind: 'done', agent_id: 'a2', options: [], grace_ms: 0 }));
  desk.openInbox();
  desk.handlers.text('d2', 'also run the linter', 'key');
  assert.deepStrictEqual(client.sent.at(-1), ['agent.message', { agent_id: 'a2', text: 'also run the linter', via: 'key' }]);
  assert.ok(!client.sent.some(([t]) => t === 'inbox.answer'), 'never an inbox answer nothing is waiting for');
});

test('a held Done card that is dismissed lets the agent go: inbox.hold with held false', () => {
  const { desk, client } = messagingDesk();
  client.emit('inbox.card', card({ id: 'd1', kind: 'done', options: [] }));
  desk.openInbox();
  desk.handlers.hold('d1');
  assert.deepStrictEqual(client.sent.at(-1), ['inbox.hold', { card_id: 'd1' }]);
  desk.handlers.click('dismiss', 'd1');
  assert.deepStrictEqual(client.sent.at(-1), ['inbox.hold', { card_id: 'd1', held: false }]);
});
