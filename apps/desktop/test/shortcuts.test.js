// Default shortcuts (app/shortcuts.js): none collides with Wispr Flow's Ctrl + Alt hold; a taken default falls back.
const { test } = require('node:test');
const assert = require('node:assert');
const { DEFAULTS, pickShortcut } = require('../app/shortcuts');

test('no default starts with Ctrl + Alt, and each has free alternatives', () => {
  for (const list of Object.values(DEFAULTS)) {
    assert.ok(list.length >= 2);
    for (const accel of list) assert.ok(!/^Control\+Alt\b|^Alt\+Control\b/.test(accel), accel);
  }
  assert.deepStrictEqual(DEFAULTS.undo.filter((a) => DEFAULTS.brief.includes(a)), [], 'undo and brief never share one');
});

test('a taken default falls back to the first free alternative, or none', () => {
  const taken = new Set(['Alt+Shift+Z']);
  assert.strictEqual(pickShortcut(DEFAULTS.undo, (a) => !taken.has(a)), 'Super+Shift+Z');
  assert.strictEqual(pickShortcut(DEFAULTS.undo, () => false), null);
});
