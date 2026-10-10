// The Talk box's routing (app/desk/routing.js): the 0.7 confidence threshold and the delivery table of
// §33.10 Part H step 3. The core's Router decides where the text goes (§34.5); this file only works out how to
// get it there, and what to show when the Router is not sure.
const { test } = require('node:test');
const assert = require('node:assert');
const { THRESHOLD, decide, deliver, chipLabels, commandOf, COMMANDS } = require('../app/desk/routing');

// `route.result` as mewndo-proto sends it (core/crates/mewndo-proto/src/lib.rs:280).
const result = (target, confidence, alternatives = []) => ({ target, confidence, alternatives });

const CLAUDE = { agentId: 'a1', kind: 'claude-code', name: 'Claude Code', connection: 'Hooks', status: 'Working' };
const CODEX = { agentId: 'a2', kind: 'codex', name: 'Codex', connection: 'Hooks', status: 'Idle' };
const CURSOR = { agentId: 'a3', kind: 'cursor', name: 'Cursor', connection: 'Hooks', status: 'Working' };
const doneCard = (agentId, state = 'open') => ({ id: `card-${agentId}`, kind: 'done', state, agentId });

test('deliver at 0.7 or above, chips below it: Mewndo never guesses silently', () => {
  assert.strictEqual(THRESHOLD, 0.7);
  // At the threshold exactly: delivered. §33.10 Part H step 2 says "0.7 or higher".
  assert.deepStrictEqual(decide(result('a1', 0.7, ['a2'])), { deliver: 'a1', confidence: 0.7 });
  assert.deepStrictEqual(decide(result('a1', 0.95)), { deliver: 'a1', confidence: 0.95 });
  // Just below: the top two become chips 1 and 2, with the Router's own first choice first.
  assert.deepStrictEqual(decide(result('a1', 0.69, ['a2', 'a3'])), { chips: ['a1', 'a2'], confidence: 0.69 });
  assert.deepStrictEqual(decide(result('a1', 0.1, [])), { chips: ['a1'], confidence: 0.1 }, 'one chip when there is only one');
  // A Router that answers with no target at all offers its alternatives, not a guess.
  assert.deepStrictEqual(decide(result(null, 0.9, ['a1', 'a2', 'a3'])), { chips: ['a1', 'a2'], confidence: 0.9 });
  assert.deepStrictEqual(decide(undefined), { chips: [], confidence: 0 }, 'no answer at all is no chips, not a delivery');
  // A missing or unreadable confidence counts as no confidence, never as certainty.
  assert.deepStrictEqual(decide({ target: 'a1' }), { chips: ['a1'], confidence: 0 });
  assert.deepStrictEqual(decide({ target: 'a1', confidence: 'high' }), { chips: ['a1'], confidence: NaN });
  assert.deepStrictEqual(decide({ target: 'a1', confidence: 0.8, alternatives: 'a2' }), { deliver: 'a1', confidence: 0.8 });
  // The threshold is a parameter, so a user setting can raise it without changing this logic.
  assert.deepStrictEqual(decide(result('a1', 0.8), { threshold: 0.9 }), { chips: ['a1'], confidence: 0.8 });
});

test('Part H table, row 1: a lane means the text is written into its terminal', () => {
  const lanes = [{ laneId: 'lane-1', agentId: 'a1' }];
  // Targeted by lane id.
  const byId = deliver('lane-1', { agents: [CLAUDE], lanes, text: 'also update the README' });
  assert.deepStrictEqual(byId, { how: 'lane', lane: 'lane-1', bytes: 'also update the README\r', agent: null });
  // Targeted by the agent that owns the lane: still the lane, because a lane always reaches it (§33.6).
  const byAgent = deliver('Claude Code', { agents: [CLAUDE], lanes, text: 'hi' });
  assert.deepStrictEqual(byAgent, { how: 'lane', lane: 'lane-1', bytes: 'hi\r', agent: 'Claude Code' });
  // "Replies are written as text followed by \r" (§33.10 Part G step 2).
  assert.ok(byAgent.bytes.endsWith('\r'));
  // A lane belonging to another agent is not used for this one.
  assert.strictEqual(deliver('Codex', { agents: [CLAUDE, CODEX], lanes, text: 'hi' }).how, 'unreachable');
});

test('Part H table, row 2: Claude with a Stop reply window still open resolves that wait', () => {
  const out = deliver('Claude Code', { agents: [CLAUDE], cards: [doneCard('a1')], text: 'also update the README', via: 'voice' });
  assert.strictEqual(out.how, 'reply');
  assert.strictEqual(out.agent, 'Claude Code');
  assert.strictEqual(out.cardId, 'card-a1');
  // It goes back as an ordinary inbox answer, so the core resolves the hook's pending wait with it.
  assert.deepStrictEqual(out.answer, { card_id: 'card-a1', choice: null, text: 'also update the README', via: 'voice' });
  // A Done card that has already been answered is not a reply window any more.
  assert.strictEqual(deliver('Claude Code', { agents: [CLAUDE], cards: [doneCard('a1', 'sent')], text: 'hi' }).how, 'unreachable');
  assert.strictEqual(deliver('Claude Code', { agents: [CLAUDE], cards: [doneCard('a1', 'released')], text: 'hi' }).how, 'unreachable');
  // Nor is a card of another kind, or one belonging to another agent.
  const question = { id: 'q', kind: 'question', state: 'open', agentId: 'a1' };
  assert.strictEqual(deliver('Claude Code', { agents: [CLAUDE], cards: [question], text: 'hi' }).how, 'unreachable');
  assert.strictEqual(deliver('Claude Code', { agents: [CLAUDE, CODEX], cards: [doneCard('a2')], text: 'hi' }).how, 'unreachable');
});

test('Part H table, row 3: Cursor with a stop still pending takes a followup_message', () => {
  const out = deliver('Cursor', { agents: [CURSOR], cards: [doneCard('a3')], text: 'now run the tests' });
  // Cursor's stop hook returns {"followup_message": "<reply>"}; Claude's returns a block with a reason. The core
  // writes both, so the only thing the app decides is which name to put on it (§33.6).
  assert.strictEqual(out.how, 'followup');
  assert.strictEqual(out.cardId, 'card-a3');
  assert.deepStrictEqual(out.answer, { card_id: 'card-a3', choice: null, text: 'now run the tests', via: 'key' });
});

test('Part H table, row 4: anything else is a card that says so and offers the one thing that would work', () => {
  const out = deliver('Codex', { agents: [CODEX], text: 'run the tests' });
  assert.strictEqual(out.how, 'unreachable');
  assert.strictEqual(out.agent, 'Codex');
  assert.match(out.card.title, /Can't reach Codex outside a lane\./);
  assert.deepStrictEqual(out.card.options, ['Open a lane', 'Not now'], 'the offer of §33.10 Part H');
  assert.strictEqual(out.card.agentId, 'a2');
  assert.match(out.card.body, /run the tests/, 'the message the user typed is not thrown away');
  // A target naming no agent Mewndo knows is still reported honestly, using whatever the Router called it.
  const unknown = deliver('Manus', { agents: [CODEX], text: 'hi' });
  assert.strictEqual(unknown.agent, 'Manus');
  assert.strictEqual(unknown.card.agentId, null);
  // No target at all: the card still says something sensible rather than "undefined".
  assert.match(deliver(null, { text: 'hi' }).card.title, /Can't reach that agent/);
});

test('an agent is matched by its id, its name or its kind, however the Router names it', () => {
  const lanes = [{ laneId: 'lane-9', agentId: 'a1' }];
  for (const target of ['a1', 'Claude Code', 'claude code', 'CLAUDE-CODE'.toLowerCase(), 'claude-code']) {
    const out = deliver(target, { agents: [CLAUDE], lanes, text: 'hi' });
    assert.strictEqual(out.how, 'lane', target);
  }
  // Two agents of the same kind: the id is the only thing that tells them apart, and it is matched first.
  const second = { ...CLAUDE, agentId: 'a9', name: 'Claude Code (shop)' };
  const out = deliver('a9', { agents: [CLAUDE, second], cards: [doneCard('a9')], text: 'hi' });
  assert.strictEqual(out.agent, 'Claude Code (shop)');
});

test('Mewndo\'s own commands go through the v0 intent and its confirmation UI (§23.3)', () => {
  assert.deepStrictEqual(COMMANDS, ['undo', 'brake', 'stop', 'freeze', 'resume']);
  // The Router can name Mewndo itself in any of these shapes.
  assert.strictEqual(commandOf('mewndo:undo'), 'undo');
  assert.strictEqual(commandOf('mewndo.brake'), 'stop', 'brake and stop are the same thing to the v0 intent');
  assert.strictEqual(commandOf('command:resume'), 'resume');
  assert.strictEqual(commandOf('COMMAND.FREEZE'), 'freeze');
  // An agent is never mistaken for a command, and a command Mewndo does not have is not invented.
  for (const target of ['a1', 'Claude Code', 'mewndo:delete-everything', 'mewndo', 'undo', null, undefined]) {
    assert.strictEqual(commandOf(target), null, String(target));
  }
});

test('undo and freeze always show what they will do before running (§23.3)', () => {
  const agents = [CLAUDE, CODEX];
  const undo = deliver('mewndo:undo', { agents, text: 'undo the last ten minutes' });
  assert.strictEqual(undo.how, 'command');
  assert.strictEqual(undo.command, 'undo');
  assert.strictEqual(undo.intent.intent, 'undo');
  assert.strictEqual(undo.intent.minutes, 10, 'the slots come from the words the user said');
  assert.strictEqual(undo.confirm, 'Undo what any agent did in the last 10 minutes');
  const named = deliver('command:undo', { agents, text: 'undo what Claude did in the last 30 minutes' });
  assert.strictEqual(named.intent.agent, 'Claude Code');
  assert.strictEqual(named.confirm, 'Undo what Claude Code did in the last 30 minutes');
  const stop = deliver('mewndo:brake', { agents, text: 'stop Codex' });
  assert.deepStrictEqual([stop.command, stop.intent.agent, stop.confirm], ['stop', 'Codex', 'Stop Codex']);
  assert.strictEqual(deliver('mewndo:freeze', { agents, text: 'freeze everything' }).confirm, 'Freeze every agent');
});

test('a command whose words carry no slots asks for the missing piece instead of inventing it', () => {
  // "undo" on its own gives the v0 parser nothing to fill minutes with, and "stop" names no agent. The
  // confirmation must still read as English, because the user is about to press Confirm on it, and it must not
  // pretend to know a number the user never said.
  const bare = deliver('mewndo:undo', { agents: [CLAUDE], text: 'undo' });
  assert.strictEqual(bare.command, 'undo');
  assert.strictEqual(bare.confirm, 'Undo how far back? Say how many minutes.');
  assert.strictEqual(bare.intent.intent, 'unclear', 'the v0 parser said it could not tell, and that is kept');
  assert.strictEqual(deliver('mewndo:stop', { agents: [CLAUDE], text: 'stop' }).confirm, 'Stop which agent?');
  assert.strictEqual(deliver('command:resume', { agents: [CLAUDE], text: 'go on' }).confirm, 'Resume');
  assert.strictEqual(deliver('mewndo:freeze', { agents: [CLAUDE], text: 'freeze' }).confirm, 'Freeze every agent');
  for (const command of ['undo', 'stop', 'freeze', 'resume']) {
    const out = deliver(`mewndo:${command}`, { agents: [], text: '' });
    assert.doesNotMatch(out.confirm, /undefined|NaN|null/, `${command}: ${out.confirm}`);
  }
});

test('chip labels are the names the user knows, not the Router\'s ids', () => {
  assert.deepStrictEqual(chipLabels(['a1', 'a2'], { agents: [CLAUDE, CODEX] }), ['Claude Code', 'Codex']);
  assert.deepStrictEqual(chipLabels(['mewndo:undo'], { agents: [] }), ['Mewndo: undo']);
  assert.deepStrictEqual(chipLabels(['a9'], { agents: [CLAUDE] }), ['a9'], 'an unknown id is shown as it came');
  assert.deepStrictEqual(chipLabels([]), []);
});

test('a low-confidence answer becomes exactly the chips the user presses 1 and 2 for', () => {
  // The whole path: route.result below the threshold, then the chip the user chose is delivered.
  const agents = [CLAUDE, CODEX];
  const lanes = [{ laneId: 'lane-1', agentId: 'a2' }];
  const chosen = decide(result('a1', 0.4, ['a2', 'a3']));
  assert.deepStrictEqual(chipLabels(chosen.chips, { agents }), ['Claude Code', 'Codex']);
  const out = deliver(chosen.chips[1], { agents, lanes, text: 'run the tests' });
  assert.deepStrictEqual(out, { how: 'lane', lane: 'lane-1', bytes: 'run the tests\r', agent: 'Codex' });
});

test('deliver with nothing at all does not throw', () => {
  const out = deliver('a1');
  assert.strictEqual(out.how, 'unreachable');
  assert.match(out.card.body, /""/, 'an empty message is shown as empty, not as undefined');
});
