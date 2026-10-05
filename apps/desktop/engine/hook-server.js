// The exact-save-point server: AI agent hooks (bin/mewndo-savepoint.js) ask it for a save point right before
// the agent acts. Localhost only, a fixed port, and every request must carry a random token that only programs
// able to read Mewndo's data folder can know. The port and token are in <data>/hook.json for the script.
const http = require('node:http');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('./store');

const HOOK_PORT = 47821;
const MAX_BODY = 64 * 1024;

// The token survives restarts so hooks keep working; a missing or broken file gets a new one.
async function loadToken(file) {
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (/^[0-9a-f]{64}$/.test(saved.token)) return saved.token;
  } catch { /* first run or unreadable: make a new one */ }
  return crypto.randomBytes(32).toString('hex');
}

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// onSavePoint({ agent, event, cwd, command, sessionId }) -> result, sent back as JSON.
// port 0 picks a free port (tests); hook.json always records the port actually used.
async function startHookServer({ dataDir, port: wantedPort = HOOK_PORT, onSavePoint }) {
  const file = path.join(dataDir, 'hook.json');
  const token = await loadToken(file);
  let port = wantedPort;
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    // A web page can't read the token, but it could still try requests through a hostname that points at this
    // computer (DNS rebinding); only accept the names a local program uses.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return reply(res, 403, { error: 'wrong host' });
    if (req.method !== 'POST' || req.url !== '/savepoint') return reply(res, 404, { error: 'not found' });
    if (!sameToken(req.headers['x-mewndo-token'], token)) return reply(res, 401, { error: 'wrong token' });
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (d) => {
      body += d;
      if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooBig) return;
      let input;
      try { input = JSON.parse(body || '{}'); } catch { return reply(res, 400, { error: 'not JSON' }); }
      const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
      try {
        const result = await onSavePoint({
          agent: text(input.agent, 60) || 'AI agent', event: text(input.event, 60), cwd: text(input.cwd, 4096),
          command: text(input.command, 2000), sessionId: text(input.sessionId, 200),
        });
        if (!res.destroyed) reply(res, 200, { ok: true, ...result });
      } catch (e) {
        if (!res.destroyed) reply(res, 500, { error: e.message });
      }
    });
  });
  server.requestTimeout = 60_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantedPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  port = server.address().port;
  await writeFileAtomic(file, JSON.stringify({ port, token }), 0o600); // owner only (Windows: the profile is private)
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

module.exports = { startHookServer, HOOK_PORT };
