// app/gateway-setup.js: Mewndo's gateway without an invite.
const { test } = require('node:test');
const assert = require('node:assert');
const { ensureGateway, DEFAULT_GATEWAY, TOKEN_TARGET } = require('../app/gateway-setup');

const memCreds = (seed = {}) => { const m = new Map(Object.entries(seed)); return { available: true, read: (t) => m.get(t) ?? null, write: (t, s) => m.set(t, s), _m: m }; };
const reply = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });

test('no URL set: the default gateway is used; no token: one is registered and saved', async () => {
  const env = {}; const creds = memCreds(); const calls = [];
  const fetch = async (url, opts) => { calls.push([url, opts.method]); return reply(200, { token: 'tok-abcdef12' })(); };
  const out = await ensureGateway({ credentials: creds, env, fetch });
  assert.equal(env.MEWNDO_GATEWAY_URL, DEFAULT_GATEWAY);
  assert.deepEqual(calls, [[`${DEFAULT_GATEWAY}/v1/register`, 'POST']]);
  assert.deepEqual(out, { ok: true, had: false });
  assert.equal(creds._m.get(TOKEN_TARGET), 'tok-abcdef12');
});

test('a token already saved: nothing is asked for; a URL the user set is kept', async () => {
  const env = { MEWNDO_GATEWAY_URL: 'https://mine.example.dev/' };
  const out = await ensureGateway({ credentials: memCreds({ [TOKEN_TARGET]: 'tok-existing' }), env, fetch: () => assert.fail('no call') });
  assert.deepEqual(out, { ok: true, had: true });
  assert.equal(env.MEWNDO_GATEWAY_URL, 'https://mine.example.dev/');
});

test('offline, refused, too slow or a bad reply: nothing is saved and the app carries on', async () => {
  for (const fetch of [async () => { throw new TypeError('fetch failed'); }, reply(429, {}), reply(200, { token: '' })]) {
    const creds = memCreds();
    const out = await ensureGateway({ credentials: creds, env: {}, fetch });
    assert.equal(out.ok, false);
    assert.equal(creds._m.size, 0);
  }
  const slow = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const out = await ensureGateway({ credentials: memCreds(), env: {}, fetch: slow, deadlineMs: 30 });
  assert.deepEqual(out, { ok: false, why: 'too slow' });
});

test('no credential store (not Windows): only the URL is set', async () => {
  const env = {};
  const out = await ensureGateway({ credentials: { available: false, why: 'Windows only' }, env, fetch: () => assert.fail('no call') });
  assert.deepEqual(out, { ok: false, why: 'Windows only' });
  assert.equal(env.MEWNDO_GATEWAY_URL, DEFAULT_GATEWAY);
});
