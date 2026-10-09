import { test } from 'node:test'
import assert from 'node:assert'
import * as g from '../src/gateway.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0) // 9 Oct 2026, noon UTC
const TUNNEL = 'https://glad-stone-tiger.trycloudflare.com'
const kaggle = (over = {}) => ({ url: TUNNEL, p50_ms: 250, last_beat: NOW - 10_000, ...over })

function planWith(over = {}) {
  return g.plan({
    kind: 'guard', now: NOW, cache: null, usage: { total: 0, tester: 0 },
    backend: null, estNeurons: 7, ...over,
  })
}

// --- §34.3 request contract ---------------------------------------------------

test('validateDecideRequest accepts the §34.3 guard body', () => {
  const req = g.validateDecideRequest({
    state: {
      brief: 'Fix the failing date tests in api/. Don\'t touch the db folder.',
      agent: 'claude-code',
      cwd: 'C:/work/shop',
      action: { tool: 'Bash', command: 'rm -rf db/migrations' },
    },
    questions: [
      { id: 'in_scope', type: 'noul', text: 'Is this action part of what the brief asks?' },
      { id: 'risk', type: 'score', text: 'How risky is this?', scale: [1, 2, 3, 4, 5] },
      {
        id: 'verdict', type: 'choice', text: 'What should happen next?',
        options: ['allow', 'savepoint_then_allow', 'ask_user', 'skip_duplicate', 'deny', 'brake'],
      },
    ],
  })
  assert.equal(req.questions.length, 3)
  assert.deepEqual(req.questions[1].scale, [1, 2, 3, 4, 5])
  assert.equal(req.questions[2].options.length, 6)
})

test('validateDecideRequest defaults a score scale to §34.3\'s 1..5', () => {
  const req = g.validateDecideRequest({ state: {}, questions: [{ id: 'risk', type: 'score', text: 't' }] })
  assert.deepEqual(req.questions[0].scale, g.DEFAULT_SCALE)
})

test('validateDecideRequest still accepts §29.5\'s choices, normalized to options', () => {
  const req = g.validateDecideRequest({
    state: {}, questions: [{ id: 'v', type: 'choice', text: 't', choices: ['allow', 'deny'] }],
  })
  assert.deepEqual(req.questions[0].options, ['allow', 'deny'])
})

test('validateDecideRequest rejects bad input', () => {
  const bad = [
    null,
    [],
    { questions: [{ id: 'a', type: 'noul', text: 't' }] }, // no state
    { state: {}, questions: [] },
    { state: {}, questions: [{ id: 'a', type: 'bogus', text: 't' }] },
    { state: {}, questions: [{ id: 'a', type: 'noul' }] }, // no text
    { state: {}, questions: [{ type: 'noul', text: 't' }] }, // no id
    { state: {}, questions: [{ id: 'a', type: 'choice', text: 't', options: ['only'] }] },
    { state: {}, questions: [{ id: 'a', type: 'choice', text: 't', options: ['x', 'x'] }] },
    { state: {}, questions: [{ id: 'a', type: 'score', text: 't', scale: [3] }] },
    { state: {}, questions: [{ id: 'a', type: 'noul', text: 't' }, { id: 'a', type: 'noul', text: 'u' }] },
    { state: {}, questions: Array.from({ length: g.MAX_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, type: 'noul', text: 't' })) },
  ]
  for (const body of bad) assert.throws(() => g.validateDecideRequest(body), (e) => e.status >= 400, JSON.stringify(body))
})

// --- §37.2 neuron estimate ----------------------------------------------------

test('estimateNeurons follows §37.2: ceil(bytes/4) tokens at 8182 per million', () => {
  assert.equal(g.estimateNeurons(3200), 7) // 800 tokens, the §34.3 budget
  assert.equal(g.estimateNeurons(0), 1) // never free: a reservation always moves the meter
  // §37.2 claims the 9,000-neuron cap covers roughly 1,500 decisions a day.
  assert.ok(g.TOTAL_CAP / g.estimateNeurons(3200) > 1200)
})

// --- §37.3 route order --------------------------------------------------------

test('a tight kind calls Workers AI first, even with a fast Kaggle up', () => {
  for (const kind of ['guard', 'voice']) {
    const p = planWith({ kind, backend: kaggle() })
    assert.equal(p.route, 'workers_ai', kind)
    assert.equal(p.reserve, 7)
  }
})

test('a loose kind calls Kaggle first, which saves free neurons', () => {
  for (const kind of ['triage', 'receipt', 'showme']) {
    const p = planWith({ kind, backend: kaggle({ p50_ms: 1200 }) })
    assert.equal(p.route, 'kaggle', kind)
    assert.equal(p.url, TUNNEL)
    assert.equal(p.reserve, 0, 'a Kaggle call reserves no neurons')
  }
})

test('a loose kind falls back to Workers AI when Kaggle is down', () => {
  const p = planWith({ kind: 'receipt', backend: null })
  assert.equal(p.route, 'workers_ai')
})

test('a tight deadline refuses a Kaggle whose measured median does not fit', () => {
  const slow = planWith({ kind: 'guard', backend: kaggle({ p50_ms: 1200 }), usage: { total: g.TOTAL_CAP, tester: 0 } })
  assert.equal(slow.route, 'fallback')
  assert.match(slow.reason, /kaggle_too_slow/)
  const fast = planWith({ kind: 'guard', backend: kaggle({ p50_ms: 250 }), usage: { total: g.TOTAL_CAP, tester: 0 } })
  assert.equal(fast.route, 'kaggle')
})

test('Kaggle is dropped once its heartbeat is over 180 s old (§37.4)', () => {
  const fresh = planWith({ kind: 'receipt', backend: kaggle({ last_beat: NOW - (g.BACKEND_STALE_MS - 1000) }) })
  assert.equal(fresh.route, 'kaggle')
  const stale = planWith({ kind: 'receipt', backend: kaggle({ last_beat: NOW - (g.BACKEND_STALE_MS + 1000) }) })
  assert.equal(stale.route, 'workers_ai')
  const staleAndBroke = planWith({
    kind: 'receipt', backend: kaggle({ last_beat: NOW - (g.BACKEND_STALE_MS + 1000) }),
    usage: { total: g.TOTAL_CAP, tester: 0 },
  })
  assert.equal(staleAndBroke.route, 'fallback')
  assert.match(staleAndBroke.reason, /kaggle_down/)
})

// --- §37.2 caps ---------------------------------------------------------------

test('the 9,000-neuron total cap sends guard calls to Kaggle, then to rules', () => {
  const usage = { total: g.TOTAL_CAP - 3, tester: 0 } // 3 left, 7 needed
  assert.equal(planWith({ usage, backend: kaggle() }).route, 'kaggle')
  const rules = planWith({ usage, backend: null })
  assert.equal(rules.route, 'fallback')
  assert.equal(rules.reason, 'total_cap+kaggle_down')
  assert.equal(rules.reserve, 0, 'a fallback spends nothing')
})

test('a tester over the 1,200-neuron soft cap goes to Kaggle, then to rules', () => {
  const usage = { total: 10, tester: g.TESTER_CAP - 3 }
  assert.equal(planWith({ usage, backend: kaggle() }).route, 'kaggle')
  const rules = planWith({ usage, backend: null })
  assert.equal(rules.route, 'fallback')
  assert.equal(rules.reason, 'tester_cap+kaggle_down')
})

test('one tester at the cap does not stop another tester', () => {
  assert.equal(planWith({ usage: { total: 1200, tester: 0 } }).route, 'workers_ai')
})

// --- §34.8 cache and deadlines ------------------------------------------------

test('a live cache entry wins over every backend and spends nothing', () => {
  const answers = { in_scope: { p_yes: 0.9 } }
  const p = planWith({ cache: { answers, expires: NOW + 1 }, backend: kaggle() })
  assert.equal(p.route, 'cache')
  assert.deepEqual(p.answers, answers)
  assert.equal(p.reserve, 0)
})

test('an expired cache entry is ignored', () => {
  assert.equal(planWith({ cache: { answers: {}, expires: NOW - 1 } }).route, 'workers_ai')
})

test('the deadline header can tighten a kind\'s deadline but never extend it', () => {
  assert.equal(planWith({ deadlineMs: 5000 }).deadlineMs, g.KINDS.guard.deadline)
  assert.equal(planWith({ deadlineMs: 120 }).deadlineMs, 120)
  assert.equal(planWith({ deadlineMs: 0 }).deadlineMs, g.KINDS.guard.deadline)
})

test('an unknown kind is treated as the tightest one, never the loosest', () => {
  assert.equal(g.kindOf('nonsense'), 'guard')
  assert.equal(g.kindOf(null), 'guard')
  assert.equal(planWith({ kind: 'nonsense', backend: kaggle({ p50_ms: 1200 }) }).route, 'workers_ai')
})

// --- §34.9 R6 answer shape ----------------------------------------------------

const QUESTIONS = g.validateDecideRequest({
  state: {},
  questions: [
    { id: 'in_scope', type: 'noul', text: 't' },
    { id: 'risk', type: 'score', text: 't', scale: [1, 2, 3, 4, 5] },
    { id: 'verdict', type: 'choice', text: 't', options: ['allow', 'deny', 'brake'] },
  ],
}).questions

test('parseClefAnswers returns the §34.9 R6 shapes', () => {
  const out = g.parseClefAnswers(QUESTIONS, {
    answers: {
      in_scope: { p_yes: 0.82 },
      risk: { value: 4 },
      verdict: { probabilities: { allow: 1, deny: 3, brake: 0 } }, // does not sum to 1
    },
  })
  assert.ok(out.ok, out.reason)
  assert.deepEqual(out.answers.in_scope, { p_yes: 0.82 })
  assert.deepEqual(out.answers.risk, { value: 4 })
  assert.equal(out.answers.verdict.choice, 'deny')
  assert.equal(out.answers.verdict.confidence, 0.75)
  assert.equal(out.answers.verdict.probabilities.allow, 0.25)
})

test('parseClefAnswers accepts a list, a bare map and the prob/score aliases', () => {
  const list = g.parseClefAnswers(QUESTIONS, [
    { id: 'in_scope', prob: 0.3 },
    { id: 'risk', score: 2 },
    { id: 'verdict', probs: { allow: 0.5, deny: 0.5, brake: 0 } },
  ])
  assert.ok(list.ok, list.reason)
  assert.equal(list.answers.in_scope.p_yes, 0.3)
  assert.equal(list.answers.risk.value, 2)

  const bare = g.parseClefAnswers([QUESTIONS[0]], { in_scope: 0.6 })
  assert.ok(bare.ok, bare.reason)
  assert.equal(bare.answers.in_scope.p_yes, 0.6)
})

test('parseClefAnswers clamps a 1% probability overshoot but refuses worse', () => {
  const near = g.parseClefAnswers([QUESTIONS[0]], { in_scope: { p_yes: 1.000001 } })
  assert.equal(near.answers.in_scope.p_yes, 1)
  assert.equal(g.parseClefAnswers([QUESTIONS[0]], { in_scope: { p_yes: 1.4 } }).ok, false)
  assert.equal(g.parseClefAnswers([QUESTIONS[0]], { in_scope: { p_yes: -2 } }).ok, false)
})

test('a 0..1 answer to a 1..5 score is refused, never read as "risk 1"', () => {
  const out = g.parseClefAnswers([QUESTIONS[1]], { risk: { value: 0.9 } })
  assert.equal(out.ok, false)
  assert.match(out.reason, /outside 1..5/)
})

test('a choice with no distribution is an unknown shape, not a verdict', () => {
  // §34.4 branches on the choice's confidence, so a bare choice cannot be acted on.
  const out = g.parseClefAnswers([QUESTIONS[2]], { verdict: { choice: 'allow' } })
  assert.equal(out.ok, false)
  assert.equal(g.parseClefAnswers([QUESTIONS[2]], { verdict: { probabilities: { allow: 0, deny: 0, brake: 0 } } }).ok, false)
})

test('a missing or unparsable answer is a fallback, not a guess', () => {
  assert.equal(g.parseClefAnswers(QUESTIONS, { answers: { in_scope: { p_yes: 0.9 } } }).ok, false)
  assert.equal(g.parseClefAnswers(QUESTIONS, 'I think it is fine').ok, false)
  assert.equal(g.parseClefAnswers([QUESTIONS[0]], { in_scope: { p_yes: 'maybe' } }).ok, false)
})

// --- K5 backend report, tokens and codes --------------------------------------

test('validateBackendReport takes an https tunnel and refuses anything else', () => {
  const ok = g.validateBackendReport({ url: `${TUNNEL}/`, p50_ms: 812.6 })
  assert.equal(ok.url, TUNNEL)
  assert.equal(ok.p50_ms, 813)
  for (const body of [null, {}, { url: 'http://x.trycloudflare.com', p50_ms: 1 }, { url: 'not a url', p50_ms: 1 }, { url: TUNNEL, p50_ms: -1 }, { url: TUNNEL }]) {
    assert.throws(() => g.validateBackendReport(body), (e) => e.status === 400, JSON.stringify(body))
  }
})

test('an invite code has no characters a tester could mistype', () => {
  const code = g.newInviteCode(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
  assert.equal(code.length, 8)
  assert.match(code, /^[A-HJ-NP-TV-Z2-9]+$/)
  assert.doesNotMatch(g.newInviteCode(new Uint8Array(Array.from({ length: 8 }, (_, i) => i * 7))), /[IO01]/)
})

test('a token is two UUIDs joined, as hex', () => {
  const token = g.newToken(() => '0196d6a4-1111-7000-8000-abcdefabcdef')
  assert.equal(token.length, 64)
  assert.match(token, /^[0-9a-f]{64}$/)
})

test('sortedJson is order-independent and median handles both lengths', () => {
  assert.equal(g.sortedJson({ b: 1, a: [2, { d: 3, c: 4 }] }), g.sortedJson({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.equal(g.median([]), null)
  assert.equal(g.median([5, 1, 3]), 3)
  assert.equal(g.median([4, 1, 3, 2]), 3) // (2+3)/2 rounded
})
