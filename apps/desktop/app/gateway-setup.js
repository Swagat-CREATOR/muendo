// Mewndo's own gateway (cloud/gateway) works out of the box, with no invite (the owner's decision, 13 Oct 2026):
// voice (Whisper) and Clef go through it. At start, before the core is spawned (it reads the same environment and
// the same credential):
//   - MEWNDO_GATEWAY_URL defaults to Mewndo's deployed Worker when the user hasn't set one;
//   - if Credential Manager has no device token yet (Mewndo/gateway-device-token), one is asked for with
//     POST /v1/register and saved there, never in a file or a log (CLAUDE.md rule 4).
// Every call has a deadline; with no network, no token or a refusal, Mewndo carries on exactly as before: the rules
// decide and Windows' own recognizer listens (CLAUDE.md rule 3). It tries again at the next start.
// What it can't do: anything off Windows (no Credential Manager there); a token survives only on this PC.
const DEFAULT_GATEWAY = 'https://mewndo-cloud.swarupswagat21.workers.dev';
const TOKEN_TARGET = 'Mewndo/gateway-device-token';
const DEADLINE_MS = 5000;

async function ensureGateway({ credentials, log, env = process.env, fetch = globalThis.fetch, deadlineMs = DEADLINE_MS } = {}) {
  if (!env.MEWNDO_GATEWAY_URL) env.MEWNDO_GATEWAY_URL = DEFAULT_GATEWAY;
  const url = String(env.MEWNDO_GATEWAY_URL).replace(/\/+$/, '');
  if (!credentials?.available) return { ok: false, why: credentials?.why ?? 'no credential store' };
  if (credentials.read(TOKEN_TARGET)) return { ok: true, had: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    const res = await fetch(`${url}/v1/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ctl.signal });
    if (!res.ok) { log?.info?.(`Gateway sign-up refused (status ${res.status}); voice and Clef stay on this PC`); return { ok: false, why: `status ${res.status}` }; }
    const body = await res.json();
    if (typeof body?.token !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(body.token)) return { ok: false, why: 'no token in the reply' };
    credentials.write(TOKEN_TARGET, body.token);
    log?.info?.('Gateway device token saved in Credential Manager');
    return { ok: true, had: false };
  } catch (e) {
    log?.info?.(`Gateway not reached (${e?.name === 'AbortError' ? 'too slow' : 'offline'}); voice and Clef stay on this PC`);
    return { ok: false, why: e?.name === 'AbortError' ? 'too slow' : 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ensureGateway, DEFAULT_GATEWAY, TOKEN_TARGET };
