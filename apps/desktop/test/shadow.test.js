// Shadow mode (engine/shadow.js): both engines scan the same folder and their manifests are compared.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createCore } = require('../app/core');
const { createMewndo, connectCore } = require('../engine');
const { differences } = require('../engine/shadow');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';
const base = tempDir();
let core;
before(async () => {
  if (skip) return;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: CORE_BINARY, runDir: base, logDir: path.join(base, 'logs'), log: { info() {}, warn() {}, error() {} },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
});
after(() => core?.stop());

test('differences: only real ones, never a file still being written', () => {
  const f = (hash, extra = {}) => ({ type: 'file', size: 1, mtimeMs: 5, hash, ...extra });
  assert.deepStrictEqual(differences({ a: f('1'), b: f('2'), c: f('3', { pending: true }) }, { a: f('1'), b: f('9'), c: f('8') }),
    [{ path: 'b', field: 'hash', v0: '2', rust: '9' }]);
  assert.deepStrictEqual(differences({ a: f('1') }, {}), [{ path: 'a', field: 'exists', v0: true, rust: false }]);
});

test('shadow mode: both engines scan a protected folder the same way, and restores stay in v0', { skip }, async () => {
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'A');
  fs.writeFileSync(path.join(root, 'docs', 'b.md'), 'B');
  const client = connectCore(core.address);
  const mewndo = createMewndo({ dataDir: path.join(base, 'data'), core: client, engine: 'shadow', journalOptions: { debounceMs: 50, writeFinishMs: 100 } });
  try {
    await mewndo.start();
    await mewndo.protect(root);
    const [report] = await mewndo.shadowCheck();
    assert.deepStrictEqual(report, { folder: fs.realpathSync(root), count: 0, differences: [] });
    assert.strictEqual(mewndo.journals()[0].core, null, 'restores in v0');
  } finally {
    await mewndo.stop();
    client.close();
  }
});
