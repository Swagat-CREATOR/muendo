// The main window's warning rows (app/renderer/alerts-model.js): what each warning says and which buttons it has,
// and how its main-process side clears them (app/main.js, checked as text: Electron isn't started here).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../app/renderer/alerts-model');

const missing = {
  code: 'folder-unavailable', folder: 'C:\\Users\\Ann\\task3',
  message: "task3 can't be found at C:\\Users\\Ann\\task3. If its drive is unplugged, Mewndo resumes protecting it as soon as it's back. Its save points are kept.",
};
const lowDisk = { code: 'low-disk', folder: null, message: 'Only 1.8 GB free on the disk Mewndo uses. Free up space so Mewndo can keep saving versions.' };
const folders = [{ root: 'C:\\Users\\Ann\\task3', name: 'task3', status: 'unavailable' }];
const ids = (row) => row.actions.map((a) => a.id);

test('a missing folder gets a title, its message, Locate…, Remove from Mewndo… and Dismiss', () => {
  const r = A.row(missing, { folders, windows: true });
  assert.strictEqual(r.title, "task3 can't be found");
  assert.strictEqual(r.text, missing.message);
  assert.strictEqual(r.icon, 'folder');
  assert.deepStrictEqual(ids(r), ['locate', 'remove', 'dismiss']);
  assert.strictEqual(r.key, 'folder-unavailable|C:\\Users\\Ann\\task3');
  // Windows paths ignore case.
  assert.deepStrictEqual(ids(A.row({ ...missing, folder: 'c:\\users\\ann\\TASK3' }, { folders, windows: true })), ['locate', 'remove', 'dismiss']);
  assert.deepStrictEqual(ids(A.row({ ...missing, folder: '/home/ann/TASK3' }, { folders: [{ root: '/home/ann/task3' }] })), ['dismiss'],
    'elsewhere case matters');
});

test('a missing-folder warning for a folder Mewndo no longer has offers only Dismiss', () => {
  assert.deepStrictEqual(ids(A.row(missing, { folders: [] })), ['dismiss']);
  // "Can't protect X" (the first scan failed) names the folder as root, not folder: no folder actions.
  assert.deepStrictEqual(ids(A.row({ code: 'folder-unavailable', message: "Can't protect X" }, { folders })), ['dismiss']);
});

test('low disk space and an over-budget history open the storage settings, with an honest note', () => {
  for (const alert of [lowDisk, { code: 'over-budget', message: 'History is over budget.' }]) {
    const r = A.row(alert, { folders });
    assert.deepStrictEqual(ids(r), ['storage', 'dismiss']);
    assert.strictEqual(r.icon, 'disk');
    assert.match(r.note, /never deletes your own files/);
    assert.match(r.note, /can't free space other programs use/);
  }
  assert.strictEqual(A.row(lowDisk).title, 'Low disk space');
});

test('every other warning is one row with its message and Dismiss', () => {
  const rows = A.rows([{ code: 'watcher', folder: '/p', message: 'Mewndo stopped seeing changes in p.' },
    { code: 'mewndo-core', message: 'The core stopped.' }], { folders: [] });
  assert.deepStrictEqual(rows.map(ids), [['dismiss'], ['dismiss']]);
  assert.deepStrictEqual(rows.map((r) => r.tone), ['needs', 'stopped']);
  assert.deepStrictEqual(rows.map((r) => r.title), [null, null]);
  assert.deepStrictEqual(A.rows(undefined), []);
});

test('Remove from Mewndo keeps the save points unless the user also chose to delete them', () => {
  assert.deepStrictEqual(A.removeCall('keep'), { keepHistory: true });
  assert.deepStrictEqual(A.removeCall(undefined), { keepHistory: true });
  assert.deepStrictEqual(A.removeCall('delete'), { keepHistory: false });
});

test("Locate… says honestly that a folder's history can't move to a new place yet", () => {
  assert.match(A.LOCATE_LIMIT, /can't move a folder's history/);
  assert.match(A.LOCATE_LIMIT, /starts fresh/);
});

test('the main process wires the buttons: storage settings, and removing a folder clears its warnings', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
  assert.match(main, /openStorageSettings: \(\) => openSettings\('protection'\)/);
  assert.match(preload, /openStorageSettings: call\('openStorageSettings'\)/);
  const unprotect = main.slice(main.indexOf('  async unprotect(root, keepHistory) {'), main.indexOf('  async finishSetup('));
  assert.match(unprotect, /alerts\.delete/, 'a removed folder leaves no warning behind');
  const index = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'index.html'), 'utf8');
  assert.ok(index.indexOf('alerts-model.js') < index.indexOf('src="app.js"'), 'the model loads before app.js');
  assert.doesNotMatch(index, /id="alerts" class="[^"]*banner/, "the warnings don't use Home's dark banner style");
});

test('Remove from Mewndo works on a folder that can\'t be found, keeps its save points, and touches no user file', async () => {
  const { createMewndo } = require('../engine');
  const { tempDir } = require('./helpers');
  const base = tempDir();
  const root = path.join(base, 'drive', 'task3');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  const dataDir = path.join(base, 'data');
  const journalOptions = { debounceMs: 50, writeFinishMs: 100 };
  const first = createMewndo({ dataDir, journalOptions });
  await (await first.protect(root)).createSavePoint({ label: 'kept' });
  await first.stop();
  fs.renameSync(path.join(base, 'drive'), path.join(base, 'unplugged')); // the drive goes away

  const mewndo = createMewndo({ dataDir, journalOptions });
  await mewndo.start();
  try {
    assert.deepStrictEqual(mewndo.folders().map((f) => f.status), ['unavailable']);
    const missingRoot = mewndo.folders()[0].root;
    await mewndo.unprotect(missingRoot, A.removeCall('keep'));
    assert.deepStrictEqual(mewndo.folders(), [], 'Mewndo stops looking for it');
    assert.strictEqual(fs.readFileSync(path.join(base, 'unplugged', 'task3', 'a.txt'), 'utf8'), 'A', 'the folder is untouched');
  } finally { await mewndo.stop(); }

  // Plugged back in and protected again: the kept save points are still there.
  fs.renameSync(path.join(base, 'unplugged'), path.join(base, 'drive'));
  const again = createMewndo({ dataDir, journalOptions });
  try {
    const journal = await again.protect(root);
    assert.ok((await journal.listSavePoints()).some((sp) => sp.label === 'kept'));
  } finally { await again.stop(); }
});
