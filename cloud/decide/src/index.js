// Cloudflare Worker: mewndo-decide. Wires the Workers runtime (Workers AI,
// a Durable Object neuron meter, the Cache API) around the runtime-free logic
// in ./decide.js. Deploy and secret steps are in ../README.md.
import {
  DEFAULT_MODEL, DEFAULT_NEURONS_PER_CALL, NEURON_CAP, CACHE_SECONDS,
  validateRequest, cacheKey, ruleAnswers, parseModelAnswers, chargeNeurons,
} from './decide.js'

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405)

    // Secret token (spec §4.1). Set with: wrangler secret put MEWNDO_DECIDE_TOKEN
    const expected = env.MEWNDO_DECIDE_TOKEN
    if (!expected) return json({ error: 'service not configured' }, 500)
    const auth = request.headers.get('authorization') || ''
    if (auth !== `Bearer ${expected}`) return json({ error: 'unauthorized' }, 401)

    let req
    try {
      req = validateRequest(await request.json())
    } catch (e) {
      return json({ error: e.message || 'bad request' }, e.status || 400)
    }

    const model = env.DECIDE_MODEL || DEFAULT_MODEL
    const key = cacheKey(req)
    const hash = await sha256Hex(key)
    const cacheReq = new Request(`https://decide.cache/${hash}`)

    // Cache identical requests for a few minutes.
    const cache = caches.default
    const hit = await cache.match(cacheReq)
    if (hit) {
      const body = await hit.json()
      return json({ ...body, cached: true })
    }

    // Daily neuron budget, held in one Durable Object so the count is shared
    // across isolates and strongly consistent.
    const perCall = Number(env.DECIDE_NEURONS_PER_CALL) || DEFAULT_NEURONS_PER_CALL
    const meter = env.NEURON_METER.get(env.NEURON_METER.idFromName('global'))
    const charge = await meter.fetch('https://meter/charge', {
      method: 'POST',
      body: JSON.stringify({ perCall, cap: NEURON_CAP }),
    }).then((r) => r.json())

    const started = Date.now()
    let answers, source, reason
    if (!charge.allowed) {
      answers = ruleAnswers(req.questions)
      source = 'rules'
      reason = 'neuron_cap'
    } else {
      try {
        const raw = await scoreWithModel(env, model, req.state, req.questions)
        answers = parseModelAnswers(req.questions, raw)
        source = 'model'
      } catch (e) {
        answers = ruleAnswers(req.questions)
        source = 'rules'
        reason = 'model_error'
      }
    }
    const latency_ms = Date.now() - started

    const body = {
      answers, source, model,
      latency_ms,
      neurons_used: charge.used,
      cached: false,
      ...(reason ? { reason } : {}),
    }
    // Log latency for every call (visible with `wrangler tail`).
    console.log(JSON.stringify({ at: 'decide', latency_ms, source, reason, questions: req.questions.length, neurons_used: charge.used }))

    const res = json(body)
    // Only cache a real decision; a rules fallback should retry the model next time.
    if (source === 'model') {
      const toCache = new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` } })
      ctx.waitUntil(cache.put(cacheReq, toCache))
    }
    return res
  },
}

// The single swap point for the model (spec §4.1: one interface so we can later
// switch to Clef, Jev or a self-hosted Clef-flash). clef-flash scores answers
// in a prefill-only pass; until its exact binding schema is validated on a real
// account, we ask any Workers AI text model for strict JSON and parse it, with
// per-question rule fallback in parseModelAnswers if the shape is off.
async function scoreWithModel(env, model, state, questions) {
  const sys = 'You score an agent action against questions for a safety guard. '
    + 'Reply with ONLY a JSON object {"answers":[...]}. For a noul question return '
    + '{"id","prob"} where prob is P(answer is yes) in 0..1. For score return {"id","score"} in 0..1. '
    + 'For choice return {"id","probs":{choice:prob,...}} summing to 1. No prose.'
  const user = JSON.stringify({ state, questions })
  const out = await env.AI.run(model, {
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    // Low randomness: a guard decision should be stable for identical input.
    temperature: 0,
  })
  const text = typeof out === 'string' ? out : out.response ?? out.result ?? ''
  return JSON.parse(extractJson(text))
}

// Models sometimes wrap JSON in prose or fences; take the outermost object.
function extractJson(text) {
  const s = String(text)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a === -1 || b === -1 || b < a) throw new Error('no json in model output')
  return s.slice(a, b + 1)
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Durable Object: one global daily neuron counter.
export class NeuronMeter {
  constructor(state) { this.state = state }
  async fetch(request) {
    const { perCall, cap } = await request.json()
    const current = (await this.state.storage.get('meter')) || null
    const result = chargeNeurons(current, Date.now(), perCall, cap)
    if (result.allowed) await this.state.storage.put('meter', result.meter)
    return new Response(JSON.stringify({ allowed: result.allowed, used: result.used }), {
      headers: { 'content-type': 'application/json' },
    })
  }
}
