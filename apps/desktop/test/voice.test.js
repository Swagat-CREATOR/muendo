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
