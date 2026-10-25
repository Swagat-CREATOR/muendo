// The real clef-flash call shape (Cloudflare's model page, workers-ai-models/clef-flash.json, read 10 Oct 2026):
// what the gateway sends, and how its typed answers become the §34.9 R6 answers the Rust router parses.
import { test } from 'node:test'
import assert from 'node:assert'
import worker from '../src/index.js'
import { fakeEnv, fakeCtx, ADMIN_SECRET } from './fake-do.js'
import * as g from '../src/gateway.js'

const REQ = g.validateDecideRequest({
  state: { brief: 'Fix the date tests', action: { tool: 'Bash', command: 'rm -rf db/migrations' } },
  questions: [
    { id: 'in_scope', type: 'noul', text: 'Is this part of the brief?' },
    { id: 'risk', type: 'score', text: 'How risky is this?', scale: [1, 2, 3, 4, 5] },
    { id: 'verdict', type: 'choice', text: 'What next?', options: ['allow', 'ask_user', 'deny'] },
  ],
})

// What clef-flash returns, field for field as its output schema documents.
const REAL = {
  model: 'clef-flash',
  answers: {
    in_scope: { type: 'noul', noul: 0.07 },
    risk: { type: 'score', score: 3.5, legend: { 0: '1', 4: '5' }, probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.3, 4: 0.6 }, confidence: 0.6 },
    verdict: { type: 'choice', choice: 'deny', probabilities: { allow: 0.02, ask_user: 0.18, deny: 0.8 }, confidence: 0.8 },
  },
  usage: { input_tokens: 412, output_tokens: 9 },
}

test('the request is the typed-question shape clef-flash documents', () => {
  const body = g.toClefRequest(REQ)
  assert.equal(body.model, 'clef-flash')
  assert.deepEqual(body.state, REQ.state)
  assert.deepEqual(body.questions.in_scope, { type: 'noul', instructions: 'Is this part of the brief?' })
  assert.deepEqual(body.questions.risk, { type: 'score', instructions: 'How risky is this?', criteria: ['1', '2', '3', '4', '5'] })
  assert.deepEqual(body.questions.verdict, {
    type: 'choice', instructions: 'What next?', criteria: { allow: null, ask_user: null, deny: null },
  })
  assert.equal(g.toClefRequest(REQ, 'clef').model, 'clef')
})

test('typed answers become R6 answers, with a score index put back on the question scale', () => {
  const { answers, usage } = g.fromClefResponse(REQ.questions, REAL)
  assert.deepEqual(answers.in_scope, { p_yes: 0.07 })
  assert.deepEqual(answers.risk, { value: 4.5 }, 'level index 3.5 on 1..5 is 4.5')
  assert.equal(answers.verdict.choice, 'deny')
  const parsed = g.parseClefAnswers(REQ.questions, { answers })
  assert.equal(parsed.ok, true, parsed.reason)
  assert.equal(usage.input_tokens, 412)
  assert.equal(g.levelOnScale([10, 20, 40], 1.5), 30)
  assert.equal(g.levelOnScale([1, 5], 9), 5, 'clamped to the top level')
  assert.equal(g.clefNeurons({ input_tokens: 412 }), 2, '$0.038 per million input tokens')
  assert.equal(g.clefNeurons(undefined), null)
})

test('end to end: the Worker sends clef-flash the real shape and answers the device in R6', async () => {
  const env = fakeEnv({ ai: () => REAL })
  const ctx = fakeCtx()
  const call = async (method, path, body, headers = {}) => {
    const res = await worker.fetch(new Request(`https://mewndo-cloud.test${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    }), env, ctx)
    return { status: res.status, body: await res.json() }
  }
  const mint = await call('POST', '/admin/invites', { count: 1 }, { 'x-admin-secret': ADMIN_SECRET })
  const { body: { token } } = await call('POST', '/invite/redeem', { code: mint.body.codes[0] })
  const { status, body } = await call('POST', '/v1/decide', {
    state: REQ.state,
    questions: [
      { id: 'in_scope', type: 'noul', text: 'Is this part of the brief?' },
      { id: 'risk', type: 'score', text: 'How risky is this?', scale: [1, 2, 3, 4, 5] },
      { id: 'verdict', type: 'choice', text: 'What next?', options: ['allow', 'ask_user', 'deny'] },
    ],
  }, { authorization: `Bearer ${token}`, 'x-mewndo-kind': 'triage' })
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.backend, 'workers_ai')
  assert.deepEqual(body.answers.in_scope, { p_yes: 0.07 })
  assert.deepEqual(body.answers.risk, { value: 4.5 })
  assert.equal(env.calls[0].input.model, 'clef-flash')
  assert.ok(!('messages' in env.calls[0].input), 'not a chat prompt')
})

test('a model answer missing a question is still a fallback', async () => {
  const partial = { answers: { in_scope: REAL.answers.in_scope } }
  const { answers } = g.fromClefResponse(REQ.questions, partial)
  assert.equal(g.parseClefAnswers(REQ.questions, { answers }).ok, false)
})
