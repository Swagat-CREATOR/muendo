// Computer use and Show Me in the main process (app/computer-main.js), with a fake core, a fake desk pipe and
// temporary folders: the switch, the recording state machine, and the handlers main.js adds to its own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createComputerUse, createRecording } = require('../app/computer-main');
const { tempDir } = require('./helpers');

test('the recording state machine: asked, recording, steps, review, done', () => {
  const r = createRecording();
  assert.strictEqual(r.view().phase, 'idle');
  assert.strictEqual(r.onState({ recording: false, reason: 'x' }).phase, 'idle', 'not ours: nothing changes');
  assert.strictEqual(r.asked(), true);
  assert.strictEqual(r.asked(), false, 'one at a time');
  assert.strictEqual(r.view().phase, 'starting');
  r.onState({ recording: true });
  r.onStep({ step: { index: 0, step: { kind: 'click', x: 1, y: 2 } } });
  r.onStep({ step: { index: 1, step: { kind: 'type', secret: true } } });
  r.onStep({ step: { index: 0, step: { kind: 'click', x: 1, y: 2, count: 2 } } }); // became a double-click
  r.onStep({ step: { index: -1, step: {} } });
  r.onStep({ step: { index: 9999, step: {} } });
  assert.deepStrictEqual(r.view().steps, [{ kind: 'click', x: 1, y: 2, count: 2 }, { kind: 'type', secret: true }]);
  // The core's final list wins over what streamed.
  const end = r.onState({ recording: false, reason: 'you pressed Esc', steps: [{ kind: 'key', key: 'Enter' }] });
  assert.deepStrictEqual(end, { phase: 'review', steps: [{ kind: 'key', key: 'Enter' }], reason: 'you pressed Esc' });
  assert.strictEqual(r.onStep({ step: { index: 0, step: {} } }).steps.length, 1, 'no steps after the end');
  assert.strictEqual(r.done().phase, 'idle');

  // A start the core refused, or a recording with nothing in it: back to idle with the reason.
  r.asked();
  assert.deepStrictEqual(r.onState({ recording: false, reason: 'Show Me needs computer use.' }), { phase: 'idle', steps: [], reason: 'Show Me needs computer use.' });
});

function fakeClient() {
  const on = new Map();
  const sent = [];
  return {
    sent,
    connected: () => true,
    send: (type, body) => { sent.push([type, body]); return true; },
    on: (type, fn) => on.set(type, fn),
    emit: (type, body) => on.get(type)?.({ type, body }),
  };
}

function make(overrides = {}) {
  const dir = tempDir();
  const settings = { computerUse: false };
  const calls = { saved: 0, restarts: 0, shown: 0, hidden: 0, reviews: 0, settingsViews: [], main: [] };
  const cu = createComputerUse({
    getSettings: () => settings,
    saveSettings: async () => { calls.saved++; },
    log: { info() {}, warn() {} },
    coreBinary: () => path.join(dir, 'mewndo-core.exe'),
    deskDir: () => path.join(dir, 'desk'),
    restartCore: async () => { calls.restarts++; },
    coreStatus: () => ({ state: 'running' }),
    notifySettings: (v) => calls.settingsViews.push(v),
    notifyMain: (channel, payload) => calls.main.push([channel, payload]),
    indicator: { show: () => { calls.shown++; }, hide: () => { calls.hidden++; } },
    onReview: () => { calls.reviews++; },
    arch: 'x64',
    vendor: path.join(dir, 'vendor'),
    home: path.join(dir, 'home'),
    env: {},
    ...overrides,
  });
  return { cu, settings, calls, dir };
}

test('turning it on without the checked driver offers the download and changes nothing', async () => {
  const { cu, settings, calls } = make();
  const v = await cu.setOn(true);
  assert.strictEqual(v.needsDownload, true);
  assert.strictEqual(v.on, false);
  assert.strictEqual(settings.computerUse, false);
  assert.strictEqual(calls.restarts, 0, 'the core is not restarted');
  assert.strictEqual(calls.saved, 0);
  assert.deepStrictEqual(cu.coreArgs(), []);
  assert.strictEqual(v.driver.size, 31_316_916, 'the size shown before asking');
  assert.match(v.driver.url, /^https:\/\/github\.com\/trycua\/cua\/releases\/download\/cua-driver-rs-v0\.34\.0\//);
  assert.ok(v.limits.length >= 5);
  assert.deepStrictEqual(v.agents.map((a) => [a.agent, a.installed]), [['claude', false], ['codex', false], ['cursor', false]]);

  // Off always works, and restarts the core without the flag.
  settings.computerUse = true;
  const off = await cu.setOn(false);
  assert.strictEqual(off.on, false);
  assert.strictEqual(settings.computerUse, false);
  assert.strictEqual(calls.restarts, 1);
  assert.strictEqual(calls.saved, 1);
});

test('with a driver that checks out, on restarts the core with --computer-use', async () => {
  const cuModule = require('../app/computer-use');
  const realStatus = cuModule.driverStatus;
  cuModule.driverStatus = async () => ({ verified: true, missing: false, problem: null });
  try {
    const { cu, settings, calls } = make();
    const v = await cu.setOn(true);
    assert.strictEqual(v.on, true);
    assert.strictEqual(settings.computerUse, true);
    assert.strictEqual(calls.restarts, 1);
    assert.deepStrictEqual(cu.coreArgs(), ['--computer-use']);
    // At start-up, with it on and the driver fine, the core is restarted once to take the flag.
    const again = make();
    again.settings.computerUse = true;
    await again.cu.init();
    assert.strictEqual(again.calls.restarts, 1);
  } finally {
    cuModule.driverStatus = realStatus;
  }
});

test('Show Me: refused while off; recording drives the indicator and ends in review; saving writes the skill', async () => {
  const { cu, settings, calls, dir } = make();
  const client = fakeClient();
  cu.attach(client);
  assert.throws(() => cu.mainHandlers.skillRecord(), /needs computer use/);
  assert.deepStrictEqual(client.sent, []);

  settings.computerUse = true;
  cu.mainHandlers.skillRecord();
  assert.deepStrictEqual(client.sent, [['showme.start', {}]]);
  client.emit('showme.state', { recording: true });
  assert.strictEqual(calls.shown, 1);
  client.emit('showme.step', { step: { index: 0, step: { kind: 'key', key: 'Enter' } } });
  cu.mainHandlers.skillStop();
  assert.deepStrictEqual(client.sent.at(-1), ['showme.stop', {}]);
  client.emit('showme.state', { recording: false, reason: 'you stopped it in Mewndo', steps: [{ kind: 'key', key: 'Enter' }, { kind: 'type', secret: true }] });
  assert.strictEqual(calls.hidden, 1);
  assert.strictEqual(calls.reviews, 1);
  assert.strictEqual(cu.recording().phase, 'review');
  assert.ok(calls.main.every(([channel]) => channel === 'skills-changed'));

  const saved = await cu.mainHandlers.skillSaveRecording({ name: 'Press enter', description: '', steps: cu.recording().steps });
  assert.strictEqual(saved.id, 'press-enter');
  assert.ok(fs.existsSync(path.join(dir, 'desk', 'skills', 'press-enter.json')), 'in the desk folder, Mewndo\'s own app data');
  assert.strictEqual(cu.recording().phase, 'idle');
  const view = await cu.mainHandlers.skillsView();
  assert.deepStrictEqual(view.skills.map((s) => s.name), ['Press enter']);

  // A core that restarts mid-recording ends it with a reason, not a stuck "Recording".
  cu.mainHandlers.skillRecord();
  client.emit('showme.state', { recording: true });
  client.emit('closed', {});
  assert.strictEqual(cu.recording().phase, 'idle');
  assert.match(cu.recording().reason, /restarted/);
  assert.strictEqual(calls.hidden, 2);

  // The takeover pause shows in Settings, and Resume tells the core.
  client.emit('computer.pause', {});
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(calls.settingsViews.at(-1).paused, true);
  await cu.settingsHandlers.computerResume();
  assert.deepStrictEqual(client.sent.at(-1), ['computer.resume', { sessions: [] }]);
});

test('the handlers main.js adds never replace one of its own', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  const { cu } = make();
  const names = (object) => {
    const start = source.indexOf(`const ${object} = {`);
    assert.ok(start >= 0, object);
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    return new Set([...source.slice(start, end).matchAll(/^ {2}(?:async )?([a-zA-Z]+)(?:\(|:|,)/gm)].map((m) => m[1]));
  };
  const main = names('handlers');
  const settingsOwn = names('settingsHandlers');
  for (const n of Object.keys(cu.mainHandlers)) assert.ok(!main.has(n), n);
  for (const n of Object.keys(cu.settingsHandlers)) assert.ok(!settingsOwn.has(n), n);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
  for (const n of Object.keys(cu.mainHandlers)) assert.ok(preload.includes(`call('${n}')`), `preload.js exposes ${n}`);
  const settingsPreload = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings-preload.js'), 'utf8');
  for (const n of Object.keys(cu.settingsHandlers)) assert.ok(settingsPreload.includes(`call('${n}')`), `settings-preload.js exposes ${n}`);
});
