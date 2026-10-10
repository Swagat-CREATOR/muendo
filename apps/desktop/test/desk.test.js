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
