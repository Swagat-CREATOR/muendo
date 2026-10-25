// The lanes window (app/renderer/lanes-model.js, lanes.html, lanes-preload.js) and what joins it to the rest:
// the New lane picker's rules, the tabs, the core's refusal of a lane.open reaching the window, agents in a lane
// being found by the Talk box, and Part H's "Open a lane" offer. The xterm.js drawing itself needs Electron and is
// not run here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../app/renderer/lanes-model');
const { createLanes, programFor, laneOfAgent, defaultFolder, OPEN_DEADLINE_MS } = require('../app/desk/lanes');
const { createDesk } = require('../app/desk/desk');

const APP = path.join(__dirname, '..', 'app');

function fakeClient() {
  const listeners = new Map();
  return {
    sent: [],
    typed: [],
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit(type, body) { for (const fn of listeners.get(type) ?? []) fn({ type, id: 'x', body }); },
    send(type, body) { this.sent.push([type, body]); return true; },
    sendLane(lane, data) { this.typed.push([lane, Buffer.from(data).toString()]); return true; },
    connected: () => true,
    start() {},
    stop() {},
  };
}

function fakeUi() {
  return {
    sentTo: [],
    send(name, channel, payload) { this.sentTo.push([name, channel, payload]); },
    showTalk() {},
    hideTalk() {},
    last(channel) { return this.sentTo.filter(([n, c]) => n === 'lanes' && c === channel).at(-1)?.[2] ?? null; },
  };
}

const lane = (over = {}) => ({ laneId: '01L1', program: 'claude', cwd: 'C:\\work\\shop', running: true, exitCode: null, ...over });

test('tabs are named after the agent, numbered when one runs twice, and say how it ended', () => {
  let m = M.withState(M.empty(), {
    lanes: [lane(), lane({ laneId: '01L2', program: 'codex', cwd: 'C:\\work\\api' }), lane({ laneId: '01L3', running: false, exitCode: 1 }),
      lane({ laneId: '01L4', program: 'C:\\npm\\cursor-agent.cmd', running: false })],
    connected: true,
  });
  assert.deepStrictEqual(M.tabs(m).map((t) => [t.title, t.folder, t.status]), [
    ['Claude Code', 'shop', 'running'],
    ['Codex', 'api', 'running'],
    ['Claude Code 2', 'shop', 'exited (1)'],
    ['Cursor', 'shop', 'exited'],
  ]);
  assert.strictEqual(m.selectedId, '01L1', 'the first lane is shown when nothing was');
  m = M.select(m, '01L3');
  assert.deepStrictEqual(M.tabs(m).filter((t) => t.selected).map((t) => t.laneId), ['01L3']);
  assert.strictEqual(M.select(m, 'nope'), m, 'a lane that is not there is not selected');
  assert.strictEqual(M.exitLine(lane({ running: false, exitCode: 0 })), '\r\n\x1b[2m[Claude Code exited (0)]\x1b[0m\r\n');
});

test('a tab that goes hands over to its neighbour, and no lanes at all opens the picker', () => {
  let m = M.withState(M.empty(), { lanes: [lane(), lane({ laneId: '01L2' }), lane({ laneId: '01L3' })] });
  m = M.select(m, '01L2');
  m = M.withState(m, { lanes: [lane(), lane({ laneId: '01L3' })] });
  assert.strictEqual(m.selectedId, '01L3');
  assert.strictEqual(m.picker.open, false);
  m = M.withState(m, { lanes: [], connected: false });
  assert.deepStrictEqual([m.selectedId, m.picker.open, m.connected], [null, true, false]);
});

test('the picker starts only an agent, in a full folder path, once at a time', () => {
  let m = M.openPicker(M.empty(), { program: 'codex', cwd: 'C:\\work\\shop', folders: ['C:\\work\\shop', 'C:\\Users\\me', 'C:\\work\\shop', ''] });
  assert.deepStrictEqual(m.picker, { open: true, program: 'codex', cwd: 'C:\\work\\shop', folders: ['C:\\work\\shop', 'C:\\Users\\me'] });
  assert.strictEqual(M.openPicker(M.empty(), { program: 'bash' }).picker.program, 'claude', 'an unknown agent falls back to Claude Code');
  assert.deepStrictEqual(M.PICKS.map((p) => [p.label, p.program]), [['Claude Code', 'claude'], ['Codex', 'codex'], ['Cursor', 'cursor-agent'], ['Shell', null]]);
  assert.match(M.PICKS[3].why, /only Claude Code, Codex and Cursor/, 'Shell says why it cannot be picked');

  assert.match(M.start(m, { program: null, cwd: 'C:\\work' }).why, /Pick Claude Code/);
  assert.match(M.start(m, { program: 'codex', cwd: 'shop' }).why, /full path/);
  assert.match(M.start({ ...m, connected: false }, { program: 'codex', cwd: 'C:\\work' }).why, /isn't connected/);
  for (const ok of ['C:\\work', 'd:/work', '\\\\server\\share\\x', '/home/me']) assert.ok(M.isAbsolute(ok), ok);

  const out = M.start(m, { program: 'codex', cwd: '  C:\\work\\shop  ' });
  assert.deepStrictEqual(out.send, ['start', null, { program: 'codex', cwd: 'C:\\work\\shop' }]);
  assert.match(M.start(out.model, { program: 'claude', cwd: 'C:\\x' }).why, /Still starting Codex/, 'never twice while one waits');

  // The lane it asked for arrives: shown, picker closed. A lane someone else opened doesn't count.
  m = M.withState(out.model, { lanes: [lane({ laneId: '01L0', program: 'claude' })] });
  assert.ok(m.waiting);
  m = M.withState(m, { lanes: [lane({ laneId: '01L0' }), lane({ laneId: '01L9', program: 'codex' })] });
  assert.deepStrictEqual([m.waiting, m.selectedId, m.picker.open], [null, '01L9', false]);
});

test("the core's refusal is shown in its own words and the picker stays open", () => {
  const out = M.start(M.openPicker(M.empty(), {}), { program: 'claude', cwd: 'C:\\work' });
  const m = M.withError(out.model, { program: 'claude', cwd: 'C:\\work', message: 'claude is not on PATH' });
  assert.deepStrictEqual([m.waiting, m.picker.open, m.error.message], [null, true, 'claude is not on PATH']);
});

test('resize messages are whole rows and columns, and nothing before the terminal is laid out', () => {
  assert.deepStrictEqual(M.resize('01L1', { rows: 40.7, cols: 132 }), ['resize', '01L1', { rows: 40, cols: 132 }]);
  assert.strictEqual(M.resize('01L1', { rows: 0, cols: 80 }), null);
  assert.strictEqual(M.resize(null, { rows: 30, cols: 80 }), null);
});

test('which program a lane starts for an agent, which lane an agent id names, and the default folder', () => {
  assert.deepStrictEqual(['claude-code', 'Claude Code', 'codex', 'cursor', 'Cursor-Agent', 'gemini', null].map(programFor),
    ['claude', 'claude', 'codex', 'cursor-agent', 'cursor-agent', null, null]);
  assert.deepStrictEqual(['lane:01JLANE7QX', 'codex:s1', '', undefined].map(laneOfAgent), ['01JLANE7QX', null, null, null]);
  const folders = [
    { root: 'C:\\a', lastChangeAt: '2026-10-01T10:00:00Z' },
    { root: 'C:\\b', lastChangeAt: '2026-10-11T09:00:00Z' },
    { root: 'C:\\c', lastChangeAt: null },
  ];
  assert.strictEqual(defaultFolder(folders, 'C:\\Users\\me'), 'C:\\b', 'the protected folder that changed last');
  assert.strictEqual(defaultFolder([{ root: 'C:\\c' }], 'C:\\Users\\me'), 'C:\\c');
  assert.strictEqual(defaultFolder([], 'C:\\Users\\me'), 'C:\\Users\\me', 'home when nothing is protected');
});

test("a lane.open's error is matched to it, and only while it waits", () => {
  let t = 1000;
  const client = fakeClient();
  const lanes = createLanes({ client, now: () => t });
  assert.strictEqual(lanes.failed({ type: 'error', body: { message: 'no lane 01L1' } }), null, 'nothing waits');
  lanes.start({ program: 'claude', cwd: 'C:\\work' });
  lanes.start({ program: 'codex', cwd: 'C:\\work' });
  assert.strictEqual(lanes.failed({ type: 'lane.opened', body: {} }), null);
  assert.deepStrictEqual(lanes.failed({ type: 'error', body: { message: 'claude is not on PATH' } }),
    { program: 'claude', cwd: 'C:\\work', message: 'claude is not on PATH' });
  lanes.apply({ type: 'lane.opened', body: { lane_id: '01L1', program: 'codex', cwd: 'C:\\work', rows: 30, cols: 120 } });
  assert.deepStrictEqual(lanes.waiting(), [], 'its lane.opened answered the other one');

  lanes.start({ program: 'codex', cwd: 'C:\\x' });
  t += OPEN_DEADLINE_MS + 1;
  assert.strictEqual(lanes.failed({ type: 'error', body: { message: 'late' } }), null, 'past its deadline it is not the answer');
  assert.strictEqual(lanes.start({ program: 'codex', cwd: 'C:\\x', args: 'not-a-list' }), true);
  assert.deepStrictEqual(client.sent.at(-1), ['lane.open', { program: 'codex', cwd: 'C:\\x', args: [], env: [] }]);
  assert.strictEqual(lanes.start({ program: 'codex', cwd: { not: 'a path' } }), false);
});

test('the desk sends the core refusal, and a start it could not send, to the lanes window', () => {
  const client = fakeClient();
  const ui = fakeUi();
  const desk = createDesk({ client, ui });
  desk.start();
  desk.handlers.lane('start', null, { program: 'claude', cwd: 'C:\\work' });
  client.emit('error', { message: 'claude is not on PATH' });
  assert.deepStrictEqual(ui.last('lanes:error'), { program: 'claude', cwd: 'C:\\work', message: 'claude is not on PATH' });
  desk.handlers.lane('start', null, { program: 'bash', cwd: 'C:\\work' });
  assert.match(ui.last('lanes:error').message, /Claude, Codex or Cursor/);
  desk.stop();
});

test('Codex or Cursor in a lane is found by the Talk box through its lane: agent id', () => {
  const client = fakeClient();
  const ui = fakeUi();
  const desk = createDesk({ client, ui });
  desk.start();
  client.emit('lane.opened', { lane_id: '01JLANE7QX', program: 'codex', cwd: 'C:\\work', rows: 30, cols: 120, running: true });
  client.emit('agent.status', { agent_id: 'lane:01JLANE7QX', kind: 'codex', name: 'Codex', status: 'idle' });
  assert.deepStrictEqual(desk.lanes(), [{ laneId: '01JLANE7QX', agentId: 'lane:01JLANE7QX' }]);
  assert.strictEqual(desk.laneView().lanes[0].agentId, 'lane:01JLANE7QX');

  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'lane:01JLANE7QX', confidence: 0.9, alternatives: [] });
  assert.deepStrictEqual(client.typed, [['01JLANE7QX', 'run the tests\r']], 'written into the lane, with Enter');

  desk.openTalk();
  desk.handlers.talk('and lint');
  client.emit('route.result', { target: 'Codex', confidence: 0.9, alternatives: [] });
  assert.deepStrictEqual(client.typed.at(-1), ['01JLANE7QX', 'and lint\r'], 'by name too');
  desk.stop();
});

test('"Open a lane" is offered for an agent the Talk box cannot reach, set to that agent', () => {
  const client = fakeClient();
  const offers = [];
  const problems = [];
  const desk = createDesk({ client, ui: fakeUi(), offerLane: (card) => offers.push(card), problem: (m) => problems.push(m) });
  desk.start();
  client.emit('agent.status', { agent_id: 'a2', kind: 'codex', name: 'Codex', status: 'idle' });
  desk.openTalk();
  desk.handlers.talk('run the tests');
  client.emit('route.result', { target: 'a2', confidence: 0.9, alternatives: [] });
  assert.strictEqual(offers.length, 1);
  assert.deepStrictEqual(offers[0].options, ['Open a lane', 'Not now']);
  assert.strictEqual(offers[0].program, 'codex');
  assert.match(offers[0].title, /Can't reach Codex outside a lane\./);
  assert.deepStrictEqual(problems, [], 'asked once, not also as a notification');
  desk.stop();
});

test('the lanes window is sandboxed, loads nothing remote and follows no links', () => {
  const html = fs.readFileSync(path.join(APP, 'renderer', 'lanes.html'), 'utf8');
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(html, /https?:\/\//, 'nothing from the internet');
  for (const src of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(APP, 'renderer', src)), `${src} is shipped`);
  }
  for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js', 'LICENSE-xterm.txt', 'LICENSE-addon-fit.txt']) {
    assert.ok(fs.existsSync(path.join(APP, 'renderer', 'vendor', 'xterm', f)), f);
  }
  const renderer = fs.readFileSync(path.join(APP, 'renderer', 'lanes.js'), 'utf8');
  assert.match(renderer, /linkHandler: \{ activate\(\) \{\} \}/, 'an OSC 8 link click does nothing');
  assert.doesNotMatch(renderer, /window\.open|location\.href|innerHTML/);

  const preload = fs.readFileSync(path.join(APP, 'lanes-preload.js'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('lanes'/);
  assert.doesNotMatch(preload, /require\('(?!electron)/, 'only electron');
  assert.doesNotMatch(preload, /ipcRenderer\.invoke|sendSync|exposeInMainWorld\('(?!lanes)/);

  const windows = fs.readFileSync(path.join(APP, 'desk', 'windows.js'), 'utf8');
  assert.match(windows, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(windows, /lanes\.setContentProtection\(true\)/);
  assert.match(windows, /lanes\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(windows, /lanes\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\)/);
});
