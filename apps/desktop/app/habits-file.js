// The rules Mewndo learned from your answers (spec §34.7), as Settings > Habits lists them, and their removal.
// Plain Node, no Electron, so tests run it on files in temporary folders.
//
// The core writes an accepted Habit card into the user's rules.toml (core/crates/mewndo-core/src/rules_file.rs) as
// one line in [allow] or [deny] `commands`, under a comment:
//
//   [allow]
//   commands = [
//     # habit 2026-10-10 agent=claude project=shop
//     "npm test",
//   ]
//
// (Files written before agent and project were recorded have only the date.) Only lines under such a comment are
// listed: the user's own rules in the file are theirs to edit. Removing one takes out exactly its two lines, keeps
// everything else byte for byte, and writes a temporary file that is then renamed into place (plot.md rule 4).
//
// What it can't do: the core reads rules.toml only when it starts, so a removed rule keeps applying until Mewndo
// next starts. "Never ask" answers are not written to the file (the core keeps them until it stops), so they are
// not listed. A rule the user moved or reformatted by hand is no longer recognised as learned, and is left alone.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const COMMENT = /^\s*# habit (\d{4}-\d{2}-\d{2})(?: agent=(\S+))?(?: project=(.*?))?\s*$/;
const VALUE = /^\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*')\s*,?\s*$/;
const ARRAY_OPEN = /^\s*(?:(allow|deny)\s*\.\s*)?commands\s*=\s*\[/;
const HEADER = /^\s*\[\s*([^\]]*?)\s*\]\s*(#.*)?$/;

// A TOML string as written: "basic" with escapes, or 'literal'. Null for anything else.
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
function decode(token) {
  if (token.startsWith("'")) return token.slice(1, -1);
  let out = '';
  for (let i = 1; i < token.length - 1; i++) {
    if (token[i] !== '\\') { out += token[i]; continue; }
    const e = token[++i];
    if (e in ESCAPES) { out += ESCAPES[e]; continue; }
    const hex = e === 'u' ? 4 : e === 'U' ? 8 : 0;
    const code = hex && /^[0-9A-Fa-f]+$/.test(token.slice(i + 1, i + 1 + hex)) ? parseInt(token.slice(i + 1, i + 1 + hex), 16) : NaN;
    if (!(code <= 0x10ffff)) return null;
    out += String.fromCodePoint(code);
    i += hex;
  }
  return out;
}

// Which list a habit comment on line i is in: 'allow' or 'deny', or null when it isn't one the core writes to.
function sectionAt(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const open = lines[j].match(ARRAY_OPEN);
    if (open) {
      if (open[1]) return open[1];
      for (let k = j - 1; k >= 0; k--) {
        const header = lines[k].match(HEADER);
        if (header) return ['allow', 'deny'].includes(header[1]) ? header[1] : null;
      }
      return null; // commands at the top level is not [allow] or [deny]
    }
    if (HEADER.test(lines[j])) return null; // a table header before any `commands = [`: not in a list
  }
  return null;
}

// Every learned rule in the file's text: { id, list: 'allow' | 'deny', command, date, agent, project, line }.
// line is the comment's line number (0-based); id is stable while the file doesn't change.
function parseHabits(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const c = lines[i].replace(/\r$/, '').match(COMMENT);
    if (!c) continue;
    const v = lines[i + 1].replace(/\r$/, '').match(VALUE);
    const command = v && decode(v[1]);
    if (command == null) continue;
    const list = sectionAt(lines, i);
    if (!list) continue;
    out.push({ id: `${list}:${i}:${command}`, list, command, date: c[1], agent: c[2] ?? null, project: c[3] || null, line: i });
  }
  return out;
}

// The text without one learned rule (from parseHabits, matched by list, command and line). Throws when the file
// no longer has it there, so a file edited meanwhile is never changed by guesswork.
function withoutHabit(text, rule) {
  const found = parseHabits(text).find((r) => r.list === rule?.list && r.command === rule?.command && r.line === rule?.line);
  if (!found) throw new Error('That rule is no longer in rules.toml (the file changed). The list has been refreshed.');
  const lines = String(text).split('\n');
  lines.splice(found.line, 2);
  return lines.join('\n');
}

// { file, rules, problem }. A missing file has no rules; one that can't be read says why.
async function readHabits(file) {
  try {
    return { file, rules: parseHabits(await fsp.readFile(file, 'utf8')), problem: null };
  } catch (e) {
    if (e.code === 'ENOENT') return { file, rules: [], problem: null };
    return { file, rules: [], problem: `Mewndo can't read ${file}: ${e.message}` };
  }
}

// Temp file in the same folder, flushed, then renamed over the old one. A crash leaves the old file whole.
async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.mewndo-tmp`);
  try {
    await fsp.writeFile(tmp, text, { flush: true });
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

// Removes one learned rule; returns what readHabits returns afterwards.
async function removeHabit(file, rule) {
  const text = await fsp.readFile(file, 'utf8');
  await writeAtomic(file, withoutHabit(text, rule));
  return readHabits(file);
}

module.exports = { parseHabits, withoutHabit, readHabits, removeHabit, writeAtomic };
