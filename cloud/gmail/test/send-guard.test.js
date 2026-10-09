import { test } from 'node:test'
import assert from 'node:assert'
import {
  ALLOW_BAR, DEADLINE_MS, RULES_BUDGET_MS, SEND_GUARD_QUESTIONS, GMAIL_SEND_SCOPE,
  checkRules, buildDecisionRequest, readAllowProbability, guardSend, logFields,
  assertSendOnlyScope, buildRawMessage, skeleton, withinOneEdit,
} from '../src/send-guard.js'

// A fake decision service. Never a real HTTP call: §28.4 step 4 is injected so
// the tests cover the decision, not the network.
function fakeDecide(p = 0.99, extra = {}) {
  return async () => ({
    answers: Object.fromEntries(SEND_GUARD_QUESTIONS.map((q) => [q.id, { p_yes: p }])),
    ...extra,
  })
}

const quiet = () => {} // swallow the decision log; one test asserts on it directly

// The happy path everything else deviates from: the §29.5 example, corrected —
// the recipient is the one the brief names, at the domain the brief names.
function clean() {
  const message = {
    from: 'me@mewndo.test',
    to: ['priya@acme.com'],
    subject: 'Q3 invoice',
    body: 'Hi Priya, the Q3 invoice is attached in the portal. Thanks.',
  }
  const context = {
    brief: 'Reply to Priya at priya@acme.com with the Q3 invoice. Do not email anyone else.',
    sender: 'me@mewndo.test',
    knownContacts: ['priya@acme.com'],
    thread: { participants: ['priya@acme.com', 'me@mewndo.test'] },
    card: { recipients: ['priya@acme.com'] },
    agent: 'claude',
    vendor: 'anthropic',
  }
  return { message, context }
}

function reasonsOf(result) {
  return result.reasons
}

// --- the clean baseline -------------------------------------------------------

test('the clean message has no rule hits at all', () => {
  const { message, context } = clean()
  const r = checkRules(message, context)
  assert.deepEqual(r.hits, [], `unexpected hits: ${JSON.stringify(r.hits)}`)
  assert.equal(r.ok, true)
})

// --- one test per hold reason (§28.4 Flow D step 2 and step 3) ----------------

test('hold: first-time recipient (named in no brief, thread, card or contact)', async () => {
  const { message, context } = clean()
  message.to = ['stranger@somewhere-else.test']
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('first_time_recipient'), JSON.stringify(result.reasons))
  assert.equal(result.sent, undefined, 'nothing is sent on a hold')
})

test('hold: a known contact who is not part of this task', async () => {
  const { message, context } = clean()
  // Known in the address book, but the brief, the thread and the card are all
  // about Priya. Not "first time" — a different problem, a different reason.
  context.knownContacts = ['priya@acme.com', 'raj@acme.com']
  message.to = ['raj@acme.com']
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('recipient_not_in_brief'), JSON.stringify(result.reasons))
  assert.ok(!reasonsOf(result).includes('first_time_recipient'))
})

test('hold: look-alike domain, one edit away from a known one (acme.co for acme.com)', async () => {
  const { message, context } = clean()
  message.to = ['priya@acme.co'] // the §29.5 example's trap
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('look_alike_domain'), JSON.stringify(result.reasons))
  const hit = result.hits.find((h) => h.rule === 'look_alike_domain')
  assert.deepEqual(hit.detail.matches, [{ domain: 'acme.co', looks_like: 'acme.com', how: 'one_edit' }])
})

test('hold: look-alike domain, a homoglyph (Cyrillic a) and an rn/m shape', () => {
  const { context } = clean()
  const cyrillic = checkRules({ to: ['priya@\u0430cme.com'], subject: 's', body: 'b' }, context)
  const how = (r) => r.hits.find((h) => h.rule === 'look_alike_domain')?.detail.matches[0].how
  assert.equal(how(cyrillic), 'confusable', 'Cyrillic a in acme.com')

  const rn = checkRules({ to: ['priya@acrne.com'], subject: 's', body: 'b' }, context)
  assert.equal(how(rn), 'confusable', 'acrne.com renders as acme.com')

  // And the real domain is not flagged against itself.
  assert.equal(skeleton('acrne.com'), skeleton('acme.com'))
  assert.equal(withinOneEdit('acme.com', 'acme.com'), false)
})

test('hold: too many recipients', async () => {
  const { message, context } = clean()
  message.to = Array.from({ length: 14 }, (_, n) => `p${n}@acme.com`)
  context.knownContacts = message.to // all known, so only the count can hold it
  context.brief = `Mail everyone: ${message.to.join(', ')}`
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('too_many_recipients'), JSON.stringify(result.reasons))
  assert.deepEqual(result.hits.find((h) => h.rule === 'too_many_recipients').detail, { count: 14, limit: 10 })
})

test('hold: external recipient with an attachment', async () => {
  const { message, context } = clean()
  message.attachments = [{ name: 'q3-invoice.pdf' }]
  // priya@acme.com is external to mewndo.test, which is the sender's domain.
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('external_with_attachment'), JSON.stringify(result.reasons))
  assert.deepEqual(result.hits.find((h) => h.rule === 'external_with_attachment').detail, { external: 1, attachments: 1 })
})

test('external_with_attachment is SKIPPED, not silently passed, with no sender domain', () => {
  const { message, context } = clean()
  message.attachments = [{ name: 'q3-invoice.pdf' }]
  delete context.sender
  const r = checkRules(message, context)
  assert.deepEqual(r.hits.map((h) => h.rule), [], 'no hit, because the rule could not run')
  assert.deepEqual(r.skipped.map((s) => s.rule), ['external_with_attachment'])
})

test('hold: secrets in the body, and personal data in an attachment name', async () => {
  const { message, context } = clean()
  context.sender = undefined // keep external_with_attachment out of this test's reasons
  context.internalDomains = ['acme.com']
  message.body = 'Here you go: AKIAIOSFODNN7EXAMPLE and password: hunter2hunter2'
  message.attachments = [{ name: 'priya-passport-scan.pdf' }]
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('secrets_or_personal_data'), JSON.stringify(result.reasons))
  const d = result.hits.find((h) => h.rule === 'secrets_or_personal_data').detail
  assert.deepEqual(d.in_text, ['aws_access_key', 'secret_assignment'])
  assert.deepEqual(d.in_attachment_names, ['identity_document'])
})

test('hold: leftover placeholders', async () => {
  const { message, context } = clean()
  message.body = 'Hi {name},\n\nTODO: say the thing. Lorem ipsum dolor sit amet.'
  const result = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(result.verdict, 'hold')
  assert.ok(reasonsOf(result).includes('leftover_placeholder'), JSON.stringify(result.reasons))
  const patterns = result.hits.find((h) => h.rule === 'leftover_placeholder').detail.patterns
  for (const p of ['todo', 'brace_placeholder', 'lorem_ipsum']) assert.ok(patterns.includes(p), `missing ${p}`)
})

test('a credit-card number holds, an invoice number of the same length does not', () => {
  const { message, context } = clean()
  const hits = (body) => checkRules({ ...message, body }, context).hits.map((h) => h.rule)
  assert.ok(hits('card 4111 1111 1111 1111').includes('secrets_or_personal_data'), 'Luhn-valid card')
  assert.ok(!hits('invoice 1234 5678 9012 3456').includes('secrets_or_personal_data'), 'Luhn-invalid run is not a card')
})

// --- no verdict is never a send (§29.4) ----------------------------------------

test('hold: the decision-service deadline passes — it never sends without a verdict', async () => {
  const { message, context } = clean()
  let sent = false
  // Answers "yes" to everything, but 50 ms too late.
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ answers: Object.fromEntries(SEND_GUARD_QUESTIONS.map((q) => [q.id, { p_yes: 1 }])) }), 60))
  const result = await guardSend(message, context, {
    decide: slow, deadlineMs: 10, log: quiet, send: async () => { sent = true },
  })
  assert.equal(result.verdict, 'hold')
  assert.deepEqual(result.reasons, ['no_verdict_deadline'])
  assert.equal(result.allow, null, 'no probability, because there was no answer')
  assert.equal(sent, false, 'the send wrapper is never reached')
  // Let the late answer land; it must change nothing.
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(sent, false)
})

test('hold: the decision service throws, answers in a shape we cannot read, or falls back to rules', async () => {
  const { message, context } = clean()
  const run = (decide) => guardSend(message, context, { decide, log: quiet })

  assert.deepEqual((await run(async () => { throw new Error('socket closed') })).reasons, ['no_verdict_error'])
  assert.deepEqual((await run(async () => ({ answers: { recipient_ok: { p_yes: 1 } } }))).reasons, ['no_verdict_unparsed'])
  assert.deepEqual((await run(async () => ({ answers: 'yes please' }))).reasons, ['no_verdict_unparsed'])
  assert.deepEqual((await run(fakeDecide(1, { source: 'rules' }))).reasons, ['no_verdict_fallback'])
  assert.deepEqual((await run(undefined)).reasons, ['no_verdict_error'])
})

// --- the 0.97 bar (§28.4 Flow D step 5) ------------------------------------------

test('the 0.97 bar: 0.969 holds, 0.970 releases', async () => {
  const { message, context } = clean()
  assert.equal(ALLOW_BAR, 0.97)

  const below = await guardSend(message, context, { decide: fakeDecide(0.969), log: quiet })
  assert.equal(below.verdict, 'hold')
  assert.deepEqual(below.reasons, ['allow_below_bar'])
  assert.equal(below.allow, 0.969)

  const atBar = await guardSend(message, context, { decide: fakeDecide(0.97), log: quiet })
  assert.equal(atBar.verdict, 'release', 'at the bar releases: the spec says "at least 0.97"')
  assert.equal(atBar.allow, 0.97)
})

test('the allow probability is the weakest answer, so one confident no sinks the send', async () => {
  const { message, context } = clean()
  const decide = async () => ({
    answers: { recipient_ok: { p_yes: 1 }, attachment_ok: { p_yes: 1 }, matches_task: { p_yes: 1 }, no_secrets: { p_yes: 0.2 } },
  })
  const r = await guardSend(message, context, { decide, log: quiet })
  assert.equal(r.allow, 0.2)
  assert.equal(r.verdict, 'hold')
  assert.deepEqual(r.reasons, ['allow_below_bar'])
})

test('a rule hit holds even when the model answers 1.0 to everything', async () => {
  const { message, context } = clean()
  message.to = ['priya@acme.co']
  const r = await guardSend(message, context, { decide: fakeDecide(1), log: quiet })
  assert.equal(r.verdict, 'hold')
  assert.equal(r.allow, 1, 'the model agreed, and it still does not release')
  assert.ok(r.reasons.includes('look_alike_domain'))
})

// --- an approved message sends ----------------------------------------------------

test('an approved message sends, through the injected send wrapper', async () => {
  const { message, context } = clean()
  const calls = []
  const result = await guardSend(message, context, {
    decide: fakeDecide(0.995),
    log: quiet,
    send: async (m, r) => { calls.push({ to: m.to, verdict: r.verdict }); return { id: 'sent-1' } },
  })
  assert.equal(result.verdict, 'release')
  assert.deepEqual(result.reasons, [])
  assert.deepEqual(result.sent, { id: 'sent-1' })
  assert.deepEqual(calls, [{ to: ['priya@acme.com'], verdict: 'release' }])
})

// --- one batched call, the §29.5 shape ---------------------------------------------

test('exactly ONE decision-service call, with every question batched', async () => {
  const { message, context } = clean()
  const seen = []
  await guardSend(message, context, { decide: async (req) => { seen.push(req); return (await fakeDecide(1)())  }, log: quiet })
  assert.equal(seen.length, 1, 'one call, not one per question')
  assert.deepEqual(seen[0].questions.map((q) => q.id), ['recipient_ok', 'attachment_ok', 'matches_task', 'no_secrets'])
  assert.ok(seen[0].questions.every((q) => q.type === 'noul'))
  assert.equal(seen[0].state.action.type, 'send_email')
})

test('the request carries the §28.4 step 3 context and masks secrets the rules found', () => {
  const { message, context } = clean()
  message.body = 'key AKIAIOSFODNN7EXAMPLE here'
  const req = buildDecisionRequest(message, context)
  assert.equal(req.state.context.first_time_recipient, false)
  assert.equal(req.state.context.recipient_in_brief, true)
  assert.equal(req.state.context.recipient_in_thread, true)
  assert.equal(req.state.context.recipient_in_card, true)
  assert.ok(req.state.action.body_excerpt.includes('[redacted:aws_access_key]'))
  assert.ok(!req.state.action.body_excerpt.includes('AKIAIOSFODNN7EXAMPLE'))

  // and shareBody:false drops the excerpt entirely
  assert.equal(buildDecisionRequest(message, { ...context, shareBody: false }).state.action.body_excerpt, undefined)
})

test('answers are read in every shape the gateway accepts', () => {
  const ids = SEND_GUARD_QUESTIONS.map((q) => q.id)
  const wrapped = { answers: Object.fromEntries(ids.map((id) => [id, { p_yes: 0.98 }])) }
  const bare = Object.fromEntries(ids.map((id) => [id, { prob: 0.98 }]))
  const asList = ids.map((id) => ({ id, p_yes: 0.98 }))
  const numbers = Object.fromEntries(ids.map((id) => [id, 0.98]))
  for (const raw of [wrapped, bare, asList, numbers]) {
    const r = readAllowProbability(raw)
    assert.equal(r.ok, true, JSON.stringify(raw))
    assert.equal(r.allow, 0.98)
  }
})

// --- logging: every decision, never the body (§28.7 guard_decisions) ---------------

test('every decision is logged with the verdict, rule hits, latency and probability — and no body', async () => {
  const { message, context } = clean()
  message.body = 'Secret sauce: the launch date is Tuesday.'
  message.subject = 'Launch date'
  const lines = []
  const r = await guardSend(message, context, { decide: fakeDecide(0.99), log: (e) => lines.push(e) })
  assert.equal(lines.length, 1)
  const entry = lines[0]
  assert.equal(entry.at, 'send_guard')
  assert.equal(entry.verdict, 'release')
  assert.deepEqual(entry.reasons, [])
  assert.equal(entry.allow, 0.99)
  assert.equal(entry.bar, ALLOW_BAR)
  assert.equal(entry.deadline_met, true)
  assert.equal(entry.fallback_used, false)
  assert.equal(typeof entry.latency_ms, 'number')
  assert.equal(typeof entry.rules_ms, 'number')
  assert.equal(entry.recipient_count, 1)
  assert.deepEqual(entry.recipient_domains, ['acme.com'])
  assert.equal(entry.agent, 'claude')
  // the body and the subject appear only as fingerprints and a byte count
  const text = JSON.stringify(entry)
  assert.ok(!text.includes('Secret sauce'), 'the body is not in the log')
  assert.ok(!text.includes('launch date is Tuesday'))
  assert.ok(!text.includes('Launch date'), 'the subject is not in the log')
  assert.ok(!text.includes('priya@acme.com'), 'recipients are reduced to domains')
  assert.match(entry.body_fp, /^[0-9a-f]{16}$/)
  assert.equal(entry.body_bytes, 41)
  assert.equal(r.verdict, 'release')

  // a held message is logged too, with its reasons
  const held = []
  await guardSend({ ...message, to: ['x@acme.co'] }, context, { decide: fakeDecide(0.99), log: (e) => held.push(e) })
  assert.equal(held.length, 1)
  assert.equal(held[0].verdict, 'hold')
  assert.ok(held[0].reasons.length > 0)
})

test('logFields never carries a body even when every rule hit', () => {
  const entry = logFields(
    { to: ['a@b.test'], subject: 'S', body: 'AKIAIOSFODNN7EXAMPLE', attachments: [{ name: 'id_rsa' }] },
    { brief: 'B' },
    { verdict: 'hold', reasons: ['secrets_or_personal_data'], hits: [], skipped: [], allow: null, rules_ms: 1, latency_ms: 2 },
  )
  assert.ok(!JSON.stringify(entry).includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!JSON.stringify(entry).includes('id_rsa'), 'attachment names are fingerprinted too')
})

// --- the 5 ms rule budget (§28.4 step 2) --------------------------------------------

test('the rule pass stays inside its 5 ms budget on this machine', () => {
  // A budget guard, not a published benchmark: it measures whatever box runs the
  // tests. docs/latency.md owns the real numbers.
  const { message, context } = clean()
  message.body = 'Hello Priya. '.repeat(400) // ~5 KB, a realistic long email
  message.to = Array.from({ length: 8 }, (_, n) => `p${n}@acme.com`)
  checkRules(message, context) // warm up
  const runs = 200
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < runs; i++) checkRules(message, context)
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / runs
  assert.ok(perCallMs < RULES_BUDGET_MS, `${perCallMs.toFixed(3)} ms per rule pass, budget ${RULES_BUDGET_MS} ms`)
})

// --- the Gmail send wrapper (send scope only) -----------------------------------------

test('the send wrapper refuses a token that holds more than gmail.send', () => {
  assert.equal(assertSendOnlyScope(GMAIL_SEND_SCOPE), true)
  assert.equal(assertSendOnlyScope([GMAIL_SEND_SCOPE]), true)
  assert.equal(assertSendOnlyScope([]), true)
  assert.throws(
    () => assertSendOnlyScope(`${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.modify`),
    /refusing a token that also holds: .*gmail\.modify/,
  )
})

test('buildRawMessage writes only the headers Send Guard checked', () => {
  const raw = buildRawMessage({ from: 'me@mewndo.test', to: ['Priya <priya@acme.com>'], cc: ['raj@acme.com'], subject: 'Q3', body: 'line one\nline two' })
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  assert.match(text, /^From: me@mewndo\.test\r\nTo: priya@acme\.com\r\nCc: raj@acme\.com\r\nSubject: Q3\r\n/)
  assert.match(text, /\r\n\r\nline one\r\nline two$/)
  assert.ok(!text.includes('Bcc:'), 'no empty Bcc header')
})

test('the deadline default is the §29.4 Send Guard figure', () => {
  assert.equal(DEADLINE_MS, 100)
})
