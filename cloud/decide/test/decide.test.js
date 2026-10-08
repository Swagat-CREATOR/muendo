import { test } from 'node:test'
import assert from 'node:assert'
import * as d from '../src/decide.js'

test('validateRequest accepts a well-formed request', () => {
  const req = d.validateRequest({
    state: { brief: 'x' },
    questions: [
      { id: 'a', type: 'noul', text: 'ok?' },
      { id: 'b', type: 'choice', text: 'which?', choices: ['x', 'y'] },
      { id: 'c', type: 'score', text: 'how risky?' },
    ],
  })
  assert.equal(req.questions.length, 3)
})

test('validateRequest rejects bad input', () => {
  assert.throws(() => d.validateRequest(null))
  assert.throws(() => d.validateRequest({ questions: [] }))
  assert.throws(() => d.validateRequest({ state: {}, questions: [] }))
  assert.throws(() => d.validateRequest({ state: {}, questions: [{ id: 'a', type: 'bogus', text: 'x' }] }))
  assert.throws(() => d.validateRequest({ state: {}, questions: [{ id: 'a', type: 'choice', text: 'x', choices: ['only'] }] }))
  assert.throws(() => d.validateRequest({ state: {}, questions: [{ id: 'a', type: 'noul', text: 'x' }, { id: 'a', type: 'noul', text: 'y' }] }))
  // over 64 questions
  const many = Array.from({ length: 65 }, (_, i) => ({ id: 's' + i, type: 'noul', text: 'q' }))
  assert.throws(() => d.validateRequest({ state: {}, questions: many }))
})

test('cacheKey is order-independent on object keys', () => {
  const a = d.cacheKey({ state: { brief: 'x', mode: 'y' }, questions: [{ id: 'q', type: 'noul', text: 't' }] })
  const b = d.cacheKey({ state: { mode: 'y', brief: 'x' }, questions: [{ type: 'noul', text: 't', id: 'q' }] })
  assert.equal(a, b)
})

test('ruleAnswers are neutral and below any release bar', () => {
  const ans = d.ruleAnswers([
    { id: 'a', type: 'noul', text: 't' },
    { id: 'b', type: 'score', text: 't' },
    { id: 'c', type: 'choice', text: 't', choices: ['x', 'y', 'z', 'w'] },
  ])
  assert.equal(ans[0].prob, 0.5)
  assert.equal(ans[1].score, 0.5)
  assert.equal(ans[2].probs.x, 0.25)
  assert.ok(ans[0].prob < 0.97) // a missing model never auto-approves a send
})

test('parseModelAnswers normalizes, clamps and falls back per question', () => {
  const qs = [
    { id: 'a', type: 'noul', text: 't' },
    { id: 'b', type: 'score', text: 't' },
    { id: 'c', type: 'choice', text: 't', choices: ['x', 'y'] },
    { id: 'd', type: 'noul', text: 't' }, // model omits this one
  ]
  const ans = d.parseModelAnswers(qs, { answers: [
    { id: 'a', prob: 1.4 },        // clamp to 1
    { id: 'b', score: -2 },        // clamp to 0
    { id: 'c', probs: { x: 3, y: 1 } }, // renormalize to 0.75/0.25
  ] })
  assert.equal(ans[0].prob, 1)
  assert.equal(ans[1].score, 0)
  assert.ok(Math.abs(ans[2].probs.x - 0.75) < 1e-9)
  assert.ok(Math.abs(ans[2].probs.y - 0.25) < 1e-9)
  assert.equal(ans[3].prob, 0.5) // fell back to the rule answer
})

test('chargeNeurons caps the day and resets on a new day', () => {
  const cap = 100
  let m = null
  // 50 calls of 20 each: first five allowed (100), sixth over cap.
  let last
  for (let i = 0; i < 6; i++) { last = d.chargeNeurons(m, Date.parse('2026-10-06T10:00:00Z'), 20, cap); m = last.meter }
  assert.equal(last.allowed, false)
  assert.equal(m.used, 100)
  // next day resets
  const next = d.chargeNeurons(m, Date.parse('2026-10-07T00:01:00Z'), 20, cap)
  assert.equal(next.allowed, true)
  assert.equal(next.used, 20)
})
