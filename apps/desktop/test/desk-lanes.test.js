// Lanes in the app (app/desk/lanes.js, and its wiring in app/desk/desk.js): the lane list kept from the core's
// lane.opened and lane.closed, what the lanes window's actions send to the core, and the bytes passed through to the
// window. Driven by a fake core client, like desk.test.js; the core side is tested in Rust (desk.rs, desk_lanes.rs).
const { test } = require('node:test');
const assert = require('node:assert');
const { createLanes, AGENTS } = require('../app/desk/lanes');
const { createDesk } = require('../app/desk/desk');

function fakeClient({ connected = true } = {}) {
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
    lane(lane, data) { for (const fn of listeners.get('lane') ?? []) fn({ type: 'lane', lane, data }); },
    send(type, body) { this.sent.push([type, body]); return connected; },
    sendLane(lane, data) { this.typed.push([lane, Buffer.from(data).toString()]); return connected; },
    connected: () => connected,
    start() {},
    stop() {},
  };
}

function fakeUi() {
  return {
    sentTo: [],
    opened: null,
    send(name, channel, payload) { this.sentTo.push([name, channel, payload]); },
    showLanes(id) { this.opened = id; },
    last(channel) { return this.sentTo.filter(([n, c]) => n === 'lanes' && c === channel).at(-1)?.[2] ?? null; },
  };
}

const opened = (body = {}) => ({
  type: 'lane.opened',
  body: { lane_id: '01L1', program: 'claude', cwd: 'C:\\work\\shop', pid: 4242, rows: 30, cols: 120, running: true, exit_code: null, ...body },
});

test('the lane list follows lane.opened and lane.closed', () => {
  let t = 0;
  const lanes = createLanes({ client: fakeClient(), now: () => ++t });
  assert.strictEqual(lanes.apply({ type: 'inbox.card', body: {} }), null, 'not a lane message');
  const lane = lanes.apply(opened());
  assert.deepStrictEqual(lane, {
    laneId: '01L1', program: 'claude', cwd: 'C:\\work\\shop', pid: 4242, rows: 30, cols: 120,
    running: true, exitCode: null, bytesOut: 0, lastOutputAt: null,
  });
  lanes.apply(opened({ lane_id: '01L0', program: 'codex' }));
  assert.deepStrictEqual(lanes.list().map((l) => l.laneId), ['01L0', '01L1'], 'oldest lane first (ULIDs sort by time)');

  assert.strictEqual(lanes.output('01L1', Buffer.from('hello')).bytesOut, 5);
  assert.strictEqual(lanes.output('nope', Buffer.from('x')), null);
  // lane.opened again (a replay finished, or a reconnect) keeps the output count.
  assert.strictEqual(lanes.apply(opened()).bytesOut, 5);

  // The agent ended: the lane stays, so its last output can be read.
  const ended = lanes.apply({ type: 'lane.closed', body: { lane_id: '01L1', exit_code: 7, removed: false } });
  assert.deepStrictEqual([ended.running, ended.exitCode, ended.removed], [false, 7, false]);
  assert.strictEqual(lanes.count(), 2);
  // Closed for good: gone.
  assert.strictEqual(lanes.apply({ type: 'lane.closed', body: { lane_id: '01L1', exit_code: 7, removed: true } }).removed, true);
  assert.deepStrictEqual(lanes.list().map((l) => l.laneId), ['01L0']);
  assert.strictEqual(lanes.apply({ type: 'lane.closed', body: { lane_id: '01L1' } }), null);
  lanes.forget();
  assert.strictEqual(lanes.count(), 0);
});

test('what each action sends to the core, and what it refuses', () => {
  const client = fakeClient();
  const lanes = createLanes({ client });
  assert.deepStrictEqual(AGENTS, ['claude', 'codex', 'cursor-agent']);
  assert.strictEqual(lanes.start({ program: 'powershell', cwd: 'C:\\work' }), false, 'only the agents');
  assert.strictEqual(lanes.start({ program: 'claude' }), false, 'and only in a folder');
  assert.strictEqual(lanes.start({ program: 'claude', cwd: 'C:\\work\\shop', args: ['--continue'] }), true);
  assert.strictEqual(lanes.reply('01L1', 'hi'), false, 'a lane the core has not reported yet');
  lanes.apply(opened());

  assert.strictEqual(lanes.reply('01L1', 'yes, carry on'), true);
  assert.strictEqual(lanes.reply('01L1', ''), false);
  assert.strictEqual(lanes.brake('01L1'), true);
  assert.strictEqual(lanes.resize('01L1', 40.4, 100), true);
  assert.strictEqual(lanes.resize('01L1', 40, 100), true, 'the same size again');
  assert.strictEqual(lanes.resize('01L1', 0, 99999), true, 'clamped, not refused');
  assert.strictEqual(lanes.type('01L1', Buffer.from('\x1b[A')), true);
  assert.strictEqual(lanes.attach('01L1'), true);
  assert.strictEqual(lanes.close('01L1'), true);
  assert.deepStrictEqual(client.sent, [
    ['lane.open', { program: 'claude', cwd: 'C:\\work\\shop', args: ['--continue'], env: [] }],
    ['lane.reply', { lane_id: '01L1', text: 'yes, carry on' }],
    ['lane.brake', { lane_id: '01L1' }],
    ['lane.resize', { lane_id: '01L1', rows: 40, cols: 100 }],
    ['lane.resize', { lane_id: '01L1', rows: 2, cols: 1000 }],
    ['lane.attach', { lane_id: '01L1' }],
    ['lane.close', { lane_id: '01L1' }],
  ]);
  assert.deepStrictEqual(client.typed, [['01L1', '\x1b[A']], 'keystrokes go as a lane frame, as typed');

  const offline = createLanes({ client: fakeClient({ connected: false }) });
  offline.apply(opened());
  assert.strictEqual(offline.reply('01L1', 'hi'), false, 'not connected: the caller is told');
});

test('the desk passes lanes to the lanes window and its actions to the core', () => {
  const client = fakeClient();
  const ui = fakeUi();
  const problems = [];
  const desk = createDesk({ client, ui, problem: (m) => problems.push(m) });
  desk.start();

  client.emit('lane.opened', opened().body);
  client.emit('agent.status', { agent_id: 'a1', kind: 'claude-code', name: 'Claude Code', status: 'working', lane_id: '01L1' });
  assert.deepStrictEqual(ui.last('lanes:state').lanes.map((l) => [l.laneId, l.program, l.running]), [['01L1', 'claude', true]]);
  assert.strictEqual(desk.laneView().lanes[0].agentId, 'a1', 'the agent running in it, once agent.status names the lane');
  assert.deepStrictEqual(desk.lanes(), [{ laneId: '01L1', agentId: 'a1' }], 'a running lane is a Talk target');

  client.lane('01L1', Buffer.from('> ready'));
  assert.deepStrictEqual(ui.last('lanes:data'), { laneId: '01L1', data: Buffer.from('> ready') });

  assert.strictEqual(desk.handlers.lane('open', '01L1'), true);
  assert.strictEqual(ui.opened, '01L1');
  desk.handlers.lane('reply', '01L1', 'run the tests');
  desk.handlers.lane('brake', '01L1');
  desk.handlers.lane('resize', '01L1', { rows: 50, cols: 160 });
  desk.handlers.lane('type', '01L1', 'q');
  desk.handlers.lane('close', '01L1');
  assert.deepStrictEqual(client.sent.map(([type]) => type), ['lane.attach', 'lane.reply', 'lane.brake', 'lane.resize', 'lane.close']);
  assert.strictEqual(desk.handlers.lane('launch', '01L1'), false, 'an unknown action does nothing');

  assert.strictEqual(desk.handlers.lane('start', null, { program: 'bash', cwd: '/tmp' }), false);
  assert.match(problems[0], /Claude, Codex or Cursor/);
  assert.strictEqual(desk.handlers.lane('start', null, { program: 'codex', cwd: 'C:\\work\\shop' }), true);

  // The agent ended, then the lane was closed: no longer a Talk target, then gone.
  client.emit('lane.closed', { lane_id: '01L1', exit_code: 0, removed: false });
  assert.strictEqual(ui.last('lanes:state').lanes[0].running, false);
  client.emit('lane.closed', { lane_id: '01L1', exit_code: 0, removed: true });
  assert.deepStrictEqual(ui.last('lanes:state').lanes, []);
  assert.deepStrictEqual(desk.lanes(), [], 'and the agent.status link went with it');

  // A dropped connection: the app forgets, and the core re-sends lane.opened on reconnect.
  client.emit('lane.opened', opened({ lane_id: '01L2' }).body);
  client.emit('closed', { why: 'closed' });
  assert.deepStrictEqual(ui.last('lanes:state').lanes, []);
  desk.stop();
});
