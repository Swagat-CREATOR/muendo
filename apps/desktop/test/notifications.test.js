// Settings > Notifications: Do not disturb and the card sound (app/quiet.js), how the Agent Desk uses them
// (app/desk/desk.js's quiet and arrived), and the bundled sound file (scripts/make-sound.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const quiet = require('../app/quiet');
const { createDesk } = require('../app/desk/desk');
const { wav, OUT, RATE } = require('../scripts/make-sound');
const { tempDir } = require('./helpers');

// Local times on one day, so the tests mean the same in every time zone.
const at = (h, m = 0, day = 15) => new Date(2026, 9, day, h, m).getTime();
const permission = { kind: 'permission' };
const question = { kind: 'question' };

test('Do not disturb is off by default, and cards pop up and stay silent', () => {
  const p = quiet.prefs({});
  assert.deepStrictEqual(p, { dnd: { mode: 'off', until: null, from: '22:00', to: '08:00' }, sound: { on: false, volume: 0.5 } });
  assert.strictEqual(quiet.quietNow({}), false);
  assert.strictEqual(quiet.popsUp(question, {}), true);
  assert.strictEqual(quiet.chime(question, {}), null, 'the sound is off until the user turns it on');
  assert.strictEqual(quiet.notifies({}), true);
});

test('for 1 hour: quiet for exactly an hour, then off by itself', () => {
  const now = at(14, 30);
  const s = quiet.withPrefs({}, { dnd: { mode: 'hour' } }, now);
  assert.strictEqual(s.dnd.until, now + quiet.HOUR);
  assert.strictEqual(quiet.quietNow(s, now + 59 * 60_000), true);
  assert.strictEqual(quiet.notifies(s, now + 59 * 60_000), false);
  assert.strictEqual(quiet.quietNow(s, now + quiet.HOUR), false);
  assert.strictEqual(quiet.prefs(s, now + quiet.HOUR).dnd.mode, 'off', 'a finished one reads as off');
});

test('until tomorrow: quiet until 8:00 the next morning, local time', () => {
  const now = at(23, 10);
  const s = quiet.withPrefs({}, { dnd: { mode: 'tomorrow' } }, now);
  assert.strictEqual(s.dnd.until, at(8, 0, 16));
  assert.strictEqual(quiet.quietNow(s, at(7, 59, 16)), true);
  assert.strictEqual(quiet.quietNow(s, at(8, 0, 16)), false);
  // Set in the small hours, it still means the next day's morning, not a few hours away.
  assert.strictEqual(quiet.withPrefs({}, { dnd: { mode: 'tomorrow' } }, at(1, 0)).dnd.until, at(8, 0, 16));
});

test('during set hours: every day, including hours that run past midnight', () => {
  const night = quiet.withPrefs({}, { dnd: { mode: 'hours', from: '22:00', to: '07:30' } }, at(12));
  for (const [time, on] of [[at(21, 59), false], [at(22, 0), true], [at(3, 0), true], [at(7, 29), true], [at(7, 30), false], [at(12), false]]) {
    assert.strictEqual(quiet.quietNow(night, time), on, new Date(time).toTimeString());
  }
  const lunch = quiet.withPrefs({}, { dnd: { mode: 'hours', from: '12:00', to: '13:00' } }, at(9));
  assert.strictEqual(quiet.quietNow(lunch, at(12, 30)), true);
  assert.strictEqual(quiet.quietNow(lunch, at(13, 0)), false);
  assert.strictEqual(quiet.quietNow(lunch, at(11, 59)), false);
  assert.strictEqual(lunch.dnd.until, null);
});

test('bad choices are refused with a plain message and change nothing', () => {
  const before = quiet.withPrefs({}, { dnd: { mode: 'hours', from: '22:00', to: '08:00' } });
  assert.throws(() => quiet.withPrefs(before, { dnd: { mode: 'forever' } }), /how long/);
  assert.throws(() => quiet.withPrefs(before, { dnd: { mode: 'hours', from: '25:00', to: '08:00' } }), /HH:MM/);
  assert.throws(() => quiet.withPrefs(before, { dnd: { mode: 'hours', from: '09:00', to: '09:00' } }), /same/);
  assert.throws(() => quiet.withPrefs(before, { sound: { volume: 2 } }), /0 to 100/);
  assert.throws(() => quiet.withPrefs(before, { sound: { volume: 'loud' } }), /0 to 100/);
  assert.deepStrictEqual(quiet.prefs(before).dnd, { mode: 'hours', until: null, from: '22:00', to: '08:00' });
  // A hand-edited settings file with nonsense in it reads as the defaults, never as an error.
  assert.deepStrictEqual(quiet.prefs({ dnd: { mode: 'x', from: 7 }, sound: { on: 'yes', volume: 9 } }),
    { dnd: { mode: 'off', until: null, from: '22:00', to: '08:00' }, sound: { on: false, volume: 1 } });
});

test('while quiet, only permission requests pop up and sound; Windows notifications are off', () => {
  const now = at(10);
  const s = quiet.withPrefs(quiet.withPrefs({}, { sound: { on: true, volume: 0.4 } }), { dnd: { mode: 'hour' } }, now);
  assert.strictEqual(quiet.popsUp(question, s, now), false);
  assert.strictEqual(quiet.popsUp({ kind: 'done' }, s, now), false);
  assert.strictEqual(quiet.popsUp({ kind: 'habit' }, s, now), false);
  assert.strictEqual(quiet.popsUp(permission, s, now), true, "an agent of the user's is waiting on it");
  assert.strictEqual(quiet.chime(question, s, now), null);
  assert.strictEqual(quiet.chime(permission, s, now), 0.4);
  assert.strictEqual(quiet.notifies(s, now), false);
  const later = now + 2 * quiet.HOUR;
  assert.strictEqual(quiet.chime(question, s, later), 0.4, 'after the hour every card sounds again');
});

test('the sound settings persist: saved as JSON, read back the same, and a volume of 0 is silence', () => {
  const dir = tempDir();
  const file = path.join(dir, 'app-settings.json');
  let settings = { setupDone: true, openAtLogin: true };
  settings = quiet.withPrefs(settings, { sound: { on: true } });
  settings = quiet.withPrefs(settings, { sound: { volume: 0.25 } }); // the slider alone keeps "on"
  fs.writeFileSync(file, JSON.stringify(settings));
  const read = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(quiet.prefs(read).sound, { on: true, volume: 0.25 });
  assert.strictEqual(read.setupDone, true, 'the other settings are kept');
  assert.strictEqual(quiet.chime(question, read), 0.25);
  const off = quiet.withPrefs(read, { sound: { on: false } });
  assert.deepStrictEqual(quiet.prefs(off).sound, { on: false, volume: 0.25 }, 'off remembers the volume');
  assert.strictEqual(quiet.chime(question, quiet.withPrefs(read, { sound: { volume: 0 } })), null);
});

test('the Desk keeps a quiet card in the stack without popping it up, and reports each new card once', () => {
  const listeners = new Map();
  const client = {
    on(type, fn) { listeners.set(type, fn); return () => {}; },
    send: () => true, sendLane: () => true, start() {}, stop() {},
  };
  const shown = [];
  const sent = [];
  const ui = { send: (n, c, p) => sent.push([n, c, p]), showCards: (o) => shown.push(o), hideCards() {}, showTalk() {}, hideTalk() {} };
  const arrived = [];
  let isQuiet = true;
  const desk = createDesk({ client, ui, quiet: (card) => isQuiet && card.kind !== 'permission', arrived: (card) => arrived.push(card.id) });
  desk.start();
  const card = (id, kind) => listeners.get('inbox.card')({ type: 'inbox.card', body: { id, kind, agent_id: 'a1', title: 't', options: [] } });
  card('c1', 'question');
  assert.deepStrictEqual(shown, [], 'quiet: no card beside the dock');
  assert.strictEqual(desk.cards().count(), 1, 'but it is in the stack, so the Inbox and the badge count it');
  card('c2', 'permission');
  assert.strictEqual(shown.length, 1, 'a permission request still shows');
  card('c1', 'question'); // the core sends the same card again
  assert.deepStrictEqual(arrived, ['c1', 'c2'], 'a re-sent card is not new');
  isQuiet = false;
  card('c3', 'question');
  assert.strictEqual(shown.length, 2);
  desk.stop?.();
});

test('the bundled card sound is a short, soft mono WAV, and the script makes the same one', () => {
  const file = fs.readFileSync(OUT);
  assert.strictEqual(file.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(file.toString('ascii', 8, 12), 'WAVE');
  assert.strictEqual(file.readUInt16LE(20), 1, 'PCM');
  assert.strictEqual(file.readUInt16LE(22), 1, 'mono');
  assert.strictEqual(file.readUInt32LE(24), RATE);
  assert.strictEqual(file.readUInt16LE(34), 16);
  const seconds = file.readUInt32LE(40) / (RATE * 2);
  assert.ok(seconds > 0.2 && seconds < 1, `${seconds} s`);
  const samples = new Int16Array(file.buffer.slice(file.byteOffset + 44, file.byteOffset + file.length));
  const peak = Math.max(...samples.map(Math.abs));
  assert.ok(peak > 3000 && peak < 0.5 * 32767, `soft, not silent: peak ${peak}`);
  assert.ok(Math.abs(samples[0]) < 50 && Math.abs(samples.at(-1)) < 50, 'no click at either end');
  const fresh = wav();
  assert.strictEqual(fresh.length, file.length);
  const again = new Int16Array(fresh.buffer.slice(fresh.byteOffset + 44, fresh.byteOffset + fresh.length));
  assert.ok(again.every((v, i) => Math.abs(v - samples[i]) <= 1), 'the committed file is what scripts/make-sound.js writes');
});
