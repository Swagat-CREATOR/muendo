// Voice commands (engine/voice.js): what the user said, as an intent. Unclear never acts.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseIntent, describe } = require('../engine/voice');

const agents = ['Claude Code', 'Codex', 'Cursor'];
const p = (s) => parseIntent(s, { agents });

test('each intent, with its slots', () => {
  assert.deepStrictEqual(p('Brief: refactor the auth module, don\'t touch tests').task, 'refactor the auth module, don\'t touch tests');
  assert.deepStrictEqual([p('Stop Claude.').intent, p('Stop Claude.').agent], ['stop', 'Claude Code']);
  assert.strictEqual(p('Freeze everything').intent, 'freeze');
  assert.strictEqual(p('stop all agents').intent, 'freeze');
  const u = p('Undo what Codex did in the last ten minutes');
  assert.deepStrictEqual([u.intent, u.agent, u.minutes], ['undo', 'Codex', 10]);
  assert.strictEqual(p('undo the last 2 hours').minutes, 120);
  assert.strictEqual(p('undo the last 2 hours').agent, null);
  assert.deepStrictEqual([p('Resume.').intent, p('resume cursor').agent], ['resume', 'Cursor']);
  assert.strictEqual(p('What changed today?').intent, 'changes');
  assert.strictEqual(p('Stop codecs').agent, 'Codex', 'what dictation hears for "Codex"');
});

test('unclear asks "did you mean" instead of acting', () => {
  const noAgent = p('stop it');
  assert.strictEqual(noAgent.intent, 'unclear');
  assert.deepStrictEqual(noAgent.suggestions.map(describe), ['Stop Claude Code', 'Stop Codex', 'Stop Cursor']);
  const noTime = p('undo what codex did');
  assert.strictEqual(noTime.intent, 'unclear');
  assert.deepStrictEqual(noTime.suggestions.map(describe), ['Undo what Codex did in the last 10 minutes', 'Undo what Codex did in the last 30 minutes']);
  assert.strictEqual(p('banana pancakes').intent, 'unclear');
  assert.strictEqual(p('').intent, 'unclear');
  assert.strictEqual(p('stop code').intent, 'unclear', '"code" alone names no agent');
});

// The dock's mic hears commands and free speech (engine/voice.js classify): a command has to lead what was said,
// anything else is a message for an agent.
const { classify } = require('../engine/voice');
const c = (s) => classify(s, { agents });

test('free speech is a message; a command that leads what was said is still a command', () => {
  for (const said of ['Stop Claude.', 'Claude, stop', 'Freeze everything', 'stop all agents', 'please undo the last 10 minutes',
    'Undo what Codex did in the last ten minutes', 'What changed today?', 'Resume.', 'resume cursor', 'hey mewndo stop codex', 'Brief: fix the login page']) {
    assert.strictEqual(c(said).kind, 'command', said);
  }
  const msg = c('Claude stop editing the README and run the tests');
  assert.deepStrictEqual([msg.kind, msg.agent, msg.text], ['message', 'Claude Code', 'Claude stop editing the README and run the tests'],
    'a long sentence that only contains "stop" is for Claude, and must never brake it');
  assert.strictEqual(c("Claude, don't stop until the tests pass").kind, 'message');
  assert.strictEqual(c('continue with the tests and then deploy').kind, 'message', 'continue as a word in a sentence is not resume');
  assert.deepStrictEqual([c('make the button blue').kind, c('make the button blue').agent], ['message', null]);
  assert.strictEqual(c('tell cloud to fix the login page').agent, 'Claude Code', 'what dictation hears for "Claude"');
});

test('a short command missing a piece still asks "did you mean"; nothing heard is empty', () => {
  assert.strictEqual(c('stop it').kind, 'ask');
  assert.strictEqual(c('undo what codex did').kind, 'ask');
  assert.strictEqual(c('stop it').intent.suggestions.length, 3);
  assert.strictEqual(c('').kind, 'empty');
  assert.strictEqual(c('   ').kind, 'empty');
  // A message still carries what the command parser made of it, so a fallback can offer it without acting on it.
  assert.strictEqual(c('Claude stop editing the README and run the tests').intent.intent, 'stop');
});
