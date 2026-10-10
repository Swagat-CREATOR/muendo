import { test } from 'node:test'
import assert from 'node:assert'
import * as g from '../src/gateway.js'

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0) // 9 Oct 2026, noon UTC
const S = g.DEFAULT_SETTINGS
const CAP = S.total_cap

function planWith(over = {}) {
  return g.plan({
    kind: 'guard', now: NOW, cache: null, usage: { total: 0, code: 0, device: 0 }, estNeurons: 7, ...over,
  })
}

// Usage with `share` of the day's cap already spent.
const spent = (share) => ({ total: Math.round(share * CAP), code: 0, device: 0 })

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
  assert.ok(CAP / g.estimateNeurons(3200) > 1200)
})

// --- the route: answer cache, then Workers AI, then rules ----------------------

test('every kind calls Workers AI when the budget is fine, and reserves what it needs', () => {
  for (const kind of Object.keys(g.KINDS)) {
    const p = planWith({ kind })
    assert.equal(p.route, 'workers_ai', kind)
    assert.equal(p.reserve, 7, kind)
    assert.equal(p.rules_only, false, kind)
  }
})

test('nothing in the plan points anywhere but the cache, Workers AI or the rules', () => {
  const routes = new Set()
  for (const kind of Object.keys(g.KINDS)) {
    for (const share of [0, 0.5, 0.85, 0.96, 1]) {
      routes.add(planWith({ kind, usage: spent(share) }).route)
      routes.add(planWith({ kind, usage: spent(share), cache: { answers: {}, expires: NOW + 1 } }).route)
    }
  }
  assert.deepEqual([...routes].sort(), ['cache', 'fallback', 'workers_ai'])
})

// --- budget priorities ---------------------------------------------------------

test('under 20% left, receipts, triage and showme use rules only and voice uses keywords', () => {
  const low = spent(0.85) // 15% left
  for (const kind of ['receipt', 'triage', 'showme']) {
    const p = planWith({ kind, usage: low })
    assert.deepEqual([p.route, p.reason, p.reserve], ['fallback', 'budget_low_rules', 0], kind)
  }
  const voice = planWith({ kind: 'voice', usage: low })
  assert.deepEqual([voice.route, voice.reason], ['fallback', 'budget_low_keywords'])
})

test('Guard keeps the model when the budget is low, until 95% of the day is used', () => {
  assert.equal(planWith({ usage: spent(0.85) }).route, 'workers_ai', 'low but not out')
  assert.equal(planWith({ usage: spent(0.94) }).route, 'workers_ai', 'just under 95%')
  const out = planWith({ usage: { total: Math.ceil(0.95 * CAP) - 3, code: 0, device: 0 } }) // 3 left, 7 needed
  assert.deepEqual([out.route, out.reason], ['fallback', 'total_cap'])
  assert.equal(out.reserve, 0, 'a fallback spends nothing')
})

test('the edge of "low" is exactly 20% left', () => {
  assert.equal(planWith({ kind: 'receipt', usage: spent(0.8) }).route, 'workers_ai', '20% left is not under 20%')
  assert.equal(planWith({ kind: 'receipt', usage: { total: 0.8 * CAP + 1, code: 0, device: 0 } }).route, 'fallback')
})

test('rules_only is on every plan from 95% used, so the dock can say Rules only mode', () => {
  assert.equal(planWith({ usage: spent(0.94) }).rules_only, false)
  for (const kind of Object.keys(g.KINDS)) {
    const p = planWith({ kind, usage: spent(0.95) })
    assert.deepEqual([p.route, p.rules_only], ['fallback', true], kind)
  }
  const cached = planWith({ usage: spent(0.97), cache: { answers: {}, expires: NOW + 1 } })
  assert.deepEqual([cached.route, cached.rules_only], ['cache', true], 'a cached answer still says the day is out')
})

test('the priorities follow the settings table', () => {
  const settings = { ...S, low_budget_share: 0.5, guard_until_used: 0.6 }
  assert.equal(g.plan({ kind: 'receipt', now: NOW, usage: spent(0.55), estNeurons: 7, settings }).route, 'fallback')
  assert.equal(g.plan({ kind: 'guard', now: NOW, usage: spent(0.55), estNeurons: 7, settings }).route, 'workers_ai')
  assert.equal(g.plan({ kind: 'guard', now: NOW, usage: spent(0.65), estNeurons: 7, settings }).route, 'fallback')
})

// --- per device and per judge code ---------------------------------------------

test('a device at its cap falls back while its code and the day are fine', () => {
  const p = planWith({ usage: { total: 100, code: 100, device: S.device_cap - 3 } })
  assert.deepEqual([p.route, p.reason], ['fallback', 'device_cap'])
})

test('a judge code at its cap stops all of its devices', () => {
  const p = planWith({ usage: { total: 100, code: S.code_cap - 3, device: 0 } })
  assert.deepEqual([p.route, p.reason], ['fallback', 'code_cap'])
})

test('one device or code at its cap does not stop another', () => {
  assert.equal(planWith({ usage: { total: S.device_cap, code: 0, device: 0 } }).route, 'workers_ai')
})

// --- the settings table ---------------------------------------------------------

test('validateSettings merges over the defaults and refuses nonsense', () => {
  assert.deepEqual(g.validateSettings({}), S)
  assert.equal(g.validateSettings({ device_cap: 1500 }).device_cap, 1500)
  for (const bad of [
    { nope: 1 }, { device_cap: -1 }, { device_cap: 1.5 }, { low_budget_share: 2 }, { guard_until_used: 'x' },
    { devices_per_code: 0 }, { max_codes: 0 },
  ]) {
    assert.throws(() => g.validateSettings(bad), (e) => e.status === 400, JSON.stringify(bad))
  }
})

test('the day resets at the next 00:00 UTC', () => {
  assert.equal(new Date(g.resetAt(NOW)).toISOString(), '2026-10-10T00:00:00.000Z')
  assert.equal(new Date(g.resetAt(Date.UTC(2026, 11, 31, 23, 59))).toISOString(), '2027-01-01T00:00:00.000Z')
})

// --- §34.8 cache and deadlines ------------------------------------------------

test('a live cache entry wins over the model and the budget, and spends nothing', () => {
  const answers = { in_scope: { p_yes: 0.9 } }
  const p = planWith({ kind: 'receipt', cache: { answers, expires: NOW + 1 }, usage: spent(0.9) })
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
  // Low budget: an unknown kind keeps the model like Guard does, rather than being dropped like a receipt.
  assert.equal(planWith({ kind: 'nonsense', usage: spent(0.9) }).route, 'workers_ai')
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

// --- tokens and codes ---------------------------------------------------------

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
