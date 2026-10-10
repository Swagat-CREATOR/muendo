'use strict'
// Cloudflare Worker: mewndo-cloud, the gateway module (spec §37.1, §37.6 K1-K5).
// Testers' PCs hold no Cloudflare key: they send a device token, and the Worker
// calls Workers AI through its own binding. Every call goes: answer cache, then
// Workers AI, then {fallback:true} for the device's rules.
//
// Routes
//   GET  /health            liveness, and what §34.9 R6 pre-connects to
//   POST /v1/decide         one System One decision (§34.3 in, §34.9 R6 out)
//   POST /invite/redeem     a judge code for a device token (§37.5)
//   POST /admin/invites     mint judge codes    (x-admin-secret)
//   POST /admin/revoke      revoke a device     (x-admin-secret)
//   GET  /admin/status      today's budget, reset time, usage per code and device (x-admin-secret)
//   POST /admin/settings    change the budget settings table (x-admin-secret)
//   POST /mcp               hosted MCP for cloud agents (§37.6 K6)
//   GET  /hub               the desktop's WebSocket link (§37.6 K7)
//
// All decision logic is in ./gateway.js and all storage in ./state.js, both
// runtime-free, so node:test covers them without a deploy. Deploy steps and the
// honest limits are in ../README.md.
import { State } from './state.js'
import { Hub } from './hub.js'
import { handle as mcpHandle } from './mcp.js'
import {
  MAX_BODY_BYTES, estimateNeurons, kindOf, parseClefAnswers, sortedJson, validateDecideRequest,
} from './gateway.js'

const DEFAULT_MODEL = '@cf/cloudflare/clef-flash'

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx)
    } catch (e) {
      if (e && e.status) return json({ error: e.message }, e.status)
      console.log(JSON.stringify({ at: 'error', message: String(e && e.message) }))
      return json({ error: 'gateway error' }, 500)
    }
  },
}

async function route(request, env, ctx) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  switch (`${request.method} ${path}`) {
    case 'GET /health': return json({ ok: true, service: 'mewndo-cloud' })
    case 'POST /v1/decide': return decide(request, env, ctx)
    case 'POST /invite/redeem': return redeem(request, env)
    case 'POST /admin/invites': return adminInvites(request, env)
    case 'POST /admin/revoke': return adminRevoke(request, env)
    case 'GET /admin/status': return adminStatus(request, env)
    case 'POST /admin/settings': return adminSettings(request, env)
    case 'POST /mcp': return mcp(request, env)
    case 'GET /hub': return hub(request, env)
    default: return json({ error: 'not found' }, 404)
  }
}

// --- K6: the hosted MCP -------------------------------------------------------
// Some agent apps cannot set headers, so ?token= is accepted too (§37.6 K6).
async function mcp(request, env) {
  const url = new URL(request.url)
  const token = bearer(request) || url.searchParams.get('token') || ''
  const who = await state(env, 'auth', token)
  if (!who) return json({ error: 'unauthorized' }, 401)
  const rpc = await readJson(request)
  // The MCP client's own name is the best clue to which cloud agent this is
  // (§37.6 K8 maps it to dots, grok-bot, muse or claude-ai).
  const agent = rpc?.params?.clientInfo?.name || request.headers.get('x-mewndo-agent') || 'cloud agent'
  const answer = await hubCall(env, who.tester, 'rpc', { rpc, agent })
  return answer === null ? new Response(null, { status: 202 }) : json(answer)
}

// --- K7: the desktop link -----------------------------------------------------
async function hub(request, env) {
  const url = new URL(request.url)
  const token = bearer(request) || url.searchParams.get('token') || ''
  const who = await state(env, 'auth', token)
  if (!who) return json({ error: 'unauthorized' }, 401)
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'expected a WebSocket upgrade' }, 426)
  }
  if (!env.HUB) throw { status: 500, message: 'HUB binding is missing' }
  return env.HUB.get(env.HUB.idFromName(who.tester)).fetch(request)
}

// One hub per tester, so a card can never reach another tester's desktop.
async function hubCall(env, tester, method, args) {
  if (!env.HUB) throw { status: 500, message: 'HUB binding is missing' }
  const res = await env.HUB.get(env.HUB.idFromName(tester)).fetch('https://mewndo-hub/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  if (res.status === 204) return null
  const body = await res.json()
  if (!res.ok) throw { status: res.status, message: body.error || 'hub error' }
  return body.result
}

// --- K4: one decision ---------------------------------------------------------
async function decide(request, env, ctx) {
  const token = bearer(request)
  if (!token) return json({ error: 'unauthorized' }, 401)

  const text = await request.text()
  const bodyLength = new TextEncoder().encode(text).length
  if (bodyLength > MAX_BODY_BYTES) {
    // §34.3 keeps state under 800 tokens; anything this big would also risk the
    // free plan's 10 ms CPU limit (§37.6 pitfalls).
    return json({ error: `body over ${MAX_BODY_BYTES} bytes` }, 413)
  }
  let req
  try {
    req = validateDecideRequest(JSON.parse(text))
  } catch (e) {
    return json({ error: e.message || 'bad request' }, e.status || 400)
  }

  const kind = kindOf(request.headers.get('x-mewndo-kind'))
  const deadlineHeader = Number(request.headers.get('x-mewndo-deadline-ms'))
  // The device sends the action signature it already computed (§34.9 R4); without
  // one the gateway hashes the request so identical calls still share a verdict.
  const sig = request.headers.get('x-mewndo-sig') || (await sha256Hex(sortedJson(req)))
  const estNeurons = estimateNeurons(bodyLength)
  // A verdict depends on the brief (in_scope), so a cached one is reused only by the
  // same tester under the same brief, never across testers (§34.8: brief hash + signature).
  const scope = await sha256Hex(sortedJson([token, req.state.brief ?? null]))

  // Auth, cache and budget in one Durable Object round trip (§37.6 speed rules).
  const decision = await state(env, 'authPrepare', {
    token,
    sig,
    scope,
    kind,
    estNeurons,
    deadlineMs: Number.isFinite(deadlineHeader) ? deadlineHeader : undefined,
  })
  const who = { tester: decision.tester, device: decision.device }
  // On every answer: the dock shows "Rules only mode" while this is true (§37.2).
  const rulesOnly = decision.rules_only === true

  if (decision.route === 'cache') {
    log({ at: 'decide', kind, backend: 'cache', ms: 0, tester: who.tester })
    return json({ answers: decision.answers, backend: 'cache', ms: 0, cached: true, rules_only: rulesOnly })
  }
  if (decision.route === 'fallback') {
    log({ at: 'decide', kind, backend: 'fallback', reason: decision.reason, ms: 0, tester: who.tester })
    return json({ fallback: true, reason: decision.reason, rules_only: rulesOnly })
  }

  const started = Date.now()
  let raw
  try {
    raw = await askWorkersAi(env, req, decision.deadlineMs)
  } catch (e) {
    const ms = Date.now() - started
    // A call that never reached the model gives its reservation back (§37.6 K4.3).
    // One that did (a missed deadline keeps running; unreadable output was still
    // generated) keeps it, or the meter would undercount toward the hard stop.
    ctx.waitUntil(state(env, 'settle', {
      ...who, reserved: decision.reserve, actualNeurons: e?.spent ? null : 0, backend: decision.route, ms,
    }).catch(() => {}))
    log({ at: 'decide', kind, backend: decision.route, ms, error: String(e && e.message) })
    return json({ fallback: true, reason: `${decision.route}_error`, ms, rules_only: rulesOnly })
  }
  const ms = Date.now() - started

  const parsed = parseClefAnswers(req.questions, raw)
  if (!parsed.ok) {
    // §34.9 R6: an answer shape we don't understand is a fallback, and one raw
    // sample is kept so the parser can be fixed against something real.
    ctx.waitUntil(Promise.all([
      state(env, 'saveSample', { backend: decision.route, raw: JSON.stringify(raw), reason: parsed.reason }),
      // The model ran, so its neurons stay counted.
      state(env, 'settle', { ...who, reserved: decision.reserve, backend: decision.route, ms }),
    ]).catch(() => {}))
    log({ at: 'decide', kind, backend: decision.route, ms, unknown_shape: parsed.reason })
    return json({ fallback: true, reason: 'unknown_answer_shape', ms, rules_only: rulesOnly })
  }

  // Caching and the neuron correction never hold up the answer (§37.6 K4.5).
  ctx.waitUntil(state(env, 'settle', {
    ...who,
    sig,
    scope,
    answers: parsed.answers,
    backend: decision.route,
    ms,
    reserved: decision.reserve,
    actualNeurons: usedNeurons(raw),
  }).catch(() => {}))
  log({ at: 'decide', kind, backend: decision.route, ms, tester: who.tester })
  return json({ answers: parsed.answers, backend: decision.route, ms, rules_only: rulesOnly })
}

// The one place the Workers AI call shape lives. §32.5 rule 3 lists the exact
// input and output of @cf/cloudflare/clef-flash as unverified, so this asks for
// the §34.9 R6 field names as strict JSON and lets parseClefAnswers refuse
// anything else. When the real binding schema is confirmed, only this changes.
async function askWorkersAi(env, req, deadlineMs) {
  if (!env.AI) throw new Error('no AI binding')
  const model = env.DECIDE_MODEL || DEFAULT_MODEL
  const sys = 'You answer questions about an AI agent action for a safety guard. '
    + 'Reply with ONLY a JSON object: {"answers":{"<question id>":<answer>}}. '
    + 'noul -> {"p_yes":<0..1>}. score -> {"value":<a number on that question\'s scale>}. '
    + 'choice -> {"probabilities":{"<option>":<0..1>, ...}} over exactly that question\'s options. '
    + 'Answer every question id. No prose.'
  const call = env.AI.run(model, {
    messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(req) }],
    temperature: 0, // a guard decision must be stable for identical input
  })
  const out = await withDeadline(call, deadlineMs, 'workers_ai')
  try {
    const text = typeof out === 'string' ? out : out?.response ?? out?.result ?? out
    return typeof text === 'string' ? JSON.parse(extractJson(text)) : text
  } catch (e) {
    throw spent(e)
  }
}

// Marks an error that came after the model had already run.
function spent(e) {
  const err = e instanceof Error ? e : new Error(String(e))
  err.spent = true
  return err
}

// A model answer that reports its own neuron use lets the reservation be corrected;
// none is known to, so this is almost always null and the estimate stands.
function usedNeurons(raw) {
  const n = Number(raw?.usage?.neurons ?? raw?.neurons)
  return Number.isFinite(n) ? Math.ceil(n) : null
}

// Stops waiting at the deadline (§34.8). It cannot cancel env.AI.run, because
// whether that call takes an AbortSignal is one of §32.5 rule 3's unverified
// items; the Worker just stops waiting and the device's rules decide.
function withDeadline(promise, ms, what) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(spent(new Error(`${what} past ${ms} ms`))), ms) }),
  ])
}

// --- K3: invites and admin ----------------------------------------------------
async function redeem(request, env) {
  const body = await readJson(request)
  const out = await state(env, 'redeem', { code: body.code, name: body.name ?? null })
  return json(out)
}

async function adminInvites(request, env) {
  requireAdmin(request, env)
  const body = await readJson(request).catch(() => ({}))
  return json(await state(env, 'createInvites', { count: body.count }))
}

async function adminRevoke(request, env) {
  requireAdmin(request, env)
  const body = await readJson(request)
  return json(await state(env, 'revoke', { token: body.token }))
}

async function adminStatus(request, env) {
  requireAdmin(request, env)
  return json(await state(env, 'status', {}))
}

// Body: the settings to change, e.g. {"device_cap": 1500}. Answers with the whole table.
async function adminSettings(request, env) {
  requireAdmin(request, env)
  const body = await readJson(request)
  return json(await state(env, 'setSettings', { changes: body }))
}

function requireAdmin(request, env) {
  const secret = env.ADMIN_SECRET
  if (!secret) throw { status: 500, message: 'ADMIN_SECRET is not set' }
  const given = request.headers.get('x-admin-secret') || bearer(request)
  if (given !== secret) throw { status: 401, message: 'unauthorized' }
}

// --- plumbing -----------------------------------------------------------------
// One Durable Object, near India, holds codes, devices, budget, settings and cache,
// so a decision costs one round trip (§37.6 K2, speed rules).
async function state(env, method, args) {
  if (!env.STATE) throw { status: 500, message: 'STATE binding is missing' }
  const stub = env.STATE.get(env.STATE.idFromName('global'), { locationHint: 'apac' })
  const res = await stub.fetch('https://mewndo-state/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  const body = await res.json()
  if (!res.ok) throw { status: res.status, message: body.error || 'state error' }
  return body.result
}

function bearer(request) {
  const auth = request.headers.get('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    throw { status: 400, message: 'body must be JSON' }
  }
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

// Verdicts and latency only; the action text never reaches a log (§38.8).
function log(fields) {
  console.log(JSON.stringify(fields))
}

// The Durable Object. Its methods are the ones on State; the allow-list keeps a
// stray request from reaching anything else on the class.
const STATE_METHODS = new Set([
  'auth', 'prepare', 'authPrepare', 'settle', 'saveSample', 'createInvites', 'redeem', 'revoke', 'status',
  'setSettings',
])

export class StateDO {
  constructor(ctx) {
    this.inner = new State(ctx.storage)
  }

  async fetch(request) {
    const { method, args } = await request.json()
    if (!STATE_METHODS.has(method)) return json({ error: `unknown method ${method}` }, 400)
    try {
      return json({ result: await this.inner[method](args ?? {}) })
    } catch (e) {
      if (e && e.status) return json({ error: e.message }, e.status)
      return json({ error: String((e && e.message) || e) }, 500)
    }
  }
}

// One Durable Object per tester (§37.6 K7): the cards cloud agents raise, the
// answers the desktop sends back, and the workflows the user chose to share.
// The WebSocket uses the Hibernation API, so an idle link costs nothing.
const HUB_METHODS = new Set(['rpc', 'createCard', 'answer', 'getCard', 'progress', 'done', 'openCards'])

export class HubDO {
  constructor(ctx, env = {}) {
    this.ctx = ctx
    // ASK_WAIT_MS is a var only so the tests do not wait 110 s for an unanswered card.
    this.hub = new Hub(ctx.storage, (message) => this.broadcast(message), {
      waitMs: Number(env.ASK_WAIT_MS) || undefined,
    })
    this.skills = {
      list: async () => [...(await ctx.storage.list({ prefix: 'skill:' })).keys()].map((k) => k.slice(6)),
      get: async (slug) => (await ctx.storage.get(`skill:${slug}`))?.text ?? null,
    }
  }

  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      // Whatever the desktop missed while it was away.
      pair[1].send(JSON.stringify({ type: 'hub.open', cards: await this.hub.openCards({}) }))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    const { method, args } = await request.json()
    if (!HUB_METHODS.has(method)) return json({ error: `unknown method ${method}` }, 400)
    try {
      if (method === 'rpc') {
        const answer = await mcpHandle(args.rpc, { hub: this.hub, skills: this.skills, agent: args.agent })
        return answer === null ? new Response(null, { status: 204 }) : json({ result: answer })
      }
      return json({ result: await this.hub[method](args ?? {}) })
    } catch (e) {
      if (e && e.status) return json({ error: e.message }, e.status)
      return json({ error: String((e && e.message) || e) }, 500)
    }
  }

  // The desktop answering a card, or sharing a Show Me workflow (§36.5 step 6).
  async webSocketMessage(ws, raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return ws.send(JSON.stringify({ type: 'error', message: 'not JSON' }))
    }
    try {
      if (message.type === 'inbox.answer') {
        const card = await this.hub.answer(message)
        return ws.send(JSON.stringify({ type: 'inbox.release', card_id: card.id }))
      }
      if (message.type === 'skills.share') {
        const key = `skill:${String(message.slug || '').slice(0, 80)}`
        if (message.text == null) await this.ctx.storage.delete(key)
        else await this.ctx.storage.put({ [key]: { text: String(message.text).slice(0, 20_000) } })
        return ws.send(JSON.stringify({ type: 'skills.ok', slug: message.slug }))
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: String((e && e.message) || e) }))
    }
  }

  broadcast(message) {
    const body = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(body)
      } catch {
        // A socket closing mid-send is normal; the card is already stored.
      }
    }
  }
}
