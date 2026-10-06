// Runs the whole engine in an Electron utility process, so no amount of engine work (scanning, hashing,
// big JSON indexes, pruning) can ever freeze the window. The main process talks to it with messages:
//   main -> engine  { id, method, args }        engine -> main  { id, result } or { id, error, code }
//   engine -> main  { event, args }             (progress, save points, restores, warnings...)
const { createMewndo, HOOK_PORT, planClaudeHooks, installClaudeHooks, planAgentHooks, installAgentHooks, AGENT_HOOKS } = require('../engine');

const port = process.parentPort;
let mewndo = null;
let dataDir = null;

// Engine methods the main process may call. 'journal.X' calls journal X on the folder given as first argument.
const MEWNDO = new Set([
  'unprotect', 'folders', 'pausedUntil', 'pauseProtection', 'resumeProtection', 'storageReport', 'prune', 'agents', 'hookServerProblem',
  'configure', 'config', 'folderSettings', 'setFolderSettings', 'agentList', 'setAgentList', 'saveBrief',
  'brake', 'resumeAgent', 'endAgent', 'braked', 'ticker',
]);
const JOURNAL = new Set(['listSavePoints', 'createSavePoint', 'diffSince', 'planRestore', 'restore', 'listRestores']);

const emit = (event, ...args) => port.postMessage({ event, args });
const log = (level, message, details) => emit('log', level, message, details);

// An unexpected error leaves the engine in an unknown state: log it and exit, and the app starts a fresh engine,
// which finishes any interrupted restore and catches up on changes (that's what it's built for).
process.on('uncaughtException', (e) => {
  log('error', 'Unexpected error in the engine; restarting it', e?.stack ?? String(e));
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (e) => log('error', 'Unhandled promise rejection in the engine', e?.stack ?? String(e)));

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
    dataDir = options.dataDir;
    // The app turns on agent awareness (checks every 5 s, a save point every 10 min while agents run) and the
    // exact-save-point server for agent hooks.
    mewndo = createMewndo({ ...options, agents: { intervalMs: 5000, saveEveryMs: 10 * 60 * 1000 }, hookServer: { port: HOOK_PORT } });
    mewndo.on('progress', (root, p) => throttled('progress', root, p, 150));
    mewndo.on('change', (root, c) => throttled('change', root, c, 1000));
    for (const event of ['savepoint', 'restored', 'retry', 'burst']) mewndo.on(event, (root, payload) => emit(event, root, payload));
    for (const event of ['drift', 'braked', 'resumed']) mewndo.on(event, (payload) => emit(event, payload));
    mewndo.on('drift', (d) => log('warn', `Drift: ${d.reason} (${d.action})`, d));
    for (const event of ['warning', 'resolved', 'folders-changed', 'pruned', 'agents-changed']) mewndo.on(event, (payload) => emit(event, payload ?? null));
    mewndo.on('restored', (root, r) => log('info', `Restore ${r.verified ? 'verified' : 'NOT verified'} in ${root}`, { written: r.counts.written, trashed: r.counts.trashed, failures: r.failures.length }));
    mewndo.on('savepoint', (root, sp) => log('info', `Save point (${sp.trigger}) in ${root}: ${sp.label}`, sp.agent ? { agent: sp.agent } : undefined));
    mewndo.on('agents-changed', (list) => log('info', `AI agents running: ${list.map((a) => a.name).join(', ') || 'none'}`));
    mewndo.on('shadow', (r) => (r.count
      ? log('warn', `Shadow mode: the engines differ on ${r.count} item(s) in ${r.folder}`, r.differences)
      : log('info', `Shadow mode: both engines agree on ${r.folder}`)));
    mewndo.on('guard', (g) => g.verdict.decision !== 'allow' && emit('guard', g)); // the bar's drift card
    mewndo.on('guard', (g) => g.verdict.decision !== 'allow'
      && log('info', `Guard: ${g.verdict.decision} for ${g.agent} (${g.verdict.rule})`, { folder: g.folder, action: g.action, reason: g.verdict.reason }));
    mewndo.on('recovered', (r) => log('warn', 'Checked recent file versions after an unclean shutdown', r));
    mewndo.on('pruned', (r) => r.pruned?.length && log('info', `Cleanup removed ${r.pruned.length} save points`, { removedObjects: r.removedObjects, usedBytes: r.usedBytes }));
    await mewndo.start();
  },

  stop: () => mewndo?.stop(),

  // What installing the Claude Code hooks would add (shown to the user first), and installing them.
  async claudeHooksPlan() {
    const { merged, ...plan } = await planClaudeHooks({ dataDir });
    return plan;
  },
  // The same for Codex and Cursor (agent-hooks.js).
  async agentHooksPlan(agent) {
    if (!AGENT_HOOKS.includes(agent)) throw new Error('unknown agent');
    const { merged, ...plan } = await planAgentHooks(agent);
    return plan;
  },
  async agentHooksInstall(agent) {
    if (!AGENT_HOOKS.includes(agent)) throw new Error('unknown agent');
    const { merged, ...result } = await installAgentHooks(agent);
    return result;
  },
  async claudeHooksInstall() {
    const { merged, ...result } = await installClaudeHooks({ dataDir });
    return result;
  },

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
    if (!e.code) log('warn', `Engine call ${method} failed`, e.stack ?? e.message);
    port.postMessage({ id, error: e.message, code: e.code });
  }
});
