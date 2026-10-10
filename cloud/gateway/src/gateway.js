'use strict'
// Runtime-free gateway logic (spec §37): the §34.3 request contract, the neuron
// estimate, the route (answer cache, then Workers AI, then the device's rules),
// the daily budget with its priorities, and the §34.9 R6 answer shape.
// No Workers runtime and no storage here, so node:test can cover the parts that
// decide whether a tester's call reaches a model at all, without a deploy.
//
// Everything in this file is a pure function. src/index.js wires it to Workers AI,
// the Durable Object and fetch.

// --- the daily budget (§37.2) -----------------------------------------------------
// Workers AI gives 10,000 neurons a day on the free plan, reset at 00:00 UTC. Every
// number the budget runs on is in this one table; StateDO keeps overrides set
// through POST /admin/settings, so a demo can be retuned without a deploy.
//   total_cap           stop here, short of the hard stop, so a miscounted call can't tip into it
//   device_cap          per device (one redeemed token) per day
//   code_cap            per judge code (an invite code, across all its devices) per day
//   devices_per_code    how many devices one judge code may be redeemed on
//   max_codes           how many judge codes may be live at once (what the budget is sized for)
//   low_budget_share    under this share of total_cap left, triage, receipt and showme calls
//                       use rules only, voice falls back to keyword matching, and transcribe to
//                       the PC's own offline recognizer
//   guard_until_used    Guard keeps the model until this share of total_cap is used
const DEFAULT_SETTINGS = Object.freeze({
  total_cap: 9000,
  device_cap: 1200,
  code_cap: 2400,
  devices_per_code: 3,
  max_codes: 7,
  low_budget_share: 0.2,
  guard_until_used: 0.95,
})
const NEURONS_PER_MTOK = 8182 // clef-flash, per 1M input tokens (§37.2)
// @cf/openai/whisper, from Cloudflare's pricing page (workers-ai/platform/pricing.mdx, read 10 Oct 2026):
// $0.0005 and 41.14 neurons per audio minute.
const NEURONS_PER_AUDIO_MINUTE = 41.14
// Speech for voice commands and dictation is seconds long. 30 s also keeps the byte-to-array conversion the
// Workers AI binding needs well inside the free plan's CPU limit (unmeasured until deployed: docs/decisions.md).
const MAX_AUDIO_SECONDS = 30
const MAX_AUDIO_BYTES = 2 * 1024 * 1024

// Merges stored overrides over the defaults, refusing anything that would make the
// budget meaningless rather than clamping it into something nobody asked for.
function validateSettings(over = {}) {
  const out = { ...DEFAULT_SETTINGS }
  for (const [key, value] of Object.entries(over ?? {})) {
    if (!(key in DEFAULT_SETTINGS)) throw { status: 400, message: `unknown setting ${key}` }
    const n = Number(value)
    const share = key === 'low_budget_share' || key === 'guard_until_used'
    if (!Number.isFinite(n) || n < 0 || (share ? n > 1 : !Number.isInteger(n))) {
      throw { status: 400, message: `${key} must be ${share ? 'a share from 0 to 1' : 'a whole number'}` }
    }
    out[key] = n
  }
  if (out.devices_per_code < 1 || out.max_codes < 1) {
    throw { status: 400, message: 'devices_per_code and max_codes must be at least 1' }
  }
  return out
}

// --- §34.8 deadlines ------------------------------------------------------------------
// `low` is what the kind does when the day's budget runs low: `rules` (the device's
// rules decide), `keywords` (voice: keyword matching on the device), or `model` (Guard
// keeps the model until guard_until_used). The device reads the fallback reason.
const KINDS = {
  guard: { deadline: 300, low: 'model' },
  voice: { deadline: 400, low: 'keywords' },
  triage: { deadline: 1500, low: 'rules' },
  receipt: { deadline: 3000, low: 'rules' },
  // §34.8 gives showme no deadline, so it borrows receipt's; it is as deferrable as receipts.
  showme: { deadline: 3000, low: 'rules' },
  // Speech to text (POST /v1/transcribe). Below Guard: when the day runs low it gives way, and the PC's offline
  // recognizer takes over. Whisper on a few seconds of audio needs more time than a decision.
  transcribe: { deadline: 8000, low: 'offline' },
}
const LOW_REASON = { keywords: 'budget_low_keywords', rules: 'budget_low_rules', offline: 'budget_low_offline' }
const DEFAULT_KIND = 'guard' // the hook path: the tightest deadline, never the loosest

const CACHE_SECONDS = 300 // §34.8: same brief hash + action signature for 5 minutes
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

// The length of a WAV recording in seconds, from its own header (RIFF/WAVE, byte rate at offset 28). Throws a
// 400 for anything that is not a WAV, so a guess never reaches the model or the budget.
function wavSeconds(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const text = (at) => String.fromCharCode(...b.subarray(at, at + 4))
  if (b.length < 44 || text(0) !== 'RIFF' || text(8) !== 'WAVE') throw { status: 400, message: 'audio must be a WAV file' }
  const byteRate = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(28, true)
  if (!byteRate) throw { status: 400, message: 'the WAV header has no byte rate' }
  return (b.length - 44) / byteRate
}

// What a recording costs, at least 1 so a short clip still counts.
function estimateAudioNeurons(seconds) {
  return Math.max(1, Math.ceil((Math.max(0, seconds) / 60) * NEURONS_PER_AUDIO_MINUTE))
}

function kindOf(name) {
  return KINDS[name] ? name : DEFAULT_KIND
}

// The next 00:00 UTC, when Workers AI's free allowance resets (§37.2).
function resetAt(now) {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

// Where the day's budget stands. `rules_only` is the dock's "Rules only mode": even
// Guard can no longer reach the model today.
function budgetState(settings, used) {
  const cap = settings.total_cap
  const remaining = Math.max(0, cap - used)
  return {
    used,
    remaining,
    low: remaining < settings.low_budget_share * cap,
    rules_only: used >= settings.guard_until_used * cap,
  }
}

// The whole routing decision, as one pure function: the answer cache, then Workers AI,
// then the device's own rules. `reserve` is the neuron count the caller must hold
// before calling Workers AI.
//
//   cache      -> answers are already known
//   workers_ai -> call the Workers AI binding
//   fallback   -> answer {fallback:true, reason}; the device's rules decide (§34.8)
//
// Past the caps, or when the day runs low and this kind gives way to Guard, the
// reason says which; `rules_only` travels on every answer so the dock can say so.
function plan({ kind, now, cache, usage, estNeurons, deadlineMs, settings = DEFAULT_SETTINGS }) {
  const name = kindOf(kind)
  const spec = KINDS[name]
  const deadline = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.min(deadlineMs, spec.deadline) : spec.deadline
  const budget = budgetState(settings, usage?.total ?? 0)
  const base = { kind: name, deadlineMs: deadline, reserve: 0, rules_only: budget.rules_only }

  if (cache && Number.isFinite(cache.expires) && cache.expires > now) {
    return { ...base, route: 'cache', answers: cache.answers }
  }

  const fallback = (reason) => ({ ...base, route: 'fallback', reason })
  const after = (usage?.total ?? 0) + estNeurons
  // Guard keeps the model until guard_until_used; past that, no kind does.
  if (after > settings.guard_until_used * settings.total_cap) return fallback('total_cap')
  if (budget.low && spec.low !== 'model') return fallback(LOW_REASON[spec.low])
  if (estNeurons > settings.code_cap - (usage?.code ?? 0)) return fallback('code_cap')
  if (estNeurons > settings.device_cap - (usage?.device ?? 0)) return fallback('device_cap')
  return { ...base, route: 'workers_ai', reserve: estNeurons }
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

function median(values) {
  if (!values || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export {
  DEFAULT_SETTINGS, NEURONS_PER_MTOK, NEURONS_PER_AUDIO_MINUTE, MAX_AUDIO_SECONDS, MAX_AUDIO_BYTES,
  wavSeconds, estimateAudioNeurons, KINDS, DEFAULT_KIND,
  CACHE_SECONDS, MAX_QUESTIONS, MAX_BODY_BYTES, DEFAULT_SCALE,
  validateDecideRequest, validateSettings, estimateNeurons, utcDay, resetAt, budgetState, kindOf, plan,
  parseClefAnswers, sortedJson, newToken, newInviteCode, median,
}
