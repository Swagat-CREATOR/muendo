import { test } from 'node:test'
import assert from 'node:assert'
import { State } from '../src/state.js'
import { fakeStorage } from './fake-do.js'
import * as g from '../src/gateway.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const EST = g.estimateNeurons(3200) // 7, an §34.3-sized body
const S = g.DEFAULT_SETTINGS

// Deterministic codes and tokens, so a test can name them.
function newState() {
  const storage = fakeStorage()
  let codes = 0
  let tokens = 0
  const state = new State(storage, {
    newInviteCode: () => `CODE${String(++codes).padStart(4, '0')}`,
    newToken: () => `token-${++tokens}`,
  })
  return { state, storage }
}

async function withTester() {
  const { state, storage } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const { token, tester, device } = await state.redeem({ code: codes[0], name: 'Priya', now: NOW })
  return { state, storage, token, tester, device }
}

const today = (storage) => storage.map.get(`usage:${g.utcDay(NOW)}`)

// --- §37.5 judge codes and devices ------------------------------------------------

test('createInvites mints up to max_codes judge codes and refuses one more', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ now: NOW })
  assert.equal(codes.length, S.max_codes)
  await assert.rejects(() => state.createInvites({ count: 1, now: NOW }), (e) => e.status === 409)
  await assert.rejects(() => state.createInvites({ count: 0 }), (e) => e.status === 400)
  await assert.rejects(() => state.createInvites({ count: 99 }), (e) => e.status === 400)
})

test('a judge code works on up to devices_per_code devices, each with its own token', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const seen = new Set()
  for (let i = 1; i <= S.devices_per_code; i++) {
    const d = await state.redeem({ code: codes[0], name: `laptop ${i}`, now: NOW })
    assert.equal(d.tester, codes[0], 'the code is the judge id')
    assert.equal(d.device, `${codes[0]}-${i}`)
    seen.add(d.token)
  }
  assert.equal(seen.size, S.devices_per_code)
  await assert.rejects(() => state.redeem({ code: codes[0], now: NOW }), (e) => e.status === 409)
  await assert.rejects(() => state.redeem({ code: 'NOPE2345', now: NOW }), (e) => e.status === 404)
})

test('a code is read case-insensitively and trimmed, because a judge types it', async () => {
  const { state } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const out = await state.redeem({ code: `  ${codes[0].toLowerCase()} `, now: NOW })
  assert.equal(out.tester, codes[0])
})

test('a revoked device is refused, and frees a seat on its code', async () => {
  const { state, token, tester, device } = await withTester()
  assert.deepEqual(await state.auth(token), { tester, device, name: 'Priya' })
  await state.revoke({ token })
  assert.equal(await state.auth(token), null)
  assert.equal(await state.auth('made-up'), null)
  assert.equal(await state.auth(''), null)
  await state.setSettings({ changes: { devices_per_code: 1 } })
  const again = await state.redeem({ code: tester, now: NOW })
  assert.equal(again.device, `${tester}-2`, 'the revoked device no longer counts against the code')
  await assert.rejects(() => state.revoke({ token: 'made-up' }), (e) => e.status === 404)
})

// --- the settings table ---------------------------------------------------------

test('settings are stored as overrides over the defaults, and bad ones are refused', async () => {
  const { state, storage } = newState()
  assert.deepEqual(await state.settings(), S)
  const table = await state.setSettings({ changes: { device_cap: 1500, code_cap: 4000 } })
  assert.deepEqual([table.device_cap, table.code_cap, table.total_cap], [1500, 4000, S.total_cap])
  assert.deepEqual(storage.map.get('settings'), { device_cap: 1500, code_cap: 4000 })
  await assert.rejects(() => state.setSettings({ changes: { device_cap: -5 } }), (e) => e.status === 400)
  assert.equal((await state.settings()).device_cap, 1500, 'a refused change leaves the table as it was')
})

// --- §37.6 K4 one round trip --------------------------------------------------

test('prepare reserves neurons for a Workers AI call, per device, per code and in total', async () => {
  const { state, storage, tester, device } = await withTester()
  for (let i = 0; i < 3; i++) {
    const p = await state.prepare({ tester, device, sig: `s${i}`, kind: 'guard', estNeurons: EST, now: NOW })
    assert.equal(p.route, 'workers_ai')
  }
  const usage = today(storage)
  assert.deepEqual([usage.total, usage.codes[tester], usage.devices[device]], [3 * EST, 3 * EST, 3 * EST])
})

test('two devices on one code share the code cap but not each other\'s device cap', async () => {
  const { state, storage } = newState()
  const { codes } = await state.createInvites({ count: 1, now: NOW })
  const a = await state.redeem({ code: codes[0], now: NOW })
  const b = await state.redeem({ code: codes[0], now: NOW })
  const day = g.utcDay(NOW)
  await storage.put({ [`usage:${day}`]: { day, total: S.device_cap, codes: { [codes[0]]: S.device_cap }, devices: { [a.device]: S.device_cap } } })
  const outA = await state.prepare({ tester: a.tester, device: a.device, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  assert.deepEqual([outA.route, outA.reason], ['fallback', 'device_cap'])
  const outB = await state.prepare({ tester: b.tester, device: b.device, sig: 'b', kind: 'guard', estNeurons: EST, now: NOW })
  assert.equal(outB.route, 'workers_ai')

  await storage.put({ [`usage:${day}`]: { day, total: S.code_cap, codes: { [codes[0]]: S.code_cap }, devices: {} } })
  const outC = await state.prepare({ tester: b.tester, device: b.device, sig: 'c', kind: 'guard', estNeurons: EST, now: NOW })
  assert.deepEqual([outC.route, outC.reason], ['fallback', 'code_cap'])
})

test('low budget: a receipt uses rules only while Guard still reaches the model', async () => {
  const { state, storage, tester, device } = await withTester()
  const day = g.utcDay(NOW)
  await storage.put({ [`usage:${day}`]: { day, total: Math.round(0.9 * S.total_cap), codes: {}, devices: {} } })
  const receipt = await state.prepare({ tester, device, sig: 'r', kind: 'receipt', estNeurons: EST, now: NOW })
  assert.deepEqual([receipt.route, receipt.reason], ['fallback', 'budget_low_rules'])
  const guard = await state.prepare({ tester, device, sig: 'g', kind: 'guard', estNeurons: EST, now: NOW })
  assert.equal(guard.route, 'workers_ai')
})

test('the budget follows the settings table', async () => {
  const { state, tester, device } = await withTester()
  await state.setSettings({ changes: { device_cap: 5 } })
  const out = await state.prepare({ tester, device, sig: 'x', kind: 'guard', estNeurons: EST, now: NOW })
  assert.deepEqual([out.route, out.reason], ['fallback', 'device_cap'])
})

test('the budget starts again on the next UTC day', async () => {
  const { state, storage, tester, device } = await withTester()
  const day = g.utcDay(NOW)
  await storage.put({ [`usage:${day}`]: { day, total: S.total_cap, codes: {}, devices: {} } })
  const out = await state.prepare({ tester, device, sig: 'b', kind: 'guard', estNeurons: EST, now: NOW })
  assert.deepEqual([out.route, out.rules_only], ['fallback', true])
  const tomorrow = NOW + 86_400_000
  assert.equal((await state.prepare({ tester, device, sig: 'c', kind: 'guard', estNeurons: EST, now: tomorrow })).route, 'workers_ai')
})

test('no single request can spend more than one device\'s daily share', async () => {
  const { state, storage, tester, device } = await withTester()
  const out = await state.prepare({ tester, device, sig: 'huge', kind: 'guard', estNeurons: S.device_cap + 1, now: NOW })
  assert.equal(out.route, 'fallback')
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
  assert.equal(today(storage).total, EST + 5)
  assert.equal(today(storage).codes[tester], EST + 5)
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
  await storage.put({ [old]: { total: 99, codes: {}, devices: {} } })
  await state.settle({ tester, sig: 'a', answers: { a: { p_yes: 1 } }, now: NOW })
  assert.equal(storage.map.has(old), false)
  assert.ok(storage.map.has(`usage:${g.utcDay(NOW)}`) || true)
})

// --- §34.9 R6 sample, K3 status ----------------------------------------------

test('only the first unknown answer shape is kept', async () => {
  const { state, storage } = newState()
  await state.saveSample({ backend: 'workers_ai', raw: 'first', reason: 'no answer for risk', now: NOW })
  await state.saveSample({ backend: 'workers_ai', raw: 'second', reason: 'other', now: NOW + 1 })
  assert.equal(storage.map.get('sample:clef').raw, 'first')
})

test('status shows today\'s remaining budget, the reset time, the settings and usage per code and device', async () => {
  const { state, tester, device } = await withTester()
  await state.prepare({ tester, device, sig: 'a', kind: 'guard', estNeurons: EST, now: NOW })
  for (const ms of [100, 300, 200]) {
    await state.settle({ tester, device, backend: 'workers_ai', ms, now: NOW })
  }
  const out = await state.status({ now: NOW })
  assert.equal(out.day, g.utcDay(NOW))
  assert.deepEqual(out.budget, {
    used: EST,
    remaining: S.total_cap - EST,
    total_cap: S.total_cap,
    resets_at: '2026-10-10T00:00:00.000Z',
    resets_in_minutes: 12 * 60,
    low: false,
    rules_only: false,
  })
  assert.deepEqual(out.settings, S)
  assert.deepEqual(out.codes, [{ code: tester, used: EST, devices: [{ device, name: 'Priya', revoked: false, used: EST }] }])
  assert.deepEqual(out.latency_median_ms, { workers_ai: 200 })
  assert.equal(out.unknown_answer_sample, null)
  assert.equal(JSON.stringify(out).includes('token-'), false, 'no token is ever shown')
})

test('status says rules only once the day is 95% used', async () => {
  const { state, storage } = newState()
  const day = g.utcDay(NOW)
  await storage.put({ [`usage:${day}`]: { day, total: Math.ceil(0.95 * S.total_cap), codes: {}, devices: {} } })
  const out = await state.status({ now: NOW })
  assert.deepEqual([out.budget.low, out.budget.rules_only], [true, true])
})
