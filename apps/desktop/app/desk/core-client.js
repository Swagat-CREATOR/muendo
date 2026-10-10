// The app's one connection to mewndo-core's Agent Desk pipe (spec §33.10 Part E step 1, §38.3 core-client.ts).
// One connection for the whole app, kept open: never a process or a connection per message (§33.10 speed rules).
//
// core.json, written by the core in %LOCALAPPDATA%\Mewndo (core/crates/mewndo-core/src/desk.rs), says where the
// pipe is: { pipe, pid, version, protocol }. The first message is always hello {role:"app"}; the core answers
// `pong` with the same id, and from then on the app receives everything the desk publishes.
// Dropped connection: reconnect with a backoff from 100 ms to 2 s. A protocol the app doesn't speak is not
// guessed at: the user is told "Mewndo needs an update" and no messages from it are acted on.
// No Electron here, so tests run it with plain Node.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { VERSION, encodeJson, encodeLane, createReader } = require('./frames');

const NEEDS_UPDATE = 'Mewndo needs an update';
const FIRST_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2_000;

// dir: the desk folder holding core.json. connect(pipe): net.connect by default; tests pass a fake socket.
// schedule/cancel: setTimeout/clearTimeout by default, so tests can see the backoff without waiting.
// onStatus({ state, message }): 'connecting' | 'connected' | 'retrying' | 'needs-update'.
function createCoreClient({
  dir, log, connect = net.connect, schedule = setTimeout, cancel = clearTimeout, onStatus = () => {},
  helloWithinMs = 5_000, firstBackoffMs = FIRST_BACKOFF_MS, maxBackoffMs = MAX_BACKOFF_MS,
} = {}) {
  const listeners = new Map(); // message type -> Set(fn); 'lane' for binary frames, '*' for every message
  let socket = null;
  let reader = null;
  let hello = null; // the id of the hello waiting for its pong
  let helloTimer = null;
  let retryTimer = null;
  let backoff = firstBackoffMs;
  let stopped = true;
  let seq = 0;
  // Nothing is happening until start() is called, and saying 'connecting' before then would make the first real
  // 'connecting' invisible to onStatus (set() drops a status that hasn't changed).
  let status = { state: 'stopped', message: null };

  const id = () => `${Date.now().toString(36)}-${++seq}`;
  function set(state, message = null) {
    if (status.state === state && status.message === message) return;
    status = { state, message };
    onStatus(status);
  }

  function emit(type, event) {
    for (const fn of listeners.get(type) ?? []) fn(event);
    if (type !== '*') for (const fn of listeners.get('*') ?? []) fn(event);
  }

  // core.json is written to a temp file and renamed into place, so a half-written file is never read. A missing
  // file only means the core isn't up yet: that is a retry, not an error.
  function readCoreJson() {
    const file = path.join(dir, 'core.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log?.warn?.(`could not read ${file}`, e.message);
      return null;
    }
  }

  function retry() {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    if (status.state !== 'needs-update') set('retrying');
    retryTimer = schedule(open, wait);
    retryTimer?.unref?.();
    emit('retry', { type: 'retry', afterMs: wait });
  }

  function drop(why) {
    cancel(helloTimer);
    helloTimer = null;
    hello = null;
    const s = socket;
    socket = null;
    reader = null;
    if (s) {
      s.removeAllListeners();
      s.destroy();
      emit('closed', { type: 'closed', why });
    }
    retry();
  }

  function open() {
    retryTimer = null;
    if (stopped) return;
    const core = readCoreJson();
    if (!core?.pipe) return retry();
    // The core says which protocol it speaks before a single message is exchanged: an app that can't speak it
    // says so instead of talking nonsense to it.
    if (core.protocol !== VERSION) {
      set('needs-update', `${NEEDS_UPDATE}: mewndo-core speaks protocol ${core.protocol}, this app speaks ${VERSION}.`);
      emit('needs-update', { type: 'needs-update', message: status.message, theirs: core.protocol, ours: VERSION });
      return retry();
    }
    set('connecting');
    const s = connect(core.pipe);
    socket = s;
    reader = createReader();
    s.on('connect', () => {
      if (socket !== s) return;
      hello = id();
      write(encodeJson({ v: VERSION, id: hello, type: 'hello', body: { role: 'app' } }), true);
      helloTimer = schedule(() => { log?.warn?.('mewndo-core did not answer hello in time'); drop('no hello'); }, helloWithinMs);
      helloTimer?.unref?.();
    });
    s.on('data', (chunk) => {
      if (socket !== s) return;
      let frames;
      try {
        frames = reader.push(chunk);
      } catch (e) {
        // A bad header: where the next frame starts is unknown, so the connection goes rather than resync blindly.
        log?.warn?.('mewndo-core sent a frame the app could not read', e.message);
        return drop(e.message);
      }
      for (const f of frames) handle(f);
    });
    s.on('error', (e) => { if (socket === s) { log?.warn?.('mewndo-core connection problem', e.message); drop(e.message); } });
    s.on('close', () => { if (socket === s) drop('closed'); });
  }

  function handle(f) {
    if (f.kind === 'lane') return emit('lane', { type: 'lane', lane: f.lane, data: f.data });
    if (f.kind === 'bad') return log?.warn?.('mewndo-core sent a message the app could not read', f.message);
    const { envelope } = f;
    if (envelope.v !== VERSION) {
      set('needs-update', `${NEEDS_UPDATE}: mewndo-core speaks protocol ${envelope.v}, this app speaks ${VERSION}.`);
      emit('needs-update', { type: 'needs-update', message: status.message, theirs: envelope.v, ours: VERSION });
      return drop('protocol mismatch');
    }
    if (hello && envelope.id === hello) {
      cancel(helloTimer);
      helloTimer = null;
      hello = null;
      backoff = firstBackoffMs; // a working connection: the next drop starts the backoff again at 100 ms
      if (envelope.type === 'error') return drop(envelope.body?.message ?? 'the core refused hello');
      set('connected');
      return emit('connected', { type: 'connected' });
    }
    return emit(envelope.type, { type: envelope.type, id: envelope.id, body: envelope.body ?? {} });
  }

  // The core requires hello to be the first frame on a connection and closes the connection if anything else
  // arrives first (core/crates/mewndo-core/src/desk.rs). A socket exists from the moment net.connect returns, and
  // writes to it are queued, so anything sent before the handshake would be queued *ahead* of hello and get the
  // connection killed. So only hello itself may be written before the core has answered it; everything else is
  // refused with false, and the caller says so rather than silently losing the message.
  function write(buffer, duringHello = false) {
    if (!socket || (!duringHello && status.state !== 'connected')) return false;
    socket.write(buffer);
    return true;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      backoff = firstBackoffMs;
      open();
    },
    stop() {
      stopped = true;
      cancel(retryTimer);
      cancel(helloTimer);
      retryTimer = null;
      helloTimer = null;
      const s = socket;
      socket = null;
      reader = null;
      hello = null;
      s?.removeAllListeners();
      s?.destroy();
      set('stopped');
    },
    // on('inbox.card', fn), on('lane', fn), on('connected' | 'closed' | 'retry' | 'needs-update', fn), on('*', fn)
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    // Fire and forget: the core answers with its own message, never a return value. False when nothing is connected.
    send(type, body = {}) {
      return write(encodeJson({ v: VERSION, id: id(), type, body }));
    },
    sendLane(lane, data) {
      return write(encodeLane(lane, data));
    },
    status: () => status,
    connected: () => status.state === 'connected',
  };
}

module.exports = { createCoreClient, NEEDS_UPDATE, FIRST_BACKOFF_MS, MAX_BACKOFF_MS };
