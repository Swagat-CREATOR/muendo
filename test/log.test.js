const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createLog } = require('../engine/log');
const { tempDir } = require('./helpers');

test('the log writes one line per event, with level and details', async () => {
  const dir = path.join(tempDir(), 'logs');
  const log = createLog(dir);
  log.info('Mewndo started', { version: '0.1.0' });
  log.error('Something failed', 'Error: boom\n    at x.js:1');
  await log.flush();
  const lines = fs.readFileSync(log.file, 'utf8').split('\n');
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  Mewndo started \{"version":"0.1.0"\}$/);
  assert.match(lines[1], /ERROR Something failed Error: boom$/);
  assert.match(lines[2], /^ {4} {4}at x\.js:1$/, 'continuation lines are indented, not new entries');
});

test('the log rotates at the size limit and keeps a fixed number of old files', async () => {
  const dir = path.join(tempDir(), 'logs');
  const log = createLog(dir, { maxBytes: 1000, keep: 3 });
  for (let i = 0; i < 100; i++) log.info(`event ${i} ${'x'.repeat(50)}`);
  await log.flush();
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['mewndo.log', 'mewndo.log.1', 'mewndo.log.2', 'mewndo.log.3']);
  for (const f of fs.readdirSync(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000, f);
  assert.match(fs.readFileSync(path.join(dir, 'mewndo.log'), 'utf8'), /event 99 /, 'newest in the current file');
});

test('a log that cannot be written never throws', async () => {
  const file = path.join(tempDir(), 'not-a-folder');
  fs.writeFileSync(file, 'x'); // the log directory path is a file
  const log = createLog(file);
  await assert.doesNotReject(log.info('hello'));
});
