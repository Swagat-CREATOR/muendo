// Show Me skills on disk (app/skills.js): the format mewndo-computer's skill.rs reads, list, save, rename, edit and
// delete (to the trash folder). Temporary folders only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const skills = require('../app/skills');
const { tempDir } = require('./helpers');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'samples', 'showme', 'skill.json'), 'utf8');

test('the sample skill is read the same way skill.rs reads it', () => {
  const s = skills.parse(SAMPLE);
  assert.strictEqual(s.name, 'Send the weekly report');
  assert.strictEqual(s.steps.length, 6);
  assert.deepStrictEqual(s.steps[1], {
    kind: 'click', x: 412, y: 230, button: 'left', count: 1, element: { name: 'New mail', control_type: 'Button' }, app: 'OUTLOOK.EXE', on_primary: true,
  });
  assert.deepStrictEqual(s.steps[3], { kind: 'type', secret: true });
  assert.deepStrictEqual(s.steps[5], { kind: 'key', key: 's', modifiers: ['ctrl'] });
  assert.deepStrictEqual(skills.parse(JSON.stringify(s)), s, 'round trip');
  assert.deepStrictEqual(s.steps.map(skills.says), [
    'Switch to OUTLOOK.EXE (Inbox - Outlook)', 'Click "New mail" at 412, 230', 'Type "boss@example.com"',
    'Type something private (not recorded)', 'Press Enter', 'Press ctrl+s',
  ]);
});

test('a private step can never hold text, and unknown or broken steps are refused', () => {
  const base = JSON.parse(SAMPLE);
  const leak = structuredClone(base);
  leak.steps[3].text = 'hunter2';
  assert.throws(() => skills.clean(leak), /Step 4 is private but holds text/);
  for (const [bad, why] of [
    [{ ...base, format: 2 }, /format 2/],
    [{ ...base, name: '   ' }, /needs a name/],
    [{ ...base, name: 'a'.repeat(81) }, /needs a name/],
    [{ ...base, name: 'bell\u0007' }, /needs a name/],
    [{ ...base, steps: [{ kind: 'teleport' }] }, /doesn't know/],
    [{ ...base, steps: [{ kind: 'click', x: 'one', y: 2 }] }, /needs a point/],
    [{ ...base, steps: [{ kind: 'type', text: '' }] }, /needs text/],
    [{ ...base, steps: Array(501).fill({ kind: 'key', key: 'Tab' }) }, /at most 500/],
  ]) assert.throws(() => skills.clean(bad), why);
  // Fields skill.rs doesn't know are dropped, not stored.
  const extra = skills.clean({ ...base, steps: [{ kind: 'key', key: 'Enter', modifiers: ['ctrl', 'hyper'], password: 'x' }] });
  assert.deepStrictEqual(extra.steps, [{ kind: 'key', key: 'Enter', modifiers: ['ctrl'] }]);
});

test('slugs match skill.rs', () => {
  assert.strictEqual(skills.slug('Send the weekly report'), 'send-the-weekly-report');
  assert.strictEqual(skills.slug('  Ünïcode!! & stuff -- '), 'n-code-stuff');
  assert.strictEqual(skills.slug('???'), 'skill');
  assert.strictEqual(skills.slug('x'.repeat(100)).length, 60);
});

test('create, list, read, rename, edit steps, and delete to the trash', async () => {
  const dir = skills.skillsDir(tempDir());
  assert.deepStrictEqual(await skills.list(dir), [], 'no folder yet');
  const steps = JSON.parse(SAMPLE).steps;
  const a = await skills.create(dir, { name: 'Send the weekly report', description: 'Mail', steps }, 1000);
  assert.strictEqual(a.id, 'send-the-weekly-report');
  assert.strictEqual(a.created_ms, 1000);
  await assert.rejects(skills.create(dir, { name: 'SEND the weekly report', steps }), /already a skill called/);
  const b = await skills.create(dir, { name: 'Send the weekly report!', steps: [] });
  assert.strictEqual(b.id, 'send-the-weekly-report-2', 'same slug, its own file');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');
  fs.writeFileSync(path.join(dir, 'notes.txt'), SAMPLE);
  const listed = await skills.list(dir);
  assert.deepStrictEqual(listed.map((s) => [s.id, s.steps]), [['send-the-weekly-report', 6], ['send-the-weekly-report-2', 0]]);

  // The file is the format skill.rs reads: no "id" inside, private steps without text.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'send-the-weekly-report.json'), 'utf8'));
  assert.strictEqual(onDisk.format, 1);
  assert.strictEqual(onDisk.id, undefined);
  assert.deepStrictEqual(onDisk.steps[3], { kind: 'type', secret: true });

  const renamed = await skills.update(dir, a.id, { name: 'Weekly report', steps: steps.slice(0, 2) }, 2000);
  assert.strictEqual(renamed.id, a.id, 'the file keeps its id');
  assert.strictEqual(renamed.updated_ms, 2000);
  assert.strictEqual((await skills.read(dir, a.id)).steps.length, 2);
  await assert.rejects(skills.update(dir, b.id, { name: 'weekly REPORT' }), /already a skill called/);
  await assert.rejects(skills.read(dir, '../../etc/passwd'), /unknown skill/);
  await assert.rejects(skills.update(dir, a.id, { steps: [{ kind: 'type', secret: true, text: 'pw' }] }), /private but holds text/);

  const gone = await skills.remove(dir, a.id);
  assert.ok(gone.trashedTo.startsWith(path.join(dir, '.trash')));
  assert.ok(fs.existsSync(gone.trashedTo), 'moved, never removed');
  assert.deepStrictEqual((await skills.list(dir)).map((s) => s.id), ['send-the-weekly-report-2']);
  await assert.rejects(skills.remove(dir, a.id), /ENOENT/);
});
