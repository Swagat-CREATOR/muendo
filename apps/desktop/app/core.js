// Starts mewndo-core (the Rust service in core/), checks it is alive and restarts it if it stops, like the engine
// process in main.js. It talks to the core over a named pipe on Windows and a Unix socket elsewhere, one JSON
// message per line (see core/src/protocol.rs). No Electron here, so tests can run it with plain Node.
// The core does no file work yet; protection runs in the engine whatever its state.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;

// binary: the mewndo-core executable. runDir: where the Unix socket goes (the app's data folder).
// logDir: the app's log folder; the core writes mewndo-core.log there. log: the app's log.
// onChange(status): called when the state or message changes (not on every check).
// onEvent(event): a change feed event for a watched folder ({ root, kind, path?, dirs?, message?, at_ms }).
function createCore({
  binary, runDir, logDir, log, onChange = () => {}, onEvent = () => {},
  checkEveryMs = 10_000, answerWithinMs = 2_000, readyWithinMs = 10_000, restartAfterMs = 1_000,
}) {
  // A new pipe name each run, which the core refuses to share: another program can't pose as the core.
  // Unix socket paths must be short (104 bytes on macOS, 108 on Linux): if the data folder's is too long, an
  // unguessable name in the temp folder instead. Either way only this user may connect (the core sets 0600).
  const sock = path.join(runDir, 'mewndo-core.sock');
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\mewndo-core-${process.pid}-${crypto.randomUUID()}`
    : Buffer.byteLength(sock) < 100 ? sock : path.join(os.tmpdir(), `mewndo-core-${crypto.randomUUID()}.sock`);
  let child = null;
  let socket = null;
  let stopping = false;
  let crashes = [];
  let misses = 0;
  let nextId = 0;
  let checkTimer = null;
  let restartTimer = null;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let status = { state: 'starting', message: null, version: null, pid: null, uptimeMs: null };

  function set(patch) {
    const before = status;
    status = { ...status, ...patch };
    if (status.state !== before.state || status.message !== before.message) onChange(status);
  }

  function failAll(why) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
  }

  // Every request has a deadline: a core that doesn't answer counts as not responding. fields: the request's own
  // fields (see core/src/protocol.rs). within: a longer deadline for slow work such as storing a batch of files.
  function request(type, fields = {}, { within = answerWithinMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error('mewndo-core is not connected'));
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('mewndo-core did not answer in time')); }, within);
      pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ ...fields, v: PROTOCOL_VERSION, id, type })}\n`);
    });
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return log.warn('mewndo-core sent a line that is not JSON', line); }
    if (msg.id === null && msg.type === 'event' && msg.v === PROTOCOL_VERSION) return onEvent(msg);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.v !== PROTOCOL_VERSION) p.reject(new Error(`mewndo-core speaks protocol ${msg.v}, the app speaks ${PROTOCOL_VERSION}`));
    else if (msg.type === 'error') p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
    else p.resolve(msg);
  }

  async function check() {
    try {
      const s = await request('status');
      misses = 0;
      set({ state: 'running', message: null, version: s.version, pid: s.pid, uptimeMs: s.uptime_ms });
    } catch (e) {
      if (!child || stopping) return;
      misses++;
      set({ state: 'not-responding', message: e.message });
      // Three missed checks in a row: stop it, and the exit handler starts a fresh one.
      if (misses >= 3) { log.error('mewndo-core stopped answering; restarting it'); child.kill('SIGKILL'); }
    }
  }

  function connect(proc) {
    const s = net.connect(address);
    s.setEncoding('utf8');
    let buffered = '';
    s.on('data', (d) => {
      buffered += d;
      for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) onLine(buffered.slice(0, i));
    });
    s.on('connect', () => {
      if (child !== proc) return s.destroy();
      socket = s;
      check();
      checkTimer = setInterval(check, checkEveryMs);
      checkTimer.unref();
    });
    s.on('error', (e) => log.warn('mewndo-core connection problem', e.message));
    s.on('close', () => { if (socket === s) socket = null; failAll('mewndo-core connection closed'); });
  }

  function start() {
    restartTimer = null;
    misses = 0;
    set({ state: 'starting', message: null, pid: null, uptimeMs: null });
    const proc = spawn(binary, ['--socket', address, '--log-dir', logDir], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    const readyTimer = setTimeout(() => {
      log.error('mewndo-core did not start in time; restarting it');
      proc.kill('SIGKILL');
    }, readyWithinMs);
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (out === null) return;
      out += d;
      if (out.includes('ready\n')) { out = null; clearTimeout(readyTimer); connect(proc); }
    });
    // Its own problems are in mewndo-core.log; anything on stderr (a crash, bad arguments) goes in the app's log.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => log.warn('mewndo-core', d.trim()));
    proc.stdin.on('error', () => {}); // writing to a core that just died
    proc.on('error', (e) => {
      clearTimeout(readyTimer);
      if (child !== proc) return;
      child = null;
      if (e.code === 'ENOENT') {
        log.warn('mewndo-core is missing', binary);
        set({ state: 'missing', message: `mewndo-core was not found at ${binary}.` });
      } else {
        exited(`could not be started: ${e.message}`);
      }
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      if (child !== proc) return;
      child = null;
      exited(`stopped (exit code ${code ?? signal})`);
    });
  }

  // Three stops within a minute: give up and say so, like the engine.
  function exited(what) {
    clearInterval(checkTimer);
    socket?.destroy();
    socket = null;
    failAll('mewndo-core stopped');
    if (stopping) return set({ state: 'stopped', message: null, pid: null });
    log.error(`mewndo-core ${what}`);
    crashes = [...crashes.filter((t) => Date.now() - t < 60_000), Date.now()];
    if (crashes.length >= 3) {
      return set({ state: 'failed', message: `mewndo-core keeps stopping (${what}). Restart Mewndo to try again.`, pid: null });
    }
    set({ state: 'restarting', message: `mewndo-core ${what} and is restarting.`, pid: null });
    restartTimer = setTimeout(start, restartAfterMs);
  }

  // Ask it to stop; closing its stdin also stops it. Never wait more than a few seconds.
  async function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    clearInterval(checkTimer);
    const proc = child;
    if (!proc) return set({ state: 'stopped', message: null });
    const gone = new Promise((resolve) => proc.once('exit', resolve));
    await request('shutdown').catch(() => {});
    proc.stdin.end();
    const kill = setTimeout(() => proc.kill('SIGKILL'), 3_000);
    await gone;
    clearTimeout(kill);
  }

  return { start, stop, status: () => status, request, address };
}

module.exports = { createCore, PROTOCOL_VERSION };
