'use strict'
// Runtime-free gateway logic (spec §37): the §34.3 request contract, the neuron
// estimate, the §37.3 route order, the §37.2 caps and the §34.9 R6 answer shape.
// No Workers runtime and no storage here, so node:test can cover the parts that
// decide whether a tester's call reaches a model at all, without a deploy.
//
// Everything in this file is a pure function. src/index.js wires it to Workers AI,
// the Durable Object and fetch.

// --- §37.2 budget -------------------------------------------------------------
// Workers AI gives 10,000 neurons a day on the free plan, reset at 00:00 UTC.
// Stop at 9,000 so a miscounted call can't tip a tester into a hard stop, and
// give each of the 7 testers 1,200 so one of them can't eat the whole day.
const TOTAL_CAP = 9000
const TESTER_CAP = 1200
const NEURONS_PER_MTOK = 8182 // clef-flash, per 1M input tokens (§37.2)
const MAX_TESTERS = 7 // §37.5: seven invite codes, which is what the budget is sized for

// --- §34.8 deadlines and §37.3 order ------------------------------------------
// tight: the agent is blocked while we answer, so Workers AI first and Kaggle only
// if its measured median fits. loose: nobody is waiting, so Kaggle first, which
// saves free neurons for the calls that are on the hook path.
const KINDS = {
  guard: { deadline: 300, tight: true },
  voice: { deadline: 400, tight: true },
  triage: { deadline: 1500, tight: false },
  receipt: { deadline: 3000, tight: false },
  // §37.3 lists showme as loose; §34.8 gives it no deadline, so it borrows receipt's.
  showme: { deadline: 3000, tight: false },
}
const DEFAULT_KIND = 'guard' // the hook path: the tightest deadline, never the loosest

const CACHE_SECONDS = 300 // §34.8: same brief hash + action signature for 5 minutes
const BACKEND_STALE_MS = 180_000 // §37.4: three missed 60 s heartbeats and Kaggle is down
const MAX_QUESTIONS = 64 // §29.5
const MAX_BODY_BYTES = 32 * 1024 // §34.3 keeps state under 800 tokens; this is a wide guard
const DEFAULT_SCALE = [1, 2, 3, 4, 5] // §34.3's risk question
const QUESTION_TYPES = new Set(['noul', 'choice', 'score'])

// Throws {status, message} on a bad request; returns the normalized body. The
// §34.3 shape wins over §29.5 where they differ (§32 precedence): a choice
// question names its `options`, a score question its `scale`. The §29.5 name
// `choices` is still accepted, because the §29 decision service speaks it.
function validateDecideRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw { status: 400, message: 'body must be an object' }
  }
  if (!body.state || typeof body.state !== 'object') throw { status: 400, message: 'state is required' }
  const questions = body.questions
  if (!Array.isArray(questions) || questions.length === 0) {
    throw { status: 400, message: 'questions must be a non-empty array' }
  }
  if (questions.length > MAX_QUESTIONS) throw { status: 400, message: `at most ${MAX_QUESTIONS} questions` }

  const ids = new Set()
  const out = []
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !q.id) throw { status: 400, message: 'each question needs an id' }
    if (ids.has(q.id)) throw { status: 400, message: `duplicate question id ${q.id}` }
    ids.add(q.id)
    if (!QUESTION_TYPES.has(q.type)) {
      throw { status: 400, message: `question ${q.id}: type must be noul, choice or score` }
    }
    if (typeof q.text !== 'string' || !q.text) throw { status: 400, message: `question ${q.id}: text is required` }

    if (q.type === 'choice') {
      const options = q.options ?? q.choices
      if (!Array.isArray(options) || options.length < 2) {
        throw { status: 400, message: `question ${q.id}: choice needs at least two options` }
      }
      if (options.some((o) => typeof o !== 'string' || !o)) {
        throw { status: 400, message: `question ${q.id}: options must be non-empty strings` }
      }
      if (new Set(options).size !== options.length) {
        throw { status: 400, message: `question ${q.id}: options must be unique` }
      }
      out.push({ id: q.id, type: 'choice', text: q.text, options })
      continue
    }
    if (q.type === 'score') {
      const scale = q.scale ?? DEFAULT_SCALE
      if (!Array.isArray(scale) || scale.length < 2 || scale.some((n) => !Number.isFinite(n))) {
        throw { status: 400, message: `question ${q.id}: scale must be two or more numbers` }
      }
      out.push({ id: q.id, type: 'score', text: q.text, scale })
      continue
    }
    out.push({ id: q.id, type: 'noul', text: q.text })
  }
  return { state: body.state, questions: out }
}

// §37.6 K4: estimated neurons = ceil(bodyLength / 4) tokens / 1e6 x 8182, rounded
// up. Never 0, so a reservation always moves the meter.
function estimateNeurons(bodyLength) {
  const tokens = Math.ceil(Math.max(0, bodyLength) / 4)
  return Math.max(1, Math.ceil((tokens / 1e6) * NEURONS_PER_MTOK))
}

// The budget day is the UTC date, because that is when Workers AI resets (§37.2).
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function kindOf(name) {
  return KINDS[name] ? name : DEFAULT_KIND
}

function backendAlive(backend, now) {
  if (!backend || !backend.url || !Number.isFinite(backend.last_beat)) return false
  return now - backend.last_beat < BACKEND_STALE_MS
}

// The whole routing decision, as one pure function: cache, then the §37.3 order
// for this kind, then the device's own rules. `reserve` is the neuron count the
// caller must hold before calling Workers AI.
//
//   cache     -> answers are already known
//   workers_ai-> call the Workers AI binding
//   kaggle    -> call the registered tunnel URL
//   fallback  -> answer {fallback:true}; the device's rules decide (§34.8)
function plan({ kind, now, cache, usage, backend, estNeurons, deadlineMs }) {
  const name = kindOf(kind)
  const spec = KINDS[name]
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.min(deadlineMs, spec.deadline) : spec.deadline
  const base = { kind: name, deadlineMs: deadline, reserve: 0 }

  if (cache && Number.isFinite(cache.expires) && cache.expires > now) {
    return { ...base, route: 'cache', answers: cache.answers }
  }

  const totalLeft = TOTAL_CAP - (usage?.total ?? 0)
  const testerLeft = TESTER_CAP - (usage?.tester ?? 0)
  const overTotal = estNeurons > totalLeft
  const overTester = estNeurons > testerLeft
  const alive = backendAlive(backend, now)
  // §37.3: on a tight deadline Kaggle is used only if its last measured median fits.
  const fits = alive && (!spec.tight || (Number.isFinite(backend.p50_ms) && backend.p50_ms <= deadline))

  for (const route of spec.tight ? ['workers_ai', 'kaggle'] : ['kaggle', 'workers_ai']) {
    if (route === 'workers_ai' && !overTotal && !overTester) {
      return { ...base, route, reserve: estNeurons }
    }
    if (route === 'kaggle' && fits) return { ...base, route, url: backend.url }
  }

  const why = []
  if (overTotal) why.push('total_cap')
  else if (overTester) why.push('tester_cap')
  if (!alive) why.push('kaggle_down')
  else if (!fits) why.push('kaggle_too_slow')
  return { ...base, route: 'fallback', reason: why.join('+') || 'no_backend' }
}

// A model answer per question, in the §34.9 R6 shape the Rust router parses:
//   noul   -> { p_yes }
//   score  -> { value }          on the question's own scale, not 0..1
//   choice -> { choice, probabilities, confidence }
// Returns { ok: false, reason } when anything is missing or outside its range.
// R6: an unknown shape is a fallback, not a guess, so a model that answers in a
// shape we don't understand can never approve an action by accident.
function parseClefAnswers(questions, raw) {
  const byId = indexAnswers(raw)
  const answers = {}
  for (const q of questions) {
    const got = byId.get(q.id)
    if (got == null || got === '') return { ok: false, reason: `no answer for ${q.id}` }
    try {
      if (q.type === 'noul') answers[q.id] = { p_yes: probability(got.p_yes ?? got.prob ?? got) }
      else if (q.type === 'score') answers[q.id] = { value: onScale(q.scale, got.value ?? got.score ?? got) }
      else answers[q.id] = choiceAnswer(q.options, got)
    } catch (e) {
      return { ok: false, reason: `${q.id}: ${e.message}` }
    }
  }
  return { ok: true, answers }
}

// Accepts a map keyed by question id or a list of {id, ...}, with or without an
// `answers` wrapper, because the clef-flash response shape is still unverified
// (§32.5 rule 3). Anything else indexes to nothing and becomes a fallback.
function indexAnswers(raw) {
  const found = new Map()
  const body = raw && typeof raw === 'object' && 'answers' in raw ? raw.answers : raw
  if (Array.isArray(body)) {
    for (const a of body) if (a && typeof a.id === 'string') found.set(a.id, a)
  } else if (body && typeof body === 'object') {
    for (const [id, a] of Object.entries(body)) found.set(id, a)
  }
  return found
}

function choiceAnswer(options, got) {
  const probs = got && typeof got === 'object' ? (got.probabilities ?? got.probs) : null
  if (!probs || typeof probs !== 'object') {
    // §34.4 branches on the choice's confidence, so a bare choice with no
    // distribution is not enough to act on.
    throw new Error('choice needs probabilities')
  }
  let sum = 0
  const out = {}
  for (const o of options) {
    const v = Math.max(0, number(probs[o] ?? 0)) // floor only: clamping at 1 would erase the ratios
    out[o] = v
    sum += v
  }
  if (sum <= 0) throw new Error('every choice probability is zero')
  let choice = options[0]
  for (const o of options) {
    out[o] = out[o] / sum // §34.9 pitfall: the model's probabilities may not sum to 1
    if (out[o] > out[choice]) choice = o
  }
  return { choice, probabilities: out, confidence: out[choice] }
}

// A probability, with 1% slack for a model that prints 1.000001. Further out than
// that is a shape we don't understand, not a number to clamp.
function probability(v) {
  const n = number(v)
  if (n < -0.01 || n > 1.01) throw new Error('probability outside 0..1')
  return n < 0 ? 0 : n > 1 ? 1 : n
}

// A score on the question's own scale (§34.3 uses 1..5 for risk). Kept continuous,
// because §34.5 only ever compares it ("risk <= 2"). A value outside the scale
// means the model used a different scale, so the answer is unusable: a 0..1 reply
// to a 1..5 question must not become "risk 1".
function onScale(scale, v) {
  const n = number(v)
  const low = Math.min(...scale)
  const high = Math.max(...scale)
  if (n < low || n > high) throw new Error(`score outside ${low}..${high}`)
  return n
}

function number(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) throw new Error('not a number')
  return n
}

// Stable text for a cache key: the same value gives the same string whatever
// order its object keys came in.
function sortedJson(value) {
  if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + sortedJson(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

// §37.6 K3: a token is two randomUUIDs joined. 64 hex characters, so it can be
// pasted into Credential Manager and a bearer header without escaping.
function newToken(uuid = () => crypto.randomUUID()) {
  return `${uuid()}${uuid()}`.replace(/-/g, '')
}

// An invite code a tester types by hand once (§37.5), so no I, O, 0 or 1.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
function newInviteCode(bytes = crypto.getRandomValues(new Uint8Array(8))) {
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

// §37.6 K5: the notebook registers its quick-tunnel URL and then heartbeats.
function validateBackendReport(body) {
  if (!body || typeof body !== 'object') throw { status: 400, message: 'body must be an object' }
  let url
  try {
    url = new URL(String(body.url))
  } catch {
    throw { status: 400, message: 'url must be absolute' }
  }
  // The tunnel is the only way in to the notebook, and the gateway secret travels
  // on it, so plain http is refused outright.
  if (url.protocol !== 'https:') throw { status: 400, message: 'url must be https' }
  const p50 = Number(body.p50_ms)
  if (!Number.isFinite(p50) || p50 < 0) throw { status: 400, message: 'p50_ms must be a number of milliseconds' }
  return { url: url.origin + url.pathname.replace(/\/$/, ''), p50_ms: Math.round(p50) }
}

function median(values) {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export {
  TOTAL_CAP, TESTER_CAP, NEURONS_PER_MTOK, MAX_TESTERS, KINDS, DEFAULT_KIND,
  CACHE_SECONDS, BACKEND_STALE_MS, MAX_QUESTIONS, MAX_BODY_BYTES, DEFAULT_SCALE,
  validateDecideRequest, estimateNeurons, utcDay, kindOf, backendAlive, plan,
  parseClefAnswers, sortedJson, newToken, newInviteCode, validateBackendReport, median,
}
