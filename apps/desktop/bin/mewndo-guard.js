#!/usr/bin/env node
// mewndo-guard: Guard (spec §24.2) for agents whose hooks run a command: Codex (PreToolUse) and Cursor (preToolUse,
// beforeShellExecution). Reads the hook's JSON on stdin, asks the running Mewndo (POST /guard), and answers in the
// agent's format on stdout. Mewndo decides allow, deny or ask; the reason is written for the agent to read.
//   node mewndo-guard.js --agent codex|cursor [--verbose]
// If Mewndo isn't running or doesn't answer within 2 s: harmless actions pass; deletes and other destructive
// commands are refused, the same fallback rules Mewndo uses (engine/guard.js), copied here because this script
// runs outside the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DEADLINE_MS = 2000;
const left = () => DEADLINE_MS - performance.now();
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const agent = arg('--agent') === 'cursor' ? 'cursor' : 'codex';
const verbose = process.argv.includes('--verbose');
const DESTRUCTIVE = /(^|[\s;&|(])(rm|rmdir|del|erase|rd|unlink|shred|remove-item|ri|mv|move|move-item)(\s|$)|git\s+(reset\s+--hard|clean|push\s+.*(-f\b|--force|\s\+))|git\s+checkout\s+\.|\*\*\* Delete File:/i;

function dataDir() {
  if (process.env.MEWNDO_DATA_DIR) return process.env.MEWNDO_DATA_DIR;
  const home = os.homedir();
  const base = process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'mewndo', 'data');
}

// Answer and exit. answer: the agent-format JSON from Mewndo, or null (no opinion: go ahead).
function finish(answer, note) {
  if (verbose && note) process.stderr.write(`mewndo-guard: ${note}\n`);
  if (answer && Object.keys(answer).length) process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(0);
}

// Mewndo can't be asked: refuse what could destroy work, let the rest go ahead.
function fallback(input, why) {
  const text = [input.command, input.tool_input?.command, input.tool_input?.patch, input.tool_input?.input].filter((t) => typeof t === 'string').join('\n');
  if (!DESTRUCTIVE.test(text)) return finish(null, `${why}; harmless, so it goes ahead`);
  const reason = "Mewndo couldn't check this action, and it could delete or overwrite work. Ask the user to run it, or try again once Mewndo is running.";
  if (agent === 'cursor') return finish({ permission: 'deny', user_message: `Mewndo: ${reason}`, agent_message: reason }, why);
  process.stderr.write(`Mewndo: ${reason}\n`);
  process.exit(2); // Codex: exit code 2 blocks the tool call, with stderr as the reason
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let text = '';
    const t = setTimeout(() => resolve(text), 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { if (text.length < 4_000_000) text += d; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(text); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(text); });
  });
}

(async () => {
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch { input = {}; }
  setTimeout(() => fallback(input, 'Mewndo did not answer in time'), Math.max(0, left()));
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(dataDir(), 'hook.json'), 'utf8'));
  } catch {
    return fallback(input, 'Mewndo is not set up on this computer (no hook.json)');
  }
  const body = JSON.stringify(input);
  const req = http.request({
    host: '127.0.0.1', port: config.port, path: `/guard?agent=${agent}`, method: 'POST', timeout: Math.max(50, left() - 50),
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-mewndo-token': config.token },
  }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let answer;
      try { answer = JSON.parse(text); } catch { return fallback(input, `Mewndo answered ${res.statusCode} without JSON`); }
      if (res.statusCode !== 200) return fallback(input, `Mewndo answered ${res.statusCode}: ${answer.error}`);
      finish(answer, 'Mewndo answered');
    });
  });
  req.on('timeout', () => { req.destroy(); fallback(input, 'Mewndo did not answer in time'); });
  req.on('error', (e) => fallback(input, `Mewndo is not running or not reachable (${e.code || e.message})`));
  req.end(body);
})();
