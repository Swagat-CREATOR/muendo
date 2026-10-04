// Runs the whole engine in an Electron utility process, so no amount of engine work (scanning, hashing,
// big JSON indexes, pruning) can ever freeze the window. The main process talks to it with messages:
//   main -> engine  { id, method, args }        engine -> main  { id, result } or { id, error, code }
//   engine -> main  { event, args }             (progress, save points, restores, warnings...)
const { createMewndo } = require('../engine');

const port = process.parentPort;
let mewndo = null;

// Engine methods the main process may call. 'journal.X' calls journal X on the folder given as first argument.
const MEWNDO = new Set(['unprotect', 'folders', 'pausedUntil', 'pauseProtection', 'resumeProtection', 'storageReport', 'prune']);
const JOURNAL = new Set(['listSavePoints', 'createSavePoint', 'diffSince', 'planRestore', 'restore', 'listRestores']);

const emit = (event, ...args) => port.postMessage({ event, args });

// Scans report progress for every file and changes arrive in bursts. Send a few a second per folder,
// but always send phase changes, so the window shows each phase.
const lastSent = new Map();
function throttled(event, root, payload, everyMs) {
  const key = `${event}:${root}`;
  const last = lastSent.get(key);
  const now = Date.now();
  if (last && now - last.at < everyMs && last.phase === payload?.phase && payload?.phase !== 'done') return;
  lastSent.set(key, { at: now, phase: payload?.phase });
  emit(event, root, payload);
}

const methods = {
  ping: () => 'pong',

  async start(options) {
    mewndo = createMewndo(options);
    mewndo.on('progress', (root, p) => throttled('progress', root, p, 150));
    mewndo.on('change', (root, c) => throttled('change', root, c, 1000));
    for (const event of ['savepoint', 'restored', 'retry']) mewndo.on(event, (root, payload) => emit(event, root, payload));
    for (const event of ['warning', 'folders-changed', 'pruned']) mewndo.on(event, (payload) => emit(event, payload ?? null));
    await mewndo.start();
  },

  stop: () => mewndo?.stop(),

  // The journal itself can't cross processes; the main process only needs to know it was accepted.
  async protect(root, options) {
    await mewndo.protect(root, options);
    return null;
  },
};

port.on('message', async ({ data }) => {
  const { id, method, args = [] } = data;
  try {
    let result;
    if (methods[method]) {
      result = await methods[method](...args);
    } else if (!mewndo) {
      throw new Error('The engine has not started yet.');
    } else if (MEWNDO.has(method)) {
      result = await mewndo[method](...args);
    } else if (method.startsWith('journal.') && JOURNAL.has(method.slice(8))) {
      const [root, ...rest] = args;
      result = await mewndo.journalFor(root)[method.slice(8)](...rest);
    } else {
      throw new Error(`unknown engine method: ${method}`);
    }
    port.postMessage({ id, result: result ?? null });
  } catch (e) {
    port.postMessage({ id, error: e.message, code: e.code });
  }
});
