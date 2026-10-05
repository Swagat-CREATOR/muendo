// The main process registers one IPC handler per channel name; a duplicate makes Electron throw and Mewndo fails
// to start. Checked here, without starting Electron.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');

function handlerNames(object) {
  const start = source.indexOf(`const ${object} = {`);
  assert.ok(start >= 0, `${object} not found`);
  let depth = 0;
  let end = start;
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  return [...source.slice(start, end).matchAll(/^ {2}(?:async )?([a-zA-Z]+)(?:\(|:|,)/gm)].map((m) => m[1]);
}

test('every IPC channel the main process handles is unique', () => {
  const channels = [
    ...handlerNames('handlers'), ...handlerNames('undoHandlers'), ...handlerNames('briefHandlers'),
    ...handlerNames('settingsHandlers').map((n) => `settings:${n}`),
  ];
  assert.ok(channels.length > 30);
  assert.deepStrictEqual(channels.filter((c, i) => channels.indexOf(c) !== i), []);
});
