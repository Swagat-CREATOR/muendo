#!/usr/bin/env node
// mewndo-savepoint: asks a running Mewndo for a save point. AI agent hooks call it (Claude Code: at session start
// and before every Bash command). It must never get in the agent's way: it always exits successfully within
// a second, prints nothing to stdout (Claude Code would show it to the model) except a Continue card Mewndo has
// waiting for a new session (spec §24.5), and does nothing when Mewndo isn't running. --verbose explains what happened on stderr; --agent "Name" for agents other than Claude Code.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// The time budget counts from when this process started (performance.now() is 0 then), not from when this code
// began running: on Windows, Node alone takes about a quarter of a second to start.
// 700 leaves room for Windows creating the process under load (measured up to ~180 ms) within the 1 s promise.
// Mewndo answers in milliseconds: hook save points rely on what its watcher already saw (see quick save points).
// After a Resume, Mewndo marks that a Continue card is waiting: then up to 4 s (the hook's timeout is 5), since
// the user just clicked Resume and a card that misses the deadline is lost (spec §24.5 allows 2 to 5 s).
const DEADLINE_MS = fs.existsSync(path.join(dataDir(), 'continue-pending')) ? 4000 : 700; // whatever happens, exit by then
const left = () => DEADLINE_MS - performance.now();
const verbose = process.argv.includes('--verbose');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function done(message) {
  if (verbose && message) process.stderr.write(`mewndo-savepoint: ${message} (${Math.round(performance.now())} ms after start)\n`);
  process.exit(0);
}
setTimeout(() => done('gave up waiting; Mewndo keeps working on it'), Math.max(0, left()));
process.on('uncaughtException', (e) => done(`error: ${e.message}`));

// Mewndo's data folder: the same place the app uses (Electron's userData folder for the app "mewndo").
function dataDir() {
  if (process.env.MEWNDO_DATA_DIR) return process.env.MEWNDO_DATA_DIR;
  if (process.env.MEWNDO_USER_DATA) return path.join(process.env.MEWNDO_USER_DATA, 'data');
  const home = os.homedir();
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'mewndo', 'data');
}

// The hook's JSON on stdin (cwd, hook_event_name, tool_input.command, session_id). Never wait long for it.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    const t = setTimeout(() => resolve(text), Math.max(0, Math.min(250, left() - 300)));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (text.length < 1_000_000) text += d; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(text); });
  });
}

(async () => {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(dataDir(), 'hook.json'), 'utf8'));
  } catch {
    return done('Mewndo is not set up on this computer (no hook.json)');
  }
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  const body = JSON.stringify({
    agent: arg('--agent') || 'Claude Code',
    event: input.hook_event_name || arg('--event') || '',
    cwd: input.cwd || process.cwd(),
    command: input.tool_input?.command || '',
    sessionId: input.session_id || '',
  });
  const req = http.request({
    host: '127.0.0.1', port: config.port, path: '/savepoint', method: 'POST',
    timeout: Math.max(50, left() - 60),
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mewndo-token': config.token },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let card;
      try { card = JSON.parse(text).additionalContext; } catch { card = undefined; }
      if (typeof card === 'string' && card) { // synchronous: process.exit doesn't wait for a Windows pipe
        fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: card } }));
      }
      done(`Mewndo answered ${res.statusCode}: ${text}`);
    });
  });
  req.on('timeout', () => { req.destroy(); done('Mewndo is still making the save point; not waiting for it'); });
  req.on('error', (e) => done(`Mewndo is not running or not reachable (${e.code || e.message})`));
  req.end(body);
})();
