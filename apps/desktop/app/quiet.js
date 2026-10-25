// Do not disturb and the card sound (Settings > Notifications). Plain functions over the app's saved settings
// (app-settings.json, written by main.js with a temp file and a rename), no Electron, so tests run them in Node.
//
// While Do not disturb is on, cards still arrive in the Inbox and on the dock's capsule badge, but none pops up
// beside the dock and no Windows notification shows. The one exception is a permission request from one of the
// user's own agents: that agent is stopped until someone answers, so its card still shows (and still sounds).
//
// What it can't do: it is Mewndo's own setting, not Windows' Do not disturb (Focus), which it neither reads nor
// changes; and a notification Windows already shows stays until Windows takes it away.

const HOUR = 60 * 60 * 1000;
const MODES = ['off', 'hour', 'tomorrow', 'hours'];
const TOMORROW_AT = 8; // "until tomorrow" ends at 8:00 the next morning, local time
const DEFAULT_DND = { mode: 'off', until: null, from: '22:00', to: '08:00' };
const DEFAULT_SOUND = { on: false, volume: 0.5 };
const SOUND_FILE = 'assets/sounds/card.wav'; // relative to app/; made by scripts/make-sound.js

const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

// 8:00 tomorrow, local time.
function tomorrowMorning(now) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(TOMORROW_AT, 0, 0, 0);
  return d.getTime();
}

// The saved choices, with the defaults filled in and anything broken replaced by them. A timed mode that has run
// out reads as off.
function prefs(settings = {}, now = Date.now()) {
  const d = settings.dnd ?? {};
  const s = settings.sound ?? {};
  const dnd = {
    mode: MODES.includes(d.mode) ? d.mode : 'off',
    until: Number.isFinite(d.until) ? d.until : null,
    from: isTime(d.from) ? d.from : DEFAULT_DND.from,
    to: isTime(d.to) ? d.to : DEFAULT_DND.to,
  };
  if ((dnd.mode === 'hour' || dnd.mode === 'tomorrow') && !(dnd.until > now)) Object.assign(dnd, { mode: 'off', until: null });
  if (dnd.mode === 'hours' || dnd.mode === 'off') dnd.until = null;
  const volume = Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : DEFAULT_SOUND.volume;
  return { dnd, sound: { on: s.on === true, volume } };
}

// The settings with a change from the Notifications page applied: { dnd: { mode, from, to } } and/or
// { sound: { on, volume } }. Throws a plain message for anything it can't accept; returns a new object.
function withPrefs(settings, patch = {}, now = Date.now()) {
  const current = prefs(settings, now);
  const out = { ...settings };
  if (patch.dnd !== undefined) {
    const p = patch.dnd ?? {};
    if (!MODES.includes(p.mode)) throw new Error('Choose how long Do not disturb lasts.');
    const from = p.from ?? current.dnd.from;
    const to = p.to ?? current.dnd.to;
    if (!isTime(from) || !isTime(to)) throw new Error('Enter the hours as HH:MM, for example 22:00.');
    if (p.mode === 'hours' && from === to) throw new Error('The start and end times are the same. Choose two different times.');
    const until = p.mode === 'hour' ? now + HOUR : p.mode === 'tomorrow' ? tomorrowMorning(now) : null;
    out.dnd = { mode: p.mode, until, from, to };
  }
  if (patch.sound !== undefined) {
    const p = patch.sound ?? {};
    const volume = p.volume ?? current.sound.volume;
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('The volume goes from 0 to 100 %.');
    out.sound = { on: p.on === undefined ? current.sound.on : p.on === true, volume };
  }
  return out;
}

// True while Do not disturb is on.
function quietNow(settings, now = Date.now()) {
  const { dnd } = prefs(settings, now);
  if (dnd.mode === 'hour' || dnd.mode === 'tomorrow') return true; // prefs() already turned a finished one off
  if (dnd.mode !== 'hours') return false;
  const d = new Date(now);
  const at = d.getHours() * 60 + d.getMinutes();
  const from = minutes(dnd.from);
  const to = minutes(dnd.to);
  return from < to ? at >= from && at < to : at >= from || at < to; // 22:00 to 08:00 runs past midnight
}

// A permission request is an agent of the user's waiting to be allowed: it shows even during Do not disturb.
const urgent = (card) => card?.kind === 'permission';

// Whether a card that just arrived pops up beside the dock.
const popsUp = (card, settings, now = Date.now()) => urgent(card) || !quietNow(settings, now);

// The volume to play the card sound at, or null for silence.
function chime(card, settings, now = Date.now()) {
  const { sound } = prefs(settings, now);
  if (!sound.on || sound.volume <= 0 || !popsUp(card, settings, now)) return null;
  return sound.volume;
}

// Windows notifications (main.js's notify) are all quiet during Do not disturb: none of them is a permission request.
const notifies = (settings, now = Date.now()) => !quietNow(settings, now);

module.exports = { prefs, withPrefs, quietNow, popsUp, chime, notifies, tomorrowMorning, MODES, DEFAULT_DND, DEFAULT_SOUND, SOUND_FILE, HOUR };
