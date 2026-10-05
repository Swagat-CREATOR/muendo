const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildBrief, briefLabel, DEFAULT_SAFETY_RULES, createJournal, createStore } = require('../engine');
const { tempDir } = require('./helpers');

test('the brief is the task, a blank line, then the safety rules for that folder', () => {
  const folder = 'C:\\Users\\Smruti\\Downloads\\ANUMATI_SIH';
  assert.strictEqual(buildBrief('  Tidy up the images folder.\n', folder), `Tidy up the images folder.

Safety rules from Mewndo:
- Only work inside this folder: C:\\Users\\Smruti\\Downloads\\ANUMATI_SIH
- Don't permanently delete anything. Move files you would delete into a folder named review inside C:\\Users\\Smruti\\Downloads\\ANUMATI_SIH.
- Don't follow symbolic links or junctions, and don't touch anything outside the folder.
- Ask me before any action that affects more than 20 files.
- When you're done, list every file you created, changed, moved or deleted.`);
});

test('edited rules are used, {folder} is filled in literally, and empty rules fall back to the defaults', () => {
  const folder = '/home/a/$HOME/my $& project';
  assert.strictEqual(buildBrief('Task', folder, 'Stay in {folder}. Really: {folder}'),
    'Task\n\nSafety rules from Mewndo:\nStay in /home/a/$HOME/my $& project. Really: /home/a/$HOME/my $& project');
  assert.strictEqual(buildBrief('Task', '/p', '   '), buildBrief('Task', '/p', DEFAULT_SAFETY_RULES));
});

test('the label is the first 60 characters of the task, on one line', () => {
  assert.strictEqual(briefLabel('Refactor\n\n  the  login page'), 'Refactor the login page');
  assert.strictEqual(briefLabel('x'.repeat(100)).length, 60);
});

test('a brief save point can be made', async () => {
  const base = tempDir();
  const root = path.join(base, 'p');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  const j = createJournal({ root, dataDir: path.join(base, 'data'), store: createStore(path.join(base, 'data', 'store')) });
  await j.start();
  try {
    const sp = await j.createSavePoint({ trigger: 'brief', label: briefLabel('Tidy up the images folder') });
    assert.deepStrictEqual([sp.trigger, sp.label], ['brief', 'Tidy up the images folder']);
  } finally { await j.stop(); }
});
