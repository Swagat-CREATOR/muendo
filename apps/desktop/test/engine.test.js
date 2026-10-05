const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('engine loads in plain Node and never imports Electron', () => {
  require('../engine');
  for (const f of fs.readdirSync(path.join(__dirname, '../engine'), { recursive: true })) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, '../engine', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"]electron['"]\)|from ['"]electron['"]/, f);
  }
});
