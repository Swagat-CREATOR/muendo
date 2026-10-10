// The app's one connection to the Agent Desk pipe (app/desk/core-client.js), with a fake socket and a fake clock
// so the backoff is checked without waiting (spec §33.10 Part E step 1).
//   core.json says where the pipe is · the first message is hello {role:"app"} · a dropped connection is retried
//   with a backoff from 100 ms to 2 s · a protocol the app can't speak is reported, never guessed at.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCoreClient, NEEDS_UPDATE, FIRST_BACKOFF_MS, MAX_BACKOFF_MS } = require('../app/desk/core-client');
const { VERSION, encodeJson, encodeLane, HEADER } = require('../app/desk/frames');
const { tempDir } = require('./helpers');

// A socket that records what the app wrote and lets the test play the core's side.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.written = [];
    this.destroyed = false;
  }

  write(buffer) { this.written.push(Buffer.from(buffer)); return true; }

  destroy() { this.destroyed = true; }

  // What the app sent, as decoded envelopes.
  sent() {
    return this.written.map((b) => JSON.parse(b.subarray(HEADER).toString('utf8')));
  }

  // The core answering: `send` puts whole frames on the wire, `raw` puts arbitrary bytes on it.
  send(...envelopes) { this.raw(Buffer.concat(envelopes.map((e) => encodeJson(e)))); }

  raw(bytes) { this.emit('data', Buffer.from(bytes)); }
}

// A clock the test drives by hand: every schedule() is recorded, and run() fires the ones that are due.
function fakeClock() {
  const timers = [];
  let seq = 0;
  return {
    waits: [],
    schedule(fn, ms) {
      this.waits.push(ms);
      const handle = { id: ++seq, fn, ms };
      timers.push(handle);
      return handle;
    },
    cancel(handle) {
      const i = timers.indexOf(handle);
      if (i >= 0) timers.splice(i, 1);
    },
    // Fire every pending timer once, oldest first.
    run() {
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
      return due.length;
    },
  };
}

// dir with a core.json in it. protocol defaults to the one this app speaks.
function deskDir({ pipe = 'test-pipe', protocol = VERSION, write = true } = {}) {
  const dir = tempDir();
  if (write) fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({ pipe, pid: 1, version: '0.1.0', protocol }));
  return dir;
}

function quietLog() {
  const lines = [];
  const add = (level) => (message, details) => lines.push(`${level} ${message} ${details ?? ''}`.trim());
  return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR') };
}

// A started client with a fake socket and a fake clock. opened: a socket per connect() call.
function start(options = {}) {
  const clock = fakeClock();
  const log = quietLog();
  const opened = [];
  const statuses = [];
  const client = createCoreClient({
    dir: options.dir ?? deskDir(),
    log,
    connect: () => { const s = new FakeSocket(); opened.push(s); return s; },
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (h) => clock.cancel(h),
    onStatus: (s) => statuses.push({ ...s }),
    ...options,
  });
  client.start();
  return { client, clock, log, opened, statuses, socket: () => opened.at(-1) };
}

// Connect the newest socket and let the core answer its hello, so the client reaches 'connected'.
function handshake(h) {
  const s = h.socket();
  s.emit('connect');
  const hello = s.sent().at(-1);
  s.send({ v: VERSION, id: hello.id, type: 'pong', body: {} });
  return s;
}

test('hello {role:"app"} is the first message, and the core\'s answer to it means connected', () => {
  const h = start();
  assert.strictEqual(h.opened.length, 1);
  const s = h.socket();
  assert.deepStrictEqual(s.sent(), [], 'nothing is written before the socket connects');
  s.emit('connect');
  const [hello] = s.sent();
  assert.strictEqual(hello.type, 'hello');
  assert.strictEqual(hello.v, VERSION);
  assert.deepStrictEqual(hello.body, { role: 'app' });
  assert.ok(hello.id, 'hello carries an id, so its answer can be recognised');
  assert.strictEqual(h.client.connected(), false, 'not connected until the core answers');
  // The core answers with the same id (core/crates/mewndo-core/src/desk.rs sends Pong).
  s.send({ v: VERSION, id: hello.id, type: 'pong', body: {} });
  assert.strictEqual(h.client.connected(), true);
  assert.deepStrictEqual(h.statuses.map((x) => x.state), ['connecting', 'connected']);
  h.client.stop();
});

test('a core that never answers hello is dropped and retried, not waited on for ever', () => {
  const h = start({ helloWithinMs: 5_000 });
  h.socket().emit('connect');
  assert.deepStrictEqual(h.clock.waits, [5_000], 'the hello deadline');
  h.clock.run(); // the deadline fires
  assert.ok(h.socket().destroyed);
  assert.ok(h.log.lines.some((l) => /did not answer hello in time/.test(l)));
  assert.strictEqual(h.clock.waits.at(-1), FIRST_BACKOFF_MS);
  h.client.stop();
});

test('the backoff schedule: 100 ms doubling to a 2 s ceiling, and back to 100 ms once a connection works', () => {
  const h = start();
  const drop = () => h.socket().emit('close');
  // Eight drops in a row. Each one waits twice as long as the last, up to the 2 s ceiling, and then stays there.
  for (let i = 0; i < 8; i++) {
    drop();
    h.clock.run(); // the retry timer fires and opens a new socket
  }
  assert.deepStrictEqual(h.clock.waits, [100, 200, 400, 800, 1600, 2000, 2000, 2000]);
  assert.strictEqual(FIRST_BACKOFF_MS, 100);
  assert.strictEqual(MAX_BACKOFF_MS, 2_000);
  // A connection that works resets it: the next drop waits 100 ms again, not 2 s.
  handshake(h);
  h.clock.waits.length = 0;
  drop();
  assert.deepStrictEqual(h.clock.waits, [100]);
  h.client.stop();
});

test('a retry event carries how long the wait is, so the UI can say "retrying in 2 s"', () => {
  const h = start();
  const retries = [];
  h.client.on('retry', (e) => retries.push(e));
  h.socket().emit('close');
  h.clock.run();
  h.socket().emit('close');
  assert.deepStrictEqual(retries, [{ type: 'retry', afterMs: 100 }, { type: 'retry', afterMs: 200 }]);
  // The status tracks it: trying, waiting, trying again. Nothing is reported before start(), and a status that
  // hasn't changed is not reported twice.
  assert.deepStrictEqual(h.statuses.map((x) => x.state), ['connecting', 'retrying', 'connecting', 'retrying']);
  h.client.stop();
});

test('a missing core.json is a retry, not an error: the core simply is not up yet', () => {
  const dir = deskDir({ write: false });
  const h = start({ dir });
  assert.deepStrictEqual(h.opened, [], 'nothing is connected to');
  assert.deepStrictEqual(h.clock.waits, [FIRST_BACKOFF_MS]);
  assert.deepStrictEqual(h.log.lines, [], 'a missing file is not worth a warning');
  // Once the core writes it, the next retry connects.
  fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({ pipe: 'p', pid: 1, protocol: VERSION }));
  h.clock.run();
  assert.strictEqual(h.opened.length, 1);
  h.client.stop();
});

test('a half-written or unreadable core.json is warned about once and retried', () => {
  const dir = deskDir({ write: false });
  fs.writeFileSync(path.join(dir, 'core.json'), '{"pipe":"p"'); // the core writes temp+rename, so this is a bug if seen
  const h = start({ dir });
  assert.deepStrictEqual(h.opened, []);
  assert.ok(h.log.lines.some((l) => /could not read .*core\.json/.test(l)));
  assert.deepStrictEqual(h.clock.waits, [FIRST_BACKOFF_MS]);
  h.client.stop();
});

test('a protocol the app cannot speak: "Mewndo needs an update", and nothing from it is acted on', () => {
  // core.json says the protocol before a single message is exchanged, so a mismatch is caught without talking.
  const h = start({ dir: deskDir({ protocol: 99 }) });
  const message = `${NEEDS_UPDATE}: mewndo-core speaks protocol 99, this app speaks ${VERSION}.`;
  assert.deepStrictEqual(h.statuses.at(-1), { state: 'needs-update', message });
  assert.strictEqual(h.client.status().message, message);
  assert.deepStrictEqual(h.opened, [], 'the pipe is not even opened');
  // It keeps retrying (the user may update the core), but the status stays needs-update, not "retrying".
  h.clock.run();
  assert.strictEqual(h.client.status().state, 'needs-update');
  h.client.stop();
});

test('needs-update is emitted with both versions, so the message can say which is which', () => {
  const h = start({ dir: deskDir({ protocol: 1 }) });
  const events = [];
  h.client.on('needs-update', (e) => events.push(e));
  h.clock.run(); // the next attempt re-reads core.json and reports again
  assert.deepStrictEqual(events, [{
    type: 'needs-update',
    message: `${NEEDS_UPDATE}: mewndo-core speaks protocol 1, this app speaks ${VERSION}.`,
    theirs: 1,
    ours: VERSION,
  }]);
  h.client.stop();
});

test('a message whose envelope version is wrong is reported and the connection dropped', () => {
  // core.json can be right and the messages still wrong (an upgrade mid-run). The envelope is checked too, and
  // the message is the same one the user sees for a core.json mismatch.
  const h = start();
  const events = [];
  h.client.on('needs-update', (e) => events.push(e));
  handshake(h);
  h.socket().send({ v: 3, id: 'x', type: 'inbox.card', body: { id: 'c1' } });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].message, `${NEEDS_UPDATE}: mewndo-core speaks protocol 3, this app speaks ${VERSION}.`);
  assert.deepStrictEqual([events[0].theirs, events[0].ours], [3, VERSION]);
  assert.ok(h.socket().destroyed, 'the connection goes rather than act on messages it may misread');
  assert.strictEqual(h.client.status().state, 'needs-update');
  h.client.stop();
});

test('a card that arrives before hello is answered is still delivered to its listener', () => {
  const h = start();
  const cards = [];
  h.client.on('inbox.card', (e) => cards.push(e));
  const s = h.socket();
  s.emit('connect');
  s.send({ v: VERSION, id: 'other', type: 'inbox.card', body: { id: 'c1', kind: 'permission' } });
  assert.deepStrictEqual(cards, [{ type: 'inbox.card', id: 'other', body: { id: 'c1', kind: 'permission' } }]);
  h.client.stop();
});

test('typed events: a listener per type, a listener for everything, and unsubscribing', () => {
  const h = start();
  handshake(h);
  const cards = [];
  const all = [];
  const off = h.client.on('inbox.card', (e) => cards.push(e.body.id));
  h.client.on('*', (e) => all.push(e.type));
  h.socket().send(
    { v: VERSION, id: '1', type: 'inbox.card', body: { id: 'c1' } },
    { v: VERSION, id: '2', type: 'agent.status', body: { agent_id: 'a' } },
  );
  off();
  h.socket().send({ v: VERSION, id: '3', type: 'inbox.card', body: { id: 'c2' } });
  assert.deepStrictEqual(cards, ['c1'], 'the removed listener stops hearing');
  assert.deepStrictEqual(all, ['inbox.card', 'agent.status', 'inbox.card']);
  // A message with no body at all still arrives with an empty one, so listeners need no guard.
  h.socket().send({ v: VERSION, id: '4', type: 'showme.state' });
  assert.deepStrictEqual(all.at(-1), 'showme.state');
  h.client.stop();
});

test('a frame the app cannot frame at all drops the connection; a payload it cannot read does not', () => {
  const h = start();
  handshake(h);
  const closed = [];
  h.client.on('closed', (e) => closed.push(e.why));
  // A bad payload: logged, connection kept.
  const broken = Buffer.from('not json');
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = 0;
  head.writeUInt32LE(broken.length, 1);
  h.socket().raw(Buffer.concat([head, broken]));
  assert.deepStrictEqual(closed, []);
  assert.ok(h.log.lines.some((l) => /could not read/.test(l)));
  // A bad frame type: the framing itself is lost, so the connection goes and the backoff starts.
  const bad = Buffer.allocUnsafe(HEADER);
  bad[0] = 7;
  bad.writeUInt32LE(0, 1);
  h.socket().raw(bad);
  assert.deepStrictEqual(closed, ['unknown frame type 7']);
  assert.strictEqual(h.clock.waits.at(-1), FIRST_BACKOFF_MS);
  h.client.stop();
});

test('the core refusing hello with an error is a drop, not a connected client', () => {
  const h = start();
  const s = h.socket();
  s.emit('connect');
  const hello = s.sent().at(-1);
  s.send({ v: VERSION, id: hello.id, type: 'error', body: { message: 'hello was already sent' } });
  assert.strictEqual(h.client.connected(), false);
  assert.ok(s.destroyed);
  h.client.stop();
});

test('send and sendLane write framed messages, and say so when nothing is connected', () => {
  const h = start();
  assert.strictEqual(h.client.send('route.request', { text: 'hi' }), false, 'nothing is written before connect');
  handshake(h);
  const s = h.socket();
  assert.strictEqual(h.client.send('inbox.answer', { card_id: 'c1', choice: 0, via: 'key' }), true);
  const answer = s.sent().at(-1);
  assert.strictEqual(answer.type, 'inbox.answer');
  assert.strictEqual(answer.v, VERSION);
  assert.deepStrictEqual(answer.body, { card_id: 'c1', choice: 0, via: 'key' });
  assert.notStrictEqual(answer.id, s.sent()[0].id, 'every message gets its own id');
  // A lane write is a binary frame, not JSON.
  h.client.sendLane('lane-1', Buffer.from('npm test\r'));
  assert.deepStrictEqual(s.written.at(-1), encodeLane('lane-1', Buffer.from('npm test\r')));
  h.client.stop();
  assert.strictEqual(h.client.send('hello', {}), false, 'and nothing after stop');
});

test('stop cancels the pending retry, so a stopped client never reconnects', () => {
  const h = start();
  h.socket().emit('close');
  assert.strictEqual(h.clock.waits.length, 1);
  h.client.stop();
  assert.strictEqual(h.clock.run(), 0, 'the retry timer was cancelled, not left to fire');
  assert.strictEqual(h.client.status().state, 'stopped');
  assert.deepStrictEqual(h.opened.length, 1, 'no further socket was opened');
});

test('a socket error is logged and retried like a close', () => {
  const h = start();
  handshake(h);
  h.socket().emit('error', new Error('EPIPE'));
  assert.ok(h.log.lines.some((l) => /connection problem/.test(l)));
  assert.strictEqual(h.clock.waits.at(-1), FIRST_BACKOFF_MS);
  h.client.stop();
});

test('lane frames arrive as one "lane" event, whatever lane they belong to', () => {
  const h = start();
  handshake(h);
  const lanes = [];
  h.client.on('lane', (e) => lanes.push([e.lane, e.data.toString('utf8')]));
  h.socket().raw(Buffer.concat([encodeLane('a', Buffer.from('one')), encodeLane('b', Buffer.from('two'))]));
  assert.deepStrictEqual(lanes, [['a', 'one'], ['b', 'two']]);
  h.client.stop();
});
