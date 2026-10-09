// The contract test for POST /v1/decide (spec §39, Thu 8 Oct, Window 2): the
// whole Worker, driven through its own fetch handler with the Workers runtime
// faked. It checks what a tester's PC actually gets back, including every path
// where the gateway must answer {fallback:true} and let the device's rules decide.
import { test } from 'node:test'
import assert from 'node:assert'
import worker from '../src/index.js'
import { fakeEnv, fakeCtx, ADMIN_SECRET, GATEWAY_SECRET } from './fake-do.js'
import * as g from '../src/gateway.js'

const TUNNEL = 'https://glad-stone-tiger.trycloudflare.com'

// The §34.3 guard request, cut to the questions §34.4 branches on.
const GUARD_BODY = {
  state: {
    brief: 'Fix the failing date tests in api/. Don\'t touch the db folder.',
    agent: 'claude-code',
    cwd: 'C:/work/shop',
    recent: ['edit api/date.ts', 'run npm test -> exit 1 (2 failing)'],
    action: { tool: 'Bash', command: 'rm -rf db/migrations' },
    facts: { paths_outside_brief: ['db/migrations'], in_journal: true, same_action_failed_recently: 0 },
  },
  questions: [
    { id: 'in_scope', type: 'noul', text: 'Is this action part of what the brief asks?' },
    { id: 'irreversible', type: 'noul', text: 'Would this be hard to undo without a backup?' },
    { id: 'risk', type: 'score', text: 'How risky is this for the user\'s data?', scale: [1, 2, 3, 4, 5] },
    {
      id: 'verdict', type: 'choice', text: 'What should happen next?',
      options: ['allow', 'savepoint_then_allow', 'ask_user', 'skip_duplicate', 'deny', 'brake'],
    },
  ],
}

const ANSWERS = {
  in_scope: { p_yes: 0.08 },
  irreversible: { p_yes: 0.96 },
  risk: { value: 5 },
  verdict: { probabilities: { allow: 0.02, savepoint_then_allow: 0.03, ask_user: 0.2, skip_duplicate: 0, deny: 0.6, brake: 0.15 } },
}

const asTextModel = () => ({ response: '```json\n' + JSON.stringify({ answers: ANSWERS }) + '\n```' })

async function call(env, ctx, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const res = await worker.fetch(new Request(`https://mewndo-cloud.test${path}`, init), env, ctx)
  return { status: res.status, body: await res.json() }
}

// §37.5 end to end: an admin mints codes, a tester redeems one for a token.
async function withTester(env, ctx, name = 'Priya') {
  const mint = await call(env, ctx, 'POST', '/admin/invites', {
    headers: { 'x-admin-secret': ADMIN_SECRET }, body: { count: 1 },
  })
  assert.equal(mint.status, 200, JSON.stringify(mint.body))
  const redeemed = await call(env, ctx, 'POST', '/invite/redeem', { body: { code: mint.body.codes[0], name } })
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body))
  return { token: redeemed.body.token, tester: redeemed.body.tester }
}

const decide = (env, ctx, token, over = {}) => call(env, ctx, 'POST', '/v1/decide', {
  headers: { authorization: `Bearer ${token}`, ...(over.headers ?? {}) },
  body: over.body ?? GUARD_BODY,
})

test('GET /health answers without a token, which is what R6 pre-connects to', async () => {
  const { status, body } = await call(fakeEnv(), fakeCtx(), 'GET', '/health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
})

test('an unknown route is a 404, not a 500', async () => {
  assert.equal((await call(fakeEnv(), fakeCtx(), 'GET', '/nope')).status, 404)
  assert.equal((await call(fakeEnv(), fakeCtx(), 'GET', '/v1/decide')).status, 404)
})

test('/v1/decide refuses a missing, wrong or revoked token', async () => {
  const env = fakeEnv({ ai: asTextModel })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  assert.equal((await call(env, ctx, 'POST', '/v1/decide', { body: GUARD_BODY })).status, 401)
  assert.equal((await decide(env, ctx, 'not-a-token')).status, 401)

  assert.equal((await decide(env, ctx, token)).status, 200)
  await call(env, ctx, 'POST', '/admin/revoke', { headers: { 'x-admin-secret': ADMIN_SECRET }, body: { token } })
  assert.equal((await decide(env, ctx, token)).status, 401)
})

test('the admin routes need the admin secret', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  for (const [method, path] of [['POST', '/admin/invites'], ['GET', '/admin/status'], ['POST', '/admin/revoke']]) {
    const body = method === 'GET' ? undefined : {}
    assert.equal((await call(env, ctx, method, path, { body })).status, 401, path)
    assert.equal((await call(env, ctx, method, path, { headers: { 'x-admin-secret': 'wrong' }, body })).status, 401, path)
  }
})

test('a guard call returns the §34.9 R6 answers, the backend and the time taken', async () => {
  const env = fakeEnv({ ai: asTextModel })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  const { status, body } = await decide(env, ctx, token, { headers: { 'x-mewndo-kind': 'guard', 'x-mewndo-sig': 'sig-a' } })
  assert.equal(status, 200)
  assert.equal(body.backend, 'workers_ai')
  assert.ok(Number.isFinite(body.ms))
  assert.deepEqual(body.answers.in_scope, { p_yes: 0.08 })
  assert.deepEqual(body.answers.risk, { value: 5 })
  assert.equal(body.answers.verdict.choice, 'deny')
  assert.equal(body.answers.verdict.confidence, 0.6)
  assert.equal(env.calls[0].model, '@cf/cloudflare/clef-flash')
})

test('an identical signature is served from the cache without a second model call', async () => {
  const env = fakeEnv({ ai: asTextModel })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  const headers = { 'x-mewndo-kind': 'guard', 'x-mewndo-sig': 'sig-b' }
  await decide(env, ctx, token, { headers })
  await ctx.settled() // the cache write is deferred, as §37.6 K4.5 asks

  const again = await decide(env, ctx, token, { headers })
  assert.equal(again.body.backend, 'cache')
  assert.equal(again.body.cached, true)
  assert.deepEqual(again.body.answers.risk, { value: 5 })
  assert.equal(env.calls.length, 1, 'the model is asked once')

  const other = await decide(env, ctx, token, { headers: { ...headers, 'x-mewndo-sig': 'sig-c' } })
  assert.equal(other.body.backend, 'workers_ai')
})

test('a model error becomes a fallback and gives the neurons back', async () => {
  const env = fakeEnv({ ai: () => { throw new Error('522') } })
  const ctx = fakeCtx()
  const { token, tester } = await withTester(env, ctx)
  const { status, body } = await decide(env, ctx, token, { headers: { 'x-mewndo-sig': 'sig-d' } })
  assert.equal(status, 200, 'a dead model is not the tester\'s problem')
  assert.equal(body.fallback, true)
  assert.equal(body.reason, 'workers_ai_error')
  assert.equal(body.answers, undefined, 'the gateway never invents answers (§34.8)')

  await ctx.settled()
  const usage = env.storage.map.get(`usage:${g.utcDay(Date.now())}`)
  assert.equal(usage.total, 0)
  assert.equal(usage.testers[tester], 0)
  assert.equal(env.storage.map.has('cache:sig-d'), false)
})

test('an answer shape we do not understand becomes a fallback, and one sample is kept', async () => {
  const env = fakeEnv({ ai: () => ({ response: '{"verdict":"just delete it"}' }) })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  const { body } = await decide(env, ctx, token, { headers: { 'x-mewndo-sig': 'sig-e' } })
  assert.equal(body.fallback, true)
  assert.equal(body.reason, 'unknown_answer_shape')

  await ctx.settled()
  const sample = env.storage.map.get('sample:clef')
  assert.equal(sample.backend, 'workers_ai')
  assert.match(sample.reason, /no answer for/)
  assert.equal(env.storage.map.has('cache:sig-e'), false)
})

test('a deadline the model misses becomes a fallback', async () => {
  const env = fakeEnv({ ai: () => new Promise((resolve) => setTimeout(() => resolve(asTextModel()), 5000)).then((v) => v) })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  const { body } = await decide(env, ctx, token, {
    headers: { 'x-mewndo-kind': 'guard', 'x-mewndo-deadline-ms': '40', 'x-mewndo-sig': 'sig-f' },
  })
  assert.equal(body.fallback, true)
  assert.equal(body.reason, 'workers_ai_error')
})

test('a loose kind is served by the registered Kaggle tunnel', async (t) => {
  const env = fakeEnv({ ai: () => { throw new Error('Workers AI must not be asked for a loose call') } })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  const registered = await call(env, ctx, 'POST', '/internal/backend', {
    headers: { authorization: `Bearer ${GATEWAY_SECRET}` }, body: { url: TUNNEL, p50_ms: 900 },
  })
  assert.equal(registered.status, 200)

  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response(JSON.stringify({ answers: ANSWERS }), { headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = real })

  const { body } = await decide(env, ctx, token, { headers: { 'x-mewndo-kind': 'receipt', 'x-mewndo-sig': 'sig-g' } })
  assert.equal(body.backend, 'kaggle')
  assert.equal(body.answers.verdict.choice, 'deny')
  assert.equal(seen[0].url, `${TUNNEL}/v1/systemone`)
  assert.equal(seen[0].init.headers.authorization, `Bearer ${GATEWAY_SECRET}`)
  assert.equal(env.calls.length, 0)
})

test('/internal/backend needs the gateway secret, and /admin/status then shows Kaggle', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  assert.equal((await call(env, ctx, 'POST', '/internal/backend', { body: { url: TUNNEL, p50_ms: 1 } })).status, 401)
  assert.equal((await call(env, ctx, 'POST', '/internal/backend', {
    headers: { authorization: 'Bearer wrong' }, body: { url: TUNNEL, p50_ms: 1 },
  })).status, 401)
  assert.equal((await call(env, ctx, 'POST', '/internal/backend', {
    headers: { authorization: `Bearer ${GATEWAY_SECRET}` }, body: { url: 'http://insecure', p50_ms: 1 },
  })).status, 400)

  await call(env, ctx, 'POST', '/internal/backend', {
    headers: { authorization: `Bearer ${GATEWAY_SECRET}` }, body: { url: TUNNEL, p50_ms: 870 },
  })
  const status = await call(env, ctx, 'GET', '/admin/status', { headers: { 'x-admin-secret': ADMIN_SECRET } })
  assert.equal(status.body.kaggle.alive, true)
  assert.equal(status.body.kaggle.p50_ms, 870)
  assert.equal(status.body.neurons.total_cap, g.TOTAL_CAP)
})

test('a malformed or oversized body is refused before any model call', async () => {
  const env = fakeEnv({ ai: () => { throw new Error('must not be asked') } })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  assert.equal((await decide(env, ctx, token, { body: 'not json' })).status, 400)
  assert.equal((await decide(env, ctx, token, { body: { questions: [] } })).status, 400)
  const huge = { state: { brief: 'x'.repeat(g.MAX_BODY_BYTES) }, questions: GUARD_BODY.questions }
  assert.equal((await decide(env, ctx, token, { body: huge })).status, 413)
  assert.equal(env.calls.length, 0)
})

test('without a signature header the gateway hashes the request, so repeats still cache', async () => {
  const env = fakeEnv({ ai: asTextModel })
  const ctx = fakeCtx()
  const { token } = await withTester(env, ctx)
  await decide(env, ctx, token)
  await ctx.settled()
  const again = await decide(env, ctx, token)
  assert.equal(again.body.backend, 'cache')
  // A different action is a different key.
  const other = structuredClone(GUARD_BODY)
  other.state.action.command = 'npm test'
  assert.equal((await decide(env, ctx, token, { body: other })).body.backend, 'workers_ai')
})

test('one tester cannot spend another tester\'s share', async () => {
  const env = fakeEnv({ ai: asTextModel })
  const ctx = fakeCtx()
  const a = await withTester(env, ctx, 'Priya')
  const b = await withTester(env, ctx, 'Sam')
  await env.storage.put({
    [`usage:${g.utcDay(Date.now())}`]: { total: g.TESTER_CAP, testers: { [a.tester]: g.TESTER_CAP } },
  })
  assert.equal((await decide(env, ctx, a.token, { headers: { 'x-mewndo-sig': 'x1' } })).body.fallback, true)
  assert.equal((await decide(env, ctx, b.token, { headers: { 'x-mewndo-sig': 'x2' } })).body.backend, 'workers_ai')
})
