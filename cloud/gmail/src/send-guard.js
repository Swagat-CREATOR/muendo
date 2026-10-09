'use strict'
// Send Guard (spec §28.4 Flow D, §29.4, §29.5; build prompt P5.5).
//
// When an agent calls `send_email`, this module decides release or hold. It is
// runtime-free on purpose — no Workers globals, no fetch, no storage — so the
// Worker and `node --test` run exactly the same decision code (same shape as
// src/heal.js). The only piece that talks to the network is sendViaGmail() at
// the bottom, and the decision service is injected as a function, so a test
// never makes an HTTP call.
//
// The order is the Flow D order, and it matters:
//   1. rules       (§28.4 step 2, budget: under 5 ms)  — pure, local, no network
//   2. context     (§28.4 step 3)                      — brief / thread / Continue card
//   3. ONE model call with every question batched (§28.4 step 4, §29.3 point 3)
//   4. release only if every rule passed AND P(allow) >= 0.97 (§28.4 step 5)
//
// The single rule that outranks everything: **never send without a verdict**
// (§29.4, Send Guard row). A deadline timeout, a transport error, an answer we
// can't parse and a rules-only fallback from the decision service are all HOLDS.
// There is no code path from "we don't know" to "sent".
//
// Privacy: nothing here logs a subject or a body. Logs carry rule ids, counts,
// latencies, probabilities and fingerprints only (see logFields()).

// --- constants ---------------------------------------------------------------

// §28.4 Flow D step 5. Not a tunable: below this the message is held.
export const ALLOW_BAR = 0.97

// §29.4, "Send Guard (MCP or Mail Guard)" row: 100 ms, then hold.
export const DEADLINE_MS = 100

// §28.4 step 2 budget for the whole rule pass.
export const RULES_BUDGET_MS = 5

// The spec names the rule ("too many recipients") but not a number. 10 is a
// default, not a spec figure; callers override with context.maxRecipients.
export const DEFAULT_MAX_RECIPIENTS = 10

// §29.3 point 2: a compact action summary, not whole emails. The excerpt is cut
// to this many characters and every rule-detected secret inside it is masked
// before it leaves this process. context.shareBody === false drops it entirely.
export const DEFAULT_BODY_EXCERPT_CHARS = 2000

// §28.4 step 4 / §29.5. One request, four questions, one prefill.
export const SEND_GUARD_QUESTIONS = [
  { id: 'recipient_ok', type: 'noul', text: 'Is every recipient the person the brief names?' },
  { id: 'attachment_ok', type: 'noul', text: 'Does the attachment belong to this recipient?' },
  { id: 'matches_task', type: 'noul', text: 'Does this email do what the brief asks?' },
  { id: 'no_secrets', type: 'noul', text: 'Is this email free of secrets and personal data?' },
]

// Every reason a send can be held, so the bar, the phone and the tests all name
// the same thing. Order is the order they are reported in.
export const HOLD_REASONS = [
  'first_time_recipient',
  'recipient_not_in_brief',
  'look_alike_domain',
  'too_many_recipients',
  'external_with_attachment',
  'secrets_or_personal_data',
  'leftover_placeholder',
  'no_verdict_deadline',
  'no_verdict_error',
  'no_verdict_unparsed',
  'no_verdict_fallback',
  'allow_below_bar',
]

// --- addresses ---------------------------------------------------------------

// "Priya <priya@acme.com>" -> "priya@acme.com". Lowercased, because a look-alike
// check that is case-sensitive is no check at all.
export function addressOf(entry) {
  const s = String(entry ?? '')
  const angled = s.match(/<([^>]*)>/)
  return (angled ? angled[1] : s).trim().toLowerCase()
}

export function domainOf(address) {
  const at = address.lastIndexOf('@')
  return at < 0 ? '' : address.slice(at + 1).replace(/\.$/, '')
}

function list(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).map(addressOf).filter(Boolean)
}

// Every address the message goes to, deduplicated but counted once per field so
// "too many recipients" sees what the user would see.
function allRecipients(message) {
  return [...new Set([...list(message?.to), ...list(message?.cc), ...list(message?.bcc)])]
}

// --- context: brief, thread, Continue card (§28.4 step 3) ----------------------

// Free text (a brief, a card body) counts as naming an address if the address
// appears in it literally. Addresses are the only thing we can match without
// guessing, so "Priya" alone in a brief does NOT make priya@acme.com known —
// that is a deliberate false-hold rather than a false-send.
function namesAddress(text, address) {
  return typeof text === 'string' && text.toLowerCase().includes(address)
}

function cardOf(context) {
  const card = context?.card ?? context?.continue_card
  if (!card) return { recipients: [], text: '' }
  if (typeof card === 'string') return { recipients: [], text: card }
  return { recipients: list(card.recipients), text: typeof card.text === 'string' ? card.text : '' }
}

// Where, if anywhere, this address is already known. Four independent sources,
// because the hold reason differs: "never seen anywhere" is not the same problem
// as "a contact you know, but not one this task is about".
export function recipientSources(address, context) {
  const card = cardOf(context)
  const thread = list(context?.thread?.participants ?? context?.thread)
  return {
    brief: list(context?.briefRecipients).includes(address) || namesAddress(context?.brief, address),
    thread: thread.includes(address),
    card: card.recipients.includes(address) || namesAddress(card.text, address),
    contacts: list(context?.knownContacts).includes(address),
  }
}

// --- look-alike domains --------------------------------------------------------

// Homoglyphs an attacker actually uses: Cyrillic and Greek letters that render
// as Latin ones, plus digit/letter swaps and the two-letter shapes (rn -> m,
// vv -> w). Mapped to a "skeleton"; two domains with the same skeleton but
// different bytes are a look-alike pair. This is a short table, not the full
// Unicode confusables file — see the README's honest limits.
const CONFUSABLES = new Map(Object.entries({
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ԛ: 'q', ѕ: 's',
  ο: 'o', α: 'a', ρ: 'p', ε: 'e', ι: 'i', ν: 'v', κ: 'k', τ: 't', υ: 'u',
  ⅼ: 'l', ӏ: 'l', '０': '0', '１': '1',
  0: 'o', 1: 'l', 5: 's', 3: 'e', 4: 'a', 7: 't', 8: 'b',
}))

export function skeleton(domain) {
  let out = ''
  for (const ch of String(domain).toLowerCase()) out += CONFUSABLES.get(ch) ?? ch
  return out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/-/g, '')
}

// One insertion, deletion, substitution or transposition apart. Bounded and
// early-exiting, so it stays cheap inside the 5 ms budget.
export function withinOneEdit(a, b) {
  if (a === b) return false
  const [s, t] = a.length >= b.length ? [a, b] : [b, a]
  if (s.length - t.length > 1) return false
  let i = 0
  while (i < t.length && s[i] === t[i]) i++
  if (i === t.length) return true // one trailing character added
  if (s.length === t.length) {
    // substitution, or a transposition of two neighbours
    if (s.slice(i + 1) === t.slice(i + 1)) return true
    return s[i] === t[i + 1] && s[i + 1] === t[i] && s.slice(i + 2) === t.slice(i + 2)
  }
  return s.slice(i + 1) === t.slice(i) // one character inserted
}

// Everything we have reason to believe is a real domain for this user.
export function knownDomains(context) {
  const out = new Set()
  const add = (addr) => { const d = domainOf(addr); if (d) out.add(d) }
  for (const a of list(context?.knownContacts)) add(a)
  for (const a of list(context?.briefRecipients)) add(a)
  for (const a of list(context?.thread?.participants ?? context?.thread)) add(a)
  for (const a of cardOf(context).recipients) add(a)
  for (const a of list(context?.sender)) add(a)
  for (const d of context?.knownDomains ?? []) out.add(String(d).toLowerCase())
  for (const d of internalDomains(context)) out.add(d)
  // Addresses written inside the brief or the card count too: that is where a
  // first, legitimate recipient usually appears.
  for (const text of [context?.brief, cardOf(context).text]) {
    for (const m of String(text ?? '').toLowerCase().matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/g)) out.add(m[1])
  }
  return out
}

// Why this domain looks like one of the known ones, or null.
export function lookAlikeOf(domain, known) {
  if (!domain || known.has(domain)) return null
  // An unknown internationalised domain is a hit on sight: we deliberately do
  // not decode punycode (that would be a dependency), so we cannot prove it is
  // safe, and §29.4 says an unprovable send is held.
  if (domain.split('.').some((label) => label.startsWith('xn--'))) return { of: null, how: 'punycode' }
  const skel = skeleton(domain)
  for (const k of known) {
    if (skeleton(k) === skel) return { of: k, how: 'confusable' }
  }
  for (const k of known) {
    if (withinOneEdit(domain, k)) return { of: k, how: 'one_edit' }
  }
  return null
}

// --- secrets, personal data, placeholders ---------------------------------------

// Patterns, not understanding. Each one is a shape a secret has; a match holds
// the message. False positives cost a click, a false negative costs the secret,
// so the bias is deliberate. Defined at module scope so no regex is rebuilt per
// call (the 5 ms budget).
const SECRET_PATTERNS = [
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private_key_block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['openai_style_key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['secret_assignment', /\b(?:password|passwd|secret|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\b\s*[:=]\s*\S{6,}/i],
]

const PERSONAL_PATTERNS = [
  ['us_ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['india_pan', /\b[A-Z]{5}[0-9]{4}[A-Z]\b/],
  // 12 digits in 4-4-4 groups. The lookarounds keep it from firing on a slice of
  // a LONGER digit run: "invoice 1234 5678 9012 3456" is not an Aadhaar number,
  // and holding every 16-digit reference would make the rule useless.
  ['aadhaar', /(?<!\d)(?<!\d[ -])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![ -]?\d)/],
  ['iban', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,28}\b/],
]

// A 13-to-19 digit run that passes Luhn. The Luhn check is what keeps order
// numbers and invoice references from holding every finance email.
function hasCardNumber(text) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true
  }
  return false
}

function luhn(digits) {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

// Attachment names that say what the file is without opening it. Send Guard
// never reads attachment bytes (it does not have them) — this is name-only.
const ATTACHMENT_PATTERNS = [
  ['key_file', /\.(?:pem|key|pfx|p12|jks|kdbx|ppk|asc)$/i],
  ['dotenv', /(?:^|[/\\.])\.env(?:\.|$)/i],
  ['ssh_key', /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i],
  ['identity_document', /\b(?:passport|aadhaar|aadhar|pan[_ -]?card|driver'?s?[_ -]?licen[cs]e)\b/i],
  ['payroll_document', /\b(?:payslip|pay[_ -]?stub|salary|payroll|w-?2|p60|form[_ -]?16|bank[_ -]?statement)\b/i],
  ['credential_dump', /\b(?:credentials?|passwords?|secrets?)\b/i],
]

// Leftover template text. TODO/FIXME/XXX are matched uppercase-only on purpose:
// "my todo list" is English, "TODO" is an unfinished draft.
const PLACEHOLDER_PATTERNS = [
  ['todo', /\bTODO\b/],
  ['fixme', /\bFIXME\b/],
  ['xxx', /\bXXX\b/],
  ['brace_placeholder', /\{\{?\s*[A-Za-z_][\w .-]*\s*\}?\}/],
  ['bracket_placeholder', /\[(?:name|company|date|amount|client|recipient|x{2,})\]/i],
  ['lorem_ipsum', /lorem ipsum/i],
  ['insert_here', /<\s*insert\b[^>]*>|\binsert (?:name|here|text)\b/i],
]

function matchedIds(patterns, text) {
  const ids = []
  for (const [id, re] of patterns) if (re.test(text)) ids.push(id)
  return ids
}

// --- internal vs external ------------------------------------------------------

function internalDomains(context) {
  const out = new Set()
  for (const d of context?.internalDomains ?? []) out.add(String(d).toLowerCase())
  if (context?.internalDomain) out.add(String(context.internalDomain).toLowerCase())
  for (const a of list(context?.sender)) { const d = domainOf(a); if (d) out.add(d) }
  return out
}

// --- the rule pass (§28.4 step 2 and step 3) ------------------------------------

/**
 * Every Flow D rule, pure and local. No clock, no network, no storage: the same
 * inputs always give the same answer, which is what makes it testable and what
 * keeps it inside the 5 ms budget.
 *
 * Returns { ok, hits: [{rule, detail}], skipped: [{rule, why}], facts }.
 * `facts` is the context lookup (§28.4 step 3) so buildDecisionRequest does not
 * redo it. `detail` never contains message text — ids, counts and domains only.
 */
export function checkRules(message, context = {}) {
  const hits = []
  const skipped = []
  const to = allRecipients(message)
  const limit = Number.isFinite(context.maxRecipients) ? context.maxRecipients : DEFAULT_MAX_RECIPIENTS
  const attachments = (message?.attachments ?? []).map((a) => String(a?.name ?? a ?? ''))
  const subject = String(message?.subject ?? '')
  const body = String(message?.body ?? '')
  const known = knownDomains(context)
  const internal = internalDomains(context)

  // step 3: brief / thread / Continue card, per recipient.
  const sources = {}
  for (const addr of to) sources[addr] = recipientSources(addr, context)

  // 1. first-time recipient: named nowhere at all.
  const firstTime = to.filter((a) => !Object.values(sources[a]).some(Boolean))
  if (firstTime.length) hits.push({ rule: 'first_time_recipient', detail: { count: firstTime.length, domains: [...new Set(firstTime.map(domainOf))] } })

  // 2. a known contact who is not part of THIS task. Separate from (1) because
  //    the fix is different: the user confirms the person, not the address.
  const notInTask = to.filter((a) => {
    const s = sources[a]
    return s.contacts && !s.brief && !s.card && !s.thread
  })
  if (notInTask.length) hits.push({ rule: 'recipient_not_in_brief', detail: { count: notInTask.length } })

  // 3. look-alike domains.
  const lookAlikes = []
  for (const addr of to) {
    const d = domainOf(addr)
    const la = lookAlikeOf(d, known)
    if (la) lookAlikes.push({ domain: d, looks_like: la.of, how: la.how })
  }
  if (lookAlikes.length) hits.push({ rule: 'look_alike_domain', detail: { matches: lookAlikes } })

  // 4. too many recipients.
  if (to.length > limit) hits.push({ rule: 'too_many_recipients', detail: { count: to.length, limit } })

  // 5. external recipient with attachments. Without a sender or internal domain
  //    we cannot tell internal from external, so the rule is SKIPPED and said so
  //    in the log — it is not quietly treated as a pass.
  if (attachments.length) {
    if (internal.size === 0) {
      skipped.push({ rule: 'external_with_attachment', why: 'no sender or internal domain configured' })
    } else {
      const external = to.filter((a) => !internal.has(domainOf(a)))
      if (external.length) {
        hits.push({ rule: 'external_with_attachment', detail: { external: external.length, attachments: attachments.length } })
      }
    }
  }

  // 6. secrets and personal data, in the body and in attachment NAMES.
  const haystack = `${subject}\n${body}`
  const found = [
    ...matchedIds(SECRET_PATTERNS, haystack),
    ...matchedIds(PERSONAL_PATTERNS, haystack),
    ...(hasCardNumber(haystack) ? ['card_number'] : []),
  ]
  const inNames = []
  for (const name of attachments) {
    inNames.push(...matchedIds(ATTACHMENT_PATTERNS, name), ...matchedIds(SECRET_PATTERNS, name))
  }
  if (found.length || inNames.length) {
    hits.push({ rule: 'secrets_or_personal_data', detail: { in_text: [...new Set(found)], in_attachment_names: [...new Set(inNames)] } })
  }

  // 7. leftover placeholders, in subject, body and attachment names.
  const placeholders = [...new Set([
    ...matchedIds(PLACEHOLDER_PATTERNS, haystack),
    ...attachments.flatMap((n) => matchedIds(PLACEHOLDER_PATTERNS, n)),
  ])]
  if (placeholders.length) hits.push({ rule: 'leftover_placeholder', detail: { patterns: placeholders } })

  return {
    ok: hits.length === 0,
    hits,
    skipped,
    facts: {
      recipient_count: to.length,
      attachment_count: attachments.length,
      first_time_recipient: firstTime.length > 0,
      recipient_in_brief: to.length > 0 && to.every((a) => sources[a].brief),
      recipient_in_thread: to.length > 0 && to.every((a) => sources[a].thread),
      recipient_in_card: to.length > 0 && to.every((a) => sources[a].card),
      known_contacts: list(context?.knownContacts).length,
    },
  }
}

// --- the decision-service request (§28.4 step 4, §29.5 / §34.3 shape) ------------

// Mask anything the rules recognised, so a secret the rules found is never the
// thing we ship to a model to ask "does this contain a secret?".
function redact(text) {
  let out = text
  for (const [id, re] of [...SECRET_PATTERNS, ...PERSONAL_PATTERNS]) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), `[redacted:${id}]`)
  }
  return out.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[redacted:card_number]' : m))
}

/**
 * One request, every question batched (§29.3 point 3: one prefill answers all).
 * The shape is §29.5's, normalised the way cloud/gateway/src/gateway.js
 * validateDecideRequest() expects: { state, questions:[{id,type,text}] }.
 *
 * §29.3 point 2 says send a compact summary, not whole emails. So: recipients,
 * subject, attachment NAMES, the brief, the rule findings — and a redacted,
 * truncated body excerpt, which the model needs to answer "matches the task?".
 * context.shareBody === false drops the excerpt entirely.
 */
export function buildDecisionRequest(message, context = {}, rules = checkRules(message, context)) {
  const chars = Number.isFinite(context.bodyExcerptChars) ? context.bodyExcerptChars : DEFAULT_BODY_EXCERPT_CHARS
  const body = String(message?.body ?? '')
  const state = {
    brief: typeof context.brief === 'string' ? context.brief : '',
    action: {
      type: 'send_email',
      to: list(message?.to),
      cc: list(message?.cc),
      bcc_count: list(message?.bcc).length, // addresses, never the bcc list itself
      subject: String(message?.subject ?? ''),
      attachments: (message?.attachments ?? []).map((a) => ({ name: String(a?.name ?? a ?? ''), ...(a?.hash ? { hash: a.hash } : {}) })),
      ...(context.shareBody === false ? {} : { body_excerpt: redact(body).slice(0, chars) }),
      body_bytes: byteLength(body),
    },
    context: {
      known_contacts: list(context.knownContacts),
      thread_participants: list(context.thread?.participants ?? context.thread),
      card_recipients: cardOf(context).recipients,
      ...rules.facts,
      rule_hits: rules.hits.map((h) => h.rule),
      rules_skipped: rules.skipped.map((s) => s.rule),
    },
  }
  return { state, questions: SEND_GUARD_QUESTIONS.map((q) => ({ ...q })) }
}

// --- reading the model's answers -------------------------------------------------

// The same shapes cloud/gateway/src/gateway.js parseClefAnswers()/indexAnswers()
// accept (that file is the contract; read it before changing this): a map keyed
// by question id, a list of {id,...}, with or without an `answers` wrapper, and
// p_yes | prob | a bare number. Anything else is "unparsed", which is a HOLD —
// a shape we do not understand must never be able to approve a send.
export function readAllowProbability(raw, questions = SEND_GUARD_QUESTIONS) {
  if (raw && typeof raw === 'object' && (raw.fallback === true || raw.source === 'rules')) {
    return { ok: false, reason: 'no_verdict_fallback', why: 'the decision service answered from rules, not the model' }
  }
  const body = raw && typeof raw === 'object' && 'answers' in raw ? raw.answers : raw
  const byId = new Map()
  if (Array.isArray(body)) {
    for (const a of body) if (a && typeof a.id === 'string') byId.set(a.id, a)
  } else if (body && typeof body === 'object') {
    for (const [id, a] of Object.entries(body)) byId.set(id, a)
  }
  const perQuestion = {}
  for (const q of questions) {
    const got = byId.get(q.id)
    if (got == null || got === '') {
      return { ok: false, reason: 'no_verdict_unparsed', why: `no answer for ${q.id}` }
    }
    const value = typeof got === 'object' ? (got.p_yes ?? got.prob) : got
    const n = typeof value === 'number' ? value : parseFloat(value)
    if (!Number.isFinite(n) || n < -0.01 || n > 1.01) {
      return { ok: false, reason: 'no_verdict_unparsed', why: `${q.id}: probability outside 0..1` }
    }
    perQuestion[q.id] = n < 0 ? 0 : n > 1 ? 1 : n
  }
  // The weakest link, not a product: the questions are not independent (they all
  // look at the same email), so multiplying would understate confidence, and an
  // average would let three confident yeses drown one confident no. One "no"
  // must sink the send, so the allow probability is the minimum.
  const allow = Math.min(...Object.values(perQuestion))
  return { ok: true, allow, perQuestion }
}

// --- the whole decision (§28.4 Flow D) ---------------------------------------------

/**
 * Run Flow D end to end and return a verdict. Never throws for a model problem:
 * every failure becomes a hold.
 *
 * deps:
 *   decide(request, {signal})  required. The decision service, injected so tests
 *                              fake it and this module never calls fetch.
 *   now()                      clock, default Date.now — injected for tests.
 *   deadlineMs                 default DEADLINE_MS (100, §29.4).
 *   log(entry)                 default console.log(JSON.stringify(entry)).
 *   send(message, result)      optional; called only on a release.
 *
 * Returns { verdict:'release'|'hold', reasons:[], hits, skipped, allow,
 *           per_question, latency_ms, rules_ms, sent }.
 */
export async function guardSend(message, context = {}, deps = {}) {
  const now = deps.now ?? Date.now
  const deadlineMs = Number.isFinite(deps.deadlineMs) ? deps.deadlineMs : DEADLINE_MS
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)))
  const t0 = now()

  const rules = checkRules(message, context)
  const rulesMs = now() - t0

  // §28.4 step 4 runs even when a rule already failed: §29.5's last paragraph
  // says the model's answers become the explanation on the hold card. The
  // verdict is already decided by then; the model cannot overturn a rule hit.
  const request = buildDecisionRequest(message, context, rules)
  const model = await askWithDeadline(deps.decide, request, deadlineMs, now)

  const reasons = rules.hits.map((h) => h.rule)
  let allow = null
  let perQuestion = null
  if (!model.ok) {
    reasons.push(model.reason)
  } else {
    allow = model.allow
    perQuestion = model.perQuestion
    if (allow < ALLOW_BAR) reasons.push('allow_below_bar')
  }

  // Release needs BOTH: every rule passed and a real verdict at or above the
  // bar. `reasons` empty is the only way through, which is why every unknown
  // above pushes a reason.
  const verdict = reasons.length === 0 ? 'release' : 'hold'
  const result = {
    verdict,
    reasons,
    hits: rules.hits,
    skipped: rules.skipped,
    allow,
    per_question: perQuestion,
    rules_ms: rulesMs,
    model_ms: model.ms,
    latency_ms: now() - t0,
    ...(model.ok ? {} : { model_error: model.why }),
    ...(Number.isFinite(context.holdWindowMs) ? { hold_window_ms: context.holdWindowMs } : {}),
  }

  log(logFields(message, context, result))

  if (verdict === 'release' && deps.send) {
    result.sent = await deps.send(message, result)
  }
  return result
}

// A deadline that is a hold, not a send (§29.4). The model call is raced against
// a timer; if the timer wins, the answer is discarded even if it arrives later.
// No hedge to a second replica here: §29.4 puts the hedge in the decision
// service, and this Worker has one endpoint to call.
const TIMED_OUT = Symbol('send-guard deadline')

async function askWithDeadline(decide, request, deadlineMs, now) {
  if (typeof decide !== 'function') {
    return { ok: false, reason: 'no_verdict_error', why: 'no decision service configured', ms: 0 }
  }
  const started = now()
  let timer
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller) controller.abort()
      resolve(TIMED_OUT)
    }, deadlineMs)
  })
  const call = Promise.resolve().then(() => decide(request, { signal: controller?.signal, deadlineMs }))
  // The race may throw this promise away. A rejection that lands after the
  // deadline is already handled (it is a hold), so swallow it here rather than
  // let it surface as an unhandled rejection and take the Worker down.
  call.catch(() => {})
  try {
    const raw = await Promise.race([call, timeout])
    const ms = now() - started
    if (raw === TIMED_OUT) {
      return { ok: false, reason: 'no_verdict_deadline', why: `no answer within ${deadlineMs} ms`, ms }
    }
    return { ...readAllowProbability(raw, SEND_GUARD_QUESTIONS), ms }
  } catch (e) {
    return { ok: false, reason: 'no_verdict_error', why: String(e?.message ?? e), ms: now() - started }
  } finally {
    clearTimeout(timer)
  }
}

// --- logging (§28.7 guard_decisions) -------------------------------------------------

// What goes in the log, and nothing else. No subject, no body, no attachment
// contents. Recipients are reduced to a count and their domains, because the
// domain is what a reviewer needs to see for a look-alike hold.
//
// subject_fp / body_fp are 64-bit FNV-1a FINGERPRINTS, not cryptographic
// hashes: they exist so two log lines for the same draft can be matched up.
// A short body could in principle be guessed from one. They are not a privacy
// guarantee, they are a correlation id.
export function logFields(message, context, result) {
  const to = allRecipients(message)
  return {
    at: 'send_guard',
    verdict: result.verdict,
    reasons: result.reasons,
    rule_hits: result.hits.map((h) => ({ rule: h.rule, detail: h.detail })),
    rules_skipped: result.skipped.map((s) => s.rule),
    allow: result.allow,
    per_question: result.per_question,
    bar: ALLOW_BAR,
    rules_ms: result.rules_ms,
    model_ms: result.model_ms,
    latency_ms: result.latency_ms,
    deadline_met: !result.reasons.includes('no_verdict_deadline'),
    fallback_used: result.reasons.includes('no_verdict_fallback'),
    recipient_count: to.length,
    recipient_domains: [...new Set(to.map(domainOf))],
    attachment_count: (message?.attachments ?? []).length,
    attachment_name_fps: (message?.attachments ?? []).map((a) => fingerprint(String(a?.name ?? a ?? ''))),
    subject_fp: fingerprint(String(message?.subject ?? '')),
    body_fp: fingerprint(String(message?.body ?? '')),
    body_bytes: byteLength(String(message?.body ?? '')),
    agent: context?.agent ?? null,
    vendor: context?.vendor ?? null,
    brief_fp: fingerprint(String(context?.brief ?? '')),
  }
}

// FNV-1a 64-bit over UTF-8, synchronous so checkRules and logFields stay pure
// and inside the 5 ms budget. WebCrypto's SHA-256 is async, and an async hash
// would drag the rule pass onto the event loop for no security gain here.
export function fingerprint(text) {
  const bytes = new TextEncoder().encode(text)
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const b of bytes) {
    h = ((h ^ BigInt(b)) * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

function byteLength(text) {
  return new TextEncoder().encode(text).length
}

// --- the Gmail send (thin wrapper) ------------------------------------------------

// The ONLY scope Send Guard's credential may hold. gmail.send can send mail and
// nothing else: it cannot read, label or delete. The Rewind/Heal worker in
// index.js uses its own, broader credential; keeping them apart means a bug in
// Send Guard cannot read the mailbox, and a bug in Heal cannot send.
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

// Refuse to run with a token that was granted anything more. Google returns the
// granted scopes in the token response, so the caller can pass them here.
export function assertSendOnlyScope(scopes) {
  const granted = (typeof scopes === 'string' ? scopes.split(/\s+/) : (scopes ?? [])).filter(Boolean)
  const extra = granted.filter((s) => s !== GMAIL_SEND_SCOPE)
  if (extra.length) throw new Error(`Send Guard needs only ${GMAIL_SEND_SCOPE}; refusing a token that also holds: ${extra.join(', ')}`)
  return true
}

// RFC 2822 headers + body, base64url, as users.messages.send wants it. Only the
// headers Send Guard checked are written, so nothing it did not see can ride along.
export function buildRawMessage(message) {
  const header = (name, value) => `${name}: ${value}\r\n`
  const join = (v) => list(v).join(', ')
  let out = ''
  if (message?.from) out += header('From', addressOf(message.from))
  out += header('To', join(message?.to))
  if (list(message?.cc).length) out += header('Cc', join(message?.cc))
  if (list(message?.bcc).length) out += header('Bcc', join(message?.bcc))
  if (message?.inReplyTo) out += header('In-Reply-To', String(message.inReplyTo))
  out += header('Subject', String(message?.subject ?? ''))
  out += header('MIME-Version', '1.0')
  out += header('Content-Type', 'text/plain; charset="UTF-8"')
  out += '\r\n'
  out += String(message?.body ?? '').replace(/\r?\n/g, '\r\n')
  return base64url(new TextEncoder().encode(out))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function base64url(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    const left = bytes.length - i
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (left > 1) out += B64[(n >> 6) & 63]
    if (left > 2) out += B64[n & 63]
  }
  return out // base64url with no padding: what the Gmail API accepts
}

/**
 * Send one checked message. Deliberately thin: no retries, no threading logic,
 * no attachment upload — it posts what guardSend released.
 *
 * ATTACHMENTS ARE NOT SENT. buildRawMessage writes a single text/plain part;
 * Send Guard checks attachment names but this wrapper cannot carry the bytes,
 * because nothing in this Worker ever receives them. See the README.
 *
 * UNVERIFIED: this has never run against a real Google account. It is written
 * from the users.messages.send reference, not from a successful call, and
 * nobody should treat it as tested until P6.1's test mailbox has sent one.
 */
export async function sendViaGmail({ accessToken, grantedScopes, message, fetchImpl = fetch }) {
  if (grantedScopes !== undefined) assertSendOnlyScope(grantedScopes)
  const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: buildRawMessage(message) }),
  })
  if (!res.ok) throw new Error(`gmail send: ${res.status} ${await res.text()}`)
  return res.json()
}
