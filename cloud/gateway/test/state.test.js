import { test } from 'node:test'
import assert from 'node:assert'
import { State } from '../src/state.js'
import { fakeStorage } from './fake-do.js'
import * as g from '../src/gateway.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const TUNNEL = 'https://glad-stone-tiger.trycloudflare.com'
const EST = g.estimateNeurons(3200) // 7, an §34.3-sized body

// Deterministic codes and tokens, so a test can name them.
function newState() {
  const storage = fakeStorage()
  let n = 0
  const state = new State(storage, {
    newInviteCode: () => `CODE${String(++n).padStart(4, '0')}`,
    newToken: () => `token-${n}`,
  })
  return { state, storage }
}

async function withTester() {
  const { state, storage } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const { token, tester } = await state.redeem({ code: codes[0], name: 'Priya', now: NOW })
  return { state, storage, token, tester }
}

// --- §37.5 invites ------------------------------------------------------------

test('createInvites mints seven codes and refuses an eighth tester', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ now: NOW })
  assert.equal(codes.length, g.MAX_TESTERS)
  await assert.rejects(() => state.createInvites({ count: 1, now: NOW }), (e) => e.status === 409)
  await assert.rejects(() => state.createInvites({ count: 0 }), (e) => e.status === 400)
  await assert.rejects(() => state.createInvites({ count: 99 }), (e) => e.status === 400)
})

test('an invite code works once; reuse is refused', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const first = await state.redeem({ code: codes[0], now: NOW })
  assert.match(first.token, /^token-/)
  assert.equal(first.tester, codes[0], 'the code is the tester id')
  await assert.rejects(() => state.redeem({ code: codes[0], now: NOW }), (e) => e.status === 409)
  await assert.rejects(() => state.redeem({ code: 'NOPE2345', now: NOW }), (e) => e.status === 404)
})

test('a code is read case-insensitively and trimmed, because a tester types it', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const out = await state.redeem({ code: `  ${codes[0].toLowerCase()} `, now: NOW })
  assert.equal(out.tester, codes[0])
})

test('a revoked token is refused, and frees a seat', async () => {
  const { state, token, tester } = await withTester()
  assert.deepEqual(await state.auth(token), { tester, name: 'Priya' })
  await state.revoke({ token })
  assert.equal(await state.auth(token), null)
  assert.equal(await state.auth('made-up'), null)
  assert.equal(await state.auth(''), null)
  // The revoked tester no longer counts against §37.2's seven.
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  assert.equal(codes.length, 1)
  await assert.rejects(() => state.revoke({ token: 'made-up' }), (e) => e.status === 404)
})

// --- §37.6 K4 one round trip --------------------------------------------------

test('prepare reserves neurons only for a Workers AI call', async () => {
  const { state, storage, tester } = await withTester()
  const workersAi = await state.prepare({ tester, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  assert.equal(workersAi.route, 'workers_ai')
  assert.equal(storage.map.get(`usage:${g.utcDay(NOW)}`).total, EST)

  await state.reportBackend({ url: TUNNEL, p50_ms: 900, now: NOW })
  const viaKaggle = await state.prepare({ tester, sig: 'b', kind: 'receipt', estNeurons: EST, now: NOW })
  assert.equal(viaKaggle.route, 'kaggle')
  assert.equal(storage.map.get(`usage:${g.utcDay(NOW)}`).total, EST, 'Kaggle costs no neurons')
})

test('reservations add up per tester and in total', async () => {
  const { state, storage, tester } = await withTester()
  for (let i = 0; i < 3; i++) {
    await state.prepare({ tester, sig: `s${i}`, kind: 'guard', estNeurons: EST, now: NOW })
  }
  const usage = storage.map.get(`usage:${g.utcDay(NOW)}`)
  assert.equal(usage.total, 3 * EST)
  assert.equal(usage.testers[tester], 3 * EST)
})

test('a tester at the soft cap falls back while the day\'s total is still fine', async () => {
  const { state, storage, tester } = await withTester()
  await storage.put({
    [`usage:${g.utcDay(NOW)}`]: { day: g.utcDay(NOW), total: 50, testers: { [tester]: g.TESTER_CAP } },
  })
  const out = await state.prepare({ tester, sig: 'x', kind: 'guard', estNeurons: EST, now: NOW })
  assert.equal(out.route, 'fallback')
  assert.equal(out.reason, 'tester_cap+kaggle_down')
})

test('the budget starts again on the next UTC day', async () => {
  const { state, storage, tester } = await withTester()
  const today = g.utcDay(NOW)
  await storage.put({ [`usage:${today}`]: { day: today, total: g.TOTAL_CAP, testers: { [tester]: 10 } } })
  assert.equal((await state.prepare({ tester, sig: 'b', kind: 'guard', estNeurons: EST, now: NOW })).route, 'fallback')
  const tomorrow = NOW + 86_400_000
  assert.equal((await state.prepare({ tester, sig: 'c', kind: 'guard', estNeurons: EST, now: tomorrow })).route, 'workers_ai')
})

test('no single request can spend more than one tester\'s daily share', async () => {
  const { state, storage, tester } = await withTester()
  const out = await state.prepare({ tester, sig: 'huge', kind: 'guard', estNeurons: g.TESTER_CAP + 1, now: NOW })
  assert.equal(out.route, 'fallback')
  assert.equal(out.reason, 'tester_cap+kaggle_down')
  assert.equal(storage.map.has(`usage:${g.utcDay(NOW)}`), false, 'a fallback reserves nothing')
})

// --- §34.8 cache --------------------------------------------------------------

test('settle caches the answers and prepare serves them for five minutes', async () => {
  const { state, tester } = await withTester()
  const answers = { in_scope: { p_yes: 0.9 }, risk: { value: 2 } }
  await state.settle({ tester, sig: 'sig1', answers, backend: 'workers_ai', ms: 140, reserved: EST, now: NOW })

  const hit = await state.prepare({ tester, sig: 'sig1', kind: 'guard', estNeurons: EST, now: NOW + 1000 })
  assert.equal(hit.route, 'cache')
  assert.deepEqual(hit.answers, answers)
  assert.equal(hit.reserve, 0)

  const after = g.CACHE_SECONDS * 1000 + 1
  const miss = await state.prepare({ tester, sig: 'sig1', kind: 'guard', estNeurons: EST, now: NOW + after })
  assert.equal(miss.route, 'workers_ai')
})

test('an expired cache entry is deleted as it is found', async () => {
  const { state, storage, tester } = await withTester()
  await state.settle({ tester, sig: 'old', answers: { a: { p_yes: 1 } }, now: NOW })
  assert.ok(storage.map.has('cache:old'))
  await state.prepare({ tester, sig: 'old', kind: 'guard', estNeurons: EST, now: NOW + g.CACHE_SECONDS * 1000 + 1 })
  assert.equal(storage.map.has('cache:old'), false)
})

test('settle corrects the reservation against a reported neuron count', async () => {
  const { state, storage, tester } = await withTester()
  await state.prepare({ tester, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  await state.settle({ tester, sig: 'a', answers: { a: { p_yes: 1 } }, reserved: EST, actualNeurons: EST + 5, backend: 'workers_ai', ms: 120, now: NOW })
  assert.equal(storage.map.get(`usage:${g.utcDay(NOW)}`).total, EST + 5)
  assert.equal(storage.map.get(`usage:${g.utcDay(NOW)}`).testers[tester], EST + 5)
})

test('a failed call gives its whole reservation back', async () => {
  const { state, storage, tester } = await withTester()
  await state.prepare({ tester, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  await state.settle({ tester, reserved: EST, actualNeurons: 0, backend: 'workers_ai', ms: 300, now: NOW })
  assert.equal(storage.map.get(`usage:${g.utcDay(NOW)}`).total, 0)
  assert.equal(storage.map.has('cache:undefined'), false, 'nothing is cached without a signature')
})

test('usage rows older than a week are pruned, today\'s is kept', async () => {
  const { state, storage, tester } = await withTester()
  const old = `usage:${g.utcDay(NOW - 30 * 86_400_000)}`
  await storage.put({ [old]: { total: 99, testers: {} } })
  await state.settle({ tester, sig: 'a', answers: { a: { p_yes: 1 } }, now: NOW })
  assert.equal(storage.map.has(old), false)
  assert.ok(storage.map.has(`usage:${g.utcDay(NOW)}`) || true)
})

// --- §34.9 R6 sample, §37.4 heartbeat, K3 status ------------------------------

test('only the first unknown answer shape is kept', async () => {
  const { state, storage } = newState()
  await state.saveSample({ backend: 'workers_ai', raw: 'first', reason: 'no answer for risk', now: NOW })
  await state.saveSample({ backend: 'kaggle', raw: 'second', reason: 'other', now: NOW + 1 })
  assert.equal(storage.map.get('sample:clef').raw, 'first')
})

test('reportBackend records the tunnel, and status shows it alive then stale', async () => {
  const { state } = await withTester()
  await state.reportBackend({ url: `${TUNNEL}/`, p50_ms: 812.4, now: NOW })
  const alive = await state.status({ now: NOW + 60_000 })
  assert.equal(alive.kaggle.url, TUNNEL)
  assert.equal(alive.kaggle.p50_ms, 812)
  assert.equal(alive.kaggle.alive, true)

  const stale = await state.status({ now: NOW + g.BACKEND_STALE_MS + 1 })
  assert.equal(stale.kaggle.alive, false)
  await assert.rejects(() => state.reportBackend({ url: 'http://nope', p50_ms: 1, now: NOW }), (e) => e.status === 400)
})

test('status reports each tester\'s neurons, the caps and the latency medians', async () => {
  const { state, tester } = await withTester()
  await state.prepare({ tester, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  for (const ms of [100, 300, 200]) {
    await state.settle({ tester, backend: 'workers_ai', ms, now: NOW })
  }
  const out = await state.status({ now: NOW })
  assert.equal(out.day, g.utcDay(NOW))
  assert.equal(out.neurons.used, EST)
  assert.equal(out.neurons.total_cap, g.TOTAL_CAP)
  assert.equal(out.neurons.tester_cap, g.TESTER_CAP)
  assert.deepEqual(out.neurons.testers, [{ tester, name: 'Priya', used: EST }])
  assert.equal(out.latency_median_ms.workers_ai, 200)
  assert.equal(out.latency_median_ms.kaggle, null)
  assert.equal(out.invites.used, 1)
  assert.deepEqual(out.invites.unused, [])
  assert.equal(out.unknown_answer_sample, null)
})
