// Show Me skills on disk (spec §36.5, §36.6 U9): list, read, save, rename, edit steps and delete. No Electron here,
// so tests run it with plain Node.
//
// One JSON file per skill in <desk folder>/skills (%LOCALAPPDATA%\Mewndo\skills): Mewndo's own app data, never
// inside a protected folder (plot.md rule 1). The format is mewndo-computer's skill.rs (format 1), which is what
// `run_skill` reads; docs/samples/showme/skill.json is read by the tests on both sides. Every write is a temp file
// renamed into place, and Delete moves the file into skills/.trash rather than removing it (plot.md rules 3, 4).
//
// A step typed into a private field is `{kind: "type", secret: true}` with no text; editing can't put text into
// one (the user can delete the step instead).
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('../engine/store');

const FORMAT = 1;
const MAX_NAME = 80;
const MAX_STEPS = 500;
const MAX_TEXT = 10_000;

const skillsDir = (deskDir) => path.join(deskDir, 'skills');

// skill.rs `slug`: lowercase ASCII letters and digits, dashes between.
function slug(name) {
  let out = '';
  for (const c of String(name).trim().toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) out += c;
    else if (out && !out.endsWith('-')) out += '-';
  }
  out = out.replace(/-+$/, '').slice(0, 60);
  return out || 'skill';
}

function checkName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!n || [...n].length > MAX_NAME || /[\u0000-\u001f\u007f-\u009f]/.test(n)) {
    throw new Error(`A skill needs a name of 1 to ${MAX_NAME} characters.`);
  }
  return n;
}

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
const int = (v) => (Number.isInteger(v) ? v : null);

// One step, keeping only the fields skill.rs knows, or an error naming what is wrong.
function cleanStep(step, i) {
  const bad = (why) => new Error(`Step ${i + 1} ${why}.`);
  if (!step || typeof step !== 'object') throw bad('is not a step');
  switch (step.kind) {
    case 'focus':
      if (!str(step.app)) throw bad('needs the app');
      return { kind: 'focus', app: step.app, window: str(step.window) };
    case 'click': {
      const x = int(step.x);
      const y = int(step.y);
      if (x == null || y == null) throw bad('needs a point');
      const button = ['left', 'right', 'middle'].includes(step.button) ? step.button : 'left';
      const count = [1, 2, 3].includes(step.count) ? step.count : 1;
      const out = { kind: 'click', x, y, button, count };
      if (step.element && str(step.element.name)) out.element = { name: step.element.name, control_type: str(step.element.control_type) };
      out.app = str(step.app);
      out.on_primary = step.on_primary !== false;
      return out;
    }
    case 'type':
      if (step.secret === true) {
        if (step.text != null) throw bad('is private but holds text');
        return { kind: 'type', secret: true };
      }
      if (!str(step.text) || step.text.length > MAX_TEXT) throw bad(`needs text of 1 to ${MAX_TEXT} characters`);
      return { kind: 'type', text: step.text };
    case 'key': {
      if (!str(step.key)) throw bad('needs a key');
      const modifiers = Array.isArray(step.modifiers) ? step.modifiers.filter((m) => ['ctrl', 'alt', 'shift', 'win'].includes(m)) : [];
      return modifiers.length ? { kind: 'key', key: step.key, modifiers } : { kind: 'key', key: step.key };
    }
    default:
      throw bad(`has a kind Mewndo doesn't know (${String(step.kind)})`);
  }
}

// A whole skill, checked like skill.rs `check` and cleaned to its fields.
function clean(skill) {
  if (!skill || typeof skill !== 'object') throw new Error('Not a skill.');
  if (skill.format !== FORMAT) throw new Error(`Skill format ${skill.format} is not one this Mewndo reads (${FORMAT}).`);
  if (!Array.isArray(skill.steps)) throw new Error('A skill needs a list of steps.');
  if (skill.steps.length > MAX_STEPS) throw new Error(`A skill holds at most ${MAX_STEPS} steps.`);
  return {
    format: FORMAT,
    name: checkName(skill.name),
    description: str(skill.description).slice(0, 2000),
    created_ms: int(skill.created_ms) ?? 0,
    updated_ms: int(skill.updated_ms) ?? 0,
    steps: skill.steps.map(cleanStep),
  };
}

const parse = (text) => clean(JSON.parse(text));

// The skill file for an id, which must be a slug: nothing outside the folder can be named.
function fileOf(dir, id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw new Error('unknown skill');
  return path.join(dir, `${id}.json`);
}

// Every readable skill: [{ id, name, description, steps, updatedMs }], by name. Links and unreadable files are
// skipped (skill.rs `list` does the same).
async function list(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    try {
      const s = parse(await fsp.readFile(path.join(dir, e.name), 'utf8'));
      out.push({ id: e.name.slice(0, -5), name: s.name, description: s.description, steps: s.steps.length, updatedMs: s.updated_ms });
    } catch { /* not a skill: skipped */ }
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

async function read(dir, id) {
  const file = fileOf(dir, id);
  const st = await fsp.lstat(file);
  if (!st.isFile()) throw new Error('unknown skill');
  return { id, ...parse(await fsp.readFile(file, 'utf8')) };
}

async function nameTaken(dir, name, exceptId = null) {
  return (await list(dir)).some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === name.trim().toLowerCase());
}

const write = (dir, id, skill) => writeFileAtomic(fileOf(dir, id), `${JSON.stringify(skill, null, 2)}\n`);

// A new skill from a recording's steps. Returns it with its id (its name's slug, or slug-2, slug-3, ...).
async function create(dir, { name, description = '', steps }, now = Date.now()) {
  const skill = clean({ format: FORMAT, name, description, created_ms: now, updated_ms: now, steps });
  if (await nameTaken(dir, skill.name)) throw new Error(`There is already a skill called "${skill.name}".`);
  const base = slug(skill.name);
  let id = base;
  for (let n = 2; await fsp.lstat(fileOf(dir, id)).then(() => true, () => false); n++) id = `${base.slice(0, 58)}-${n}`;
  await write(dir, id, skill);
  return { id, ...skill };
}

// Rename, describe or edit the steps of a saved skill. The file keeps its id.
async function update(dir, id, { name, description, steps }, now = Date.now()) {
  const current = await read(dir, id);
  const next = clean({
    ...current,
    name: name ?? current.name,
    description: description ?? current.description,
    steps: steps ?? current.steps,
    updated_ms: now,
  });
  if (name != null && await nameTaken(dir, next.name, id)) throw new Error(`There is already a skill called "${next.name}".`);
  delete next.id;
  await write(dir, id, next);
  return { id, ...next };
}

// Delete: moved into skills/.trash, named for the time, never removed.
async function remove(dir, id) {
  const file = fileOf(dir, id);
  const st = await fsp.lstat(file);
  if (!st.isFile()) throw new Error('unknown skill');
  const trash = path.join(dir, '.trash');
  await fsp.mkdir(trash, { recursive: true });
  const to = path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.json`);
  await fsp.rename(file, to);
  return { id, trashedTo: to };
}

// A step in words, like skill.rs `Step::says`.
function says(step) {
  switch (step.kind) {
    case 'focus': return step.window ? `Switch to ${step.app} (${step.window})` : `Switch to ${step.app}`;
    case 'click': {
      const how = step.button === 'right' ? 'Right-click' : step.count === 2 ? 'Double-click' : 'Click';
      return step.element?.name ? `${how} "${step.element.name}" at ${step.x}, ${step.y}` : `${how} at ${step.x}, ${step.y}`;
    }
    case 'type': return step.secret ? 'Type something private (not recorded)' : `Type "${step.text}"`;
    case 'key': return step.modifiers?.length ? `Press ${step.modifiers.join('+')}+${step.key}` : `Press ${step.key}`;
    default: return 'Unknown step';
  }
}

module.exports = { FORMAT, MAX_NAME, MAX_STEPS, skillsDir, slug, clean, parse, list, read, create, update, remove, says };
