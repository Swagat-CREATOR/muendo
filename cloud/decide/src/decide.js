'use strict'
// Pure decision-service logic, no Workers runtime. Imported by the Worker
// (src/index.js) and by node:test. Keeping it runtime-free is what lets CI
// test the parts that matter (validation, neuron cap, cache key, fallback)
// without a live Workers AI binding or a deploy.

// Free Workers AI budget is 10,000 neurons/day; stop at 9,000 to leave slack
// for eventual-consistency drift and the odd uncounted call (spec §4.1/§29.6).
const NEURON_CAP = 9000
// ponytail: Workers AI bills in "neurons" but the binding doesn't return the
// per-call count, so we charge a flat estimate. Re-measure against the real
// clef-flash on your account and set DECIDE_NEURONS_PER_CALL in wrangler.toml.
const DEFAULT_NEURONS_PER_CALL = 60
const DEFAULT_MODEL = '@cf/cloudflare/clef-flash'
const CACHE_SECONDS = 180 // "identical requests for a few minutes"
const MAX_QUESTIONS = 64
const QUESTION_TYPES = new Set(['noul', 'choice', 'score'])

// Throws {status, message} on a bad request; returns the normalized body.
function validateRequest(body) {
  if (!body || typeof body !== 'object') throw { status: 400, message: 'body must be an object' }
  if (!body.state || typeof body.state !== 'object') throw { status: 400, message: 'state is required' }
  const questions = body.questions
  if (!Array.isArray(questions) || questions.length === 0) throw { status: 400, message: 'questions must be a non-empty array' }
  if (questions.length > MAX_QUESTIONS) throw { status: 400, message: `at most ${MAX_QUESTIONS} questions` }
  const ids = new Set()
  for (const q of questions) {
    if (!q || typeof q.id !== 'string' || !q.id) throw { status: 400, message: 'each question needs an id' }
    if (ids.has(q.id)) throw { status: 400, message: `duplicate question id ${q.id}` }
    ids.add(q.id)
    if (!QUESTION_TYPES.has(q.type)) throw { status: 400, message: `question ${q.id}: type must be noul, choice or score` }
    if (typeof q.text !== 'string' || !q.text) throw { status: 400, message: `question ${q.id}: text is required` }
    if (q.type === 'choice' && (!Array.isArray(q.choices) || q.choices.length < 2)) {
      throw { status: 400, message: `question ${q.id}: choice needs a choices array` }
    }
  }
  return { state: body.state, questions }
}

// Stable cache key: same (state, questions) -> same key, regardless of key order.
function cacheKey(req) {
  return sortedJson({ state: req.state, questions: req.questions })
}

function sortedJson(value) {
  if (Array.isArray(value)) return '[' + value.map(sortedJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + sortedJson(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

// The "use rules" answer: neutral, model-free probabilities, marked source
// "rules" so mewndo-core knows there is no model opinion and must decide by
// its own rules (spec §29.4 fallback). Deliberately uncommitted: a noul of 0.5
// is below the 0.97 release bar, so a missing model never auto-approves a send.
function ruleAnswers(questions) {
  return questions.map((q) => {
    if (q.type === 'choice') {
      const p = 1 / q.choices.length
      const probs = {}
      for (const c of q.choices) probs[c] = p
      return { id: q.id, type: 'choice', probs }
    }
    if (q.type === 'score') return { id: q.id, type: 'score', score: 0.5 }
    return { id: q.id, type: 'noul', prob: 0.5 }
  })
}

// Parse the model's raw JSON into normalized, clamped answers. One question ->
// one answer; anything missing or malformed falls back to that question's rule
// answer, so a flaky model degrades to "rules" per question, never to garbage.
function parseModelAnswers(questions, raw) {
  const byId = indexRaw(raw)
  const fallback = ruleAnswers(questions)
  return questions.map((q, i) => {
    const got = byId.get(q.id)
    if (got == null) return fallback[i]
    try {
      if (q.type === 'noul') return { id: q.id, type: 'noul', prob: clamp01(num(got.prob ?? got)) }
      if (q.type === 'score') return { id: q.id, type: 'score', score: clamp01(num(got.score ?? got)) }
      const probs = normalizeChoice(q.choices, got.probs ?? got)
      return { id: q.id, type: 'choice', probs }
    } catch {
      return fallback[i]
    }
  })
}

function indexRaw(raw) {
  const m = new Map()
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.answers) ? raw.answers : []
  for (const a of list) if (a && typeof a.id === 'string') m.set(a.id, a)
  return m
}

function normalizeChoice(choices, probs) {
  if (!probs || typeof probs !== 'object') throw new Error('no probs')
  let sum = 0
  const out = {}
  for (const c of choices) { const v = Math.max(0, num(probs[c] ?? 0)); out[c] = v; sum += v } // floor only: clamping to 1 would erase ratios
  if (sum <= 0) throw new Error('empty')
  for (const c of choices) out[c] = out[c] / sum // renormalize to sum 1
  return out
}

function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); if (!Number.isFinite(n)) throw new Error('nan'); return n }
function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n }

// Advance a daily neuron tally held in `meter` ({ day, used }). Returns whether
// a model call is allowed and the meter to persist. UTC day boundary.
function chargeNeurons(meter, now, perCall, cap) {
  const day = new Date(now).toISOString().slice(0, 10)
  const used = meter && meter.day === day ? meter.used : 0
  if (used + perCall > cap) return { allowed: false, meter: { day, used }, used }
  const next = used + perCall
  return { allowed: true, meter: { day, used: next }, used: next }
}

export {
  NEURON_CAP, DEFAULT_NEURONS_PER_CALL, DEFAULT_MODEL, CACHE_SECONDS, MAX_QUESTIONS,
  validateRequest, cacheKey, sortedJson, ruleAnswers, parseModelAnswers, chargeNeurons,
}
