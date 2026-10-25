// Settings > Habits (app/habits-file.js): the rules Mewndo learned, read from the rules.toml the core writes
// (core/crates/mewndo-core/src/rules_file.rs), and removed one at a time with a temp file and a rename.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHabits, withoutHabit, readHabits, removeHabit } = require('../app/habits-file');
const { tempDir } = require('./helpers');

// Exactly the shapes rules_file.rs writes: a new file, and habits added to the user's own lists, with the user's
// comments and formatting around them. One habit is from before agent and project were recorded.
const FILE = [
  '# my rules',
  '[deny]',
  'commands = ["rm -rf ~",',
  '  # habit 2026-10-10 agent=claude project=my shop',
  '  "git push --force",',
  ']  # never',
  '',
  '[allow]',
  '# fast checks',
  'commands = ["cargo check",',
  '  # habit 2026-10-09',
  '  "npm test",',
  '  # habit 2026-10-11 agent=codex project=web',
  "  'C:\\tools\\lint.exe \"src\"',",
  '  # habit 2026-10-11 agent=cursor project=api',
  '  "echo \\"hi\\" \\u00e9",',
  ']',
  '',
  '[other]',
  'commands = [',
  '  # habit 2026-10-12 agent=claude project=x',
  '  "not a list the core writes",',
  ']',
  '',
].join('\n');

test('every learned rule is listed with its list, command, agent, project and date; the user\'s own are not', () => {
  const rules = parseHabits(FILE);
  assert.deepStrictEqual(rules.map(({ list, command, agent, project, date }) => ({ list, command, agent, project, date })), [
    { list: 'deny', command: 'git push --force', agent: 'claude', project: 'my shop', date: '2026-10-10' },
    { list: 'allow', command: 'npm test', agent: null, project: null, date: '2026-10-09' },
    { list: 'allow', command: 'C:\\tools\\lint.exe "src"', agent: 'codex', project: 'web', date: '2026-10-11' },
    { list: 'allow', command: 'echo "hi" é', agent: 'cursor', project: 'api', date: '2026-10-11' },
  ]);
  assert.ok(!rules.some((r) => ['rm -rf ~', 'cargo check'].includes(r.command)), 'rules the user wrote are theirs');
  assert.deepStrictEqual(parseHabits(''), []);
  assert.deepStrictEqual(parseHabits('[allow\ncommands = 1'), [], 'a broken file lists nothing and throws nothing');
});

test('Windows line endings are read the same', () => {
  assert.deepStrictEqual(parseHabits(FILE.replace(/\n/g, '\r\n')).map((r) => r.command), parseHabits(FILE).map((r) => r.command));
});

test('removing a rule takes out exactly its two lines and keeps everything else byte for byte', () => {
  const [, npm] = parseHabits(FILE);
  const out = withoutHabit(FILE, npm);
  const lines = FILE.split('\n');
  lines.splice(npm.line, 2);
  assert.strictEqual(out, lines.join('\n'));
  assert.deepStrictEqual(parseHabits(out).map((r) => r.command), ['git push --force', 'C:\\tools\\lint.exe "src"', 'echo "hi" é']);
  assert.ok(out.includes('# my rules') && out.includes('# fast checks') && out.includes('"cargo check",'));
  // The only rule in a new file: the list is left empty, which TOML reads as an empty list.
  const lone = '[allow]\ncommands = [\n  # habit 2026-10-10 agent=claude project=shop\n  "npm test",\n]\n';
  assert.strictEqual(withoutHabit(lone, parseHabits(lone)[0]), '[allow]\ncommands = [\n]\n');
});

test('a rule that is no longer where it was is never removed by guesswork', () => {
  const [first] = parseHabits(FILE);
  assert.throws(() => withoutHabit(FILE, { ...first, line: first.line + 2 }), /no longer in rules.toml/);
  assert.throws(() => withoutHabit(FILE, { ...first, command: 'git push' }), /no longer/);
  assert.throws(() => withoutHabit(FILE, { ...first, list: 'allow' }), /no longer/);
  assert.throws(() => withoutHabit(FILE, null), /no longer/);
});

test('removeHabit writes through a temporary file, leaves no temp behind, and returns the new list', async () => {
  const dir = path.join(tempDir(), 'Mewndo');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'rules.toml');
  fs.writeFileSync(file, FILE);
  const before = await readHabits(file);
  assert.strictEqual(before.rules.length, 4);
  assert.strictEqual(before.problem, null);
  const after = await removeHabit(file, before.rules[0]);
  assert.deepStrictEqual(after.rules.map((r) => r.command), ['npm test', 'C:\\tools\\lint.exe "src"', 'echo "hi" é']);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('git push --force'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('"rm -rf ~"'), "the user's own rule in that list stays");
  assert.deepStrictEqual(fs.readdirSync(dir), ['rules.toml'], 'no temporary file left');
  // The file changed meanwhile (the core wrote a habit): the stale rule is refused and the file is untouched.
  const now = fs.readFileSync(file, 'utf8');
  await assert.rejects(removeHabit(file, before.rules[0]), /no longer/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), now);
});

test('a missing rules file has no rules; one that cannot be read says so', async () => {
  const dir = tempDir();
  assert.deepStrictEqual(await readHabits(path.join(dir, 'rules.toml')), { file: path.join(dir, 'rules.toml'), rules: [], problem: null });
  const r = await readHabits(dir); // a folder, not a file
  assert.deepStrictEqual(r.rules, []);
  assert.match(r.problem, /can't read/);
});
