// A connection to a mewndo-core that's already running (the app starts it: app/core.js), for the engine. Same
// protocol (core/src/protocol.rs): one JSON message per line. The engine runs in its own process, so it opens its
// own connection to the core's pipe or socket, which the app hands it in MEWNDO_CORE_PIPE. If the core restarts,
// the next request connects again.
const net = require('node:net');

const PROTOCOL_VERSION = 1;

function connectCore(address, { answerWithinMs = 2_000 } = {}) {
  let socket = null;
  let connecting = null;
  let nextId = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const listeners = new Set();

  function failAll(why) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === null && msg.type === 'event') { for (const fn of listeners) fn(msg); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === 'error') p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
    else p.resolve(msg);
  }

  function connect() {
    connecting ??= new Promise((resolve, reject) => {
      const s = net.connect(address);
      s.setEncoding('utf8');
      let buffered = '';
      s.on('data', (d) => {
        buffered += d;
        for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) onLine(buffered.slice(0, i));
      });
      s.once('connect', () => { socket = s; resolve(s); });
      s.unref(); // an idle connection never keeps the engine running; pending requests do (their timers)
      s.on('error', (e) => { if (socket !== s) reject(e); });
      s.on('close', () => {
        if (socket === s) socket = null;
        connecting = null;
        failAll('mewndo-core connection closed');
      });
    }).catch((e) => { connecting = null; throw e; });
    return connecting;
  }

  // Like app/core.js's request: every request has a deadline (`within` for slow work).
  async function request(type, fields = {}, { within = answerWithinMs } = {}) {
    const s = socket ?? await connect();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('mewndo-core did not answer in time')); }, within);
      pending.set(id, { resolve, reject, timer });
      s.write(`${JSON.stringify({ ...fields, v: PROTOCOL_VERSION, id, type })}\n`);
    });
  }

  const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const close = () => { socket?.destroy(); socket = null; };
  return { request, subscribe, close, address };
}

// The engine's core, if the app handed it one: MEWNDO_CORE_PIPE set means restores (and shadow checks) run there.
let shared;
function defaultCore() {
  if (shared === undefined) shared = process.env.MEWNDO_CORE_PIPE ? connectCore(process.env.MEWNDO_CORE_PIPE) : null;
  return shared;
}

module.exports = { connectCore, defaultCore };
