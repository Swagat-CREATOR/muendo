const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createMewndo, DEFAULT_AGENTS } = require('../engine');
const { tempDir } = require('./helpers');

const journalOptions = { debounceMs: 50, writeFinishMs: 100 };
const MB = 1024 ** 2;

async function setup(files = {}) {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const dataDir = path.join(base, 'data');
  const mewndo = createMewndo({ dataDir, journalOptions });
  const journal = await mewndo.protect(root);
  return { base, root, dataDir, mewndo, journal };
}

test('burst thresholds change live; invalid values are refused', async () => {
  const files = {};
  for (let i = 0; i < 10; i++) files[`f${i}.txt`] = `${i}`;
  const { root, mewndo, journal } = await setup(files);
  const bursts = [];
  mewndo.on('burst', (r, b) => bursts.push(b));
  try {
    assert.deepStrictEqual(mewndo.config().burst, { maxDeleted: 20, maxChanged: 50 });
    assert.deepStrictEqual(mewndo.configure({ burst: { maxDeleted: 5 } }).burst, { maxDeleted: 5, maxChanged: 50 });
    for (let i = 0; i < 6; i++) fs.rmSync(path.join(root, `f${i}.txt`));
    await journal.sync();
    assert.deepStrictEqual(bursts, [{ deleted: 6, changed: 6, agent: null }], 'the new threshold applied to a running journal');
    assert.throws(() => mewndo.configure({ burst: { maxDeleted: 0 } }), /whole number/);
    assert.throws(() => mewndo.configure({ budgetBytes: 1000 }), /at least 0.1 GB/);
    mewndo.configure({ budgetBytes: 2 * 1024 ** 3 });
    assert.strictEqual((await mewndo.storageReport()).budgetBytes, 2 * 1024 ** 3);
  } finally { await mewndo.stop(); }
});

test('per-folder ignore patterns and size limit apply at once, are saved, and survive a restart', async () => {
  const { root, dataDir, mewndo, journal } = await setup({
    'a.txt': 'A', 'debug.log': 'log', 'tmp/cache.bin': 'c', 'big.bin': Buffer.alloc(2 * MB, 1),
  });
  try {
    assert.ok(journal.getIndex()['debug.log'] && journal.getIndex()['tmp/cache.bin'] && journal.getIndex()['big.bin'].hash);
    const saved = await mewndo.setFolderSettings(root, { retentionDays: 7, extraIgnore: ['*.log', ' tmp ', '*.log'], maxFileSizeMB: 1 });
    assert.deepStrictEqual(saved.extraIgnore, ['*.log', 'tmp'], 'trimmed, duplicates removed');
    const idx = journal.getIndex();
    assert.strictEqual(idx['debug.log'], undefined, 'ignored file left out');
    assert.strictEqual(idx.tmp, undefined, 'ignored folder left out');
    assert.strictEqual(idx['big.bin'].skipped, 'too-large', 'new size limit applied');
    assert.ok(idx['a.txt'].hash);
    fs.writeFileSync(path.join(root, 'later.log'), 'new');
    await journal.sync();
    assert.strictEqual(journal.getIndex()['later.log'], undefined, 'new matching files are ignored too');

    await assert.rejects(mewndo.setFolderSettings(root, { retentionDays: 0, extraIgnore: [], maxFileSizeMB: 50 }), /1 to 3,650/);
    await assert.rejects(mewndo.setFolderSettings(root, { retentionDays: 7, extraIgnore: ['a/b'], maxFileSizeMB: 50 }), /no slashes/);
    await assert.rejects(mewndo.setFolderSettings(root, { retentionDays: 7, extraIgnore: [], maxFileSizeMB: 0 }), /1 to 10,240 MB/);
  } finally { await mewndo.stop(); }

  const again = createMewndo({ dataDir, journalOptions });
  await again.start();
  try {
    while (again.folders()[0]?.status !== 'protected') await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(await again.folderSettings(), [{ root: fs.realpathSync(root), retentionDays: 7, extraIgnore: ['*.log', 'tmp'], maxFileSizeMB: 1 }]);
    const idx = again.journals()[0].getIndex();
    assert.strictEqual(idx['debug.log'], undefined);
    assert.strictEqual(idx['big.bin'].skipped, 'too-large');
  } finally { await again.stop(); }
});

test("stopping and re-protecting a folder keeps its own settings", async () => {
  const { root, mewndo } = await setup({ 'a.txt': 'A', 'x.log': 'x' });
  try {
    await mewndo.setFolderSettings(root, { retentionDays: 9, extraIgnore: ['*.log'], maxFileSizeMB: 5 });
    await mewndo.unprotect(root, { keepHistory: true });
    const j = await mewndo.protect(root);
    assert.deepStrictEqual((await mewndo.folderSettings())[0], { root: fs.realpathSync(root), retentionDays: 9, extraIgnore: ['*.log'], maxFileSizeMB: 5 });
    assert.strictEqual(j.getIndex()['x.log'], undefined);
  } finally { await mewndo.stop(); }
});

test('the agent list can be changed, is validated, and resets to the defaults', async () => {
  const { dataDir, mewndo } = await setup();
  try {
    assert.deepStrictEqual((await mewndo.agentList()).map((a) => a.name), DEFAULT_AGENTS.map((a) => a.name));
    await mewndo.setAgentList([{ name: 'Aider', names: ['aider'], commandLine: [], notCommandLine: [] }]);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
    assert.deepStrictEqual(file.agents.map((a) => a.name), ['Aider']);
    assert.ok(file._help);
    await assert.rejects(mewndo.setAgentList([{ names: ['nameless'] }]), /agents\.json must look like/);
    assert.deepStrictEqual((await mewndo.agentList()).map((a) => a.name), ['Aider'], 'a refused list changes nothing');
    await mewndo.setAgentList(null);
    assert.deepStrictEqual((await mewndo.agentList()).map((a) => a.name), DEFAULT_AGENTS.map((a) => a.name));
  } finally { await mewndo.stop(); }
});
