'use strict'
// StateDO's logic (spec §37.6 K2): invites, tokens, the daily neuron budget, the
// 5-minute answer cache and the Kaggle backend record.
//
// One Durable Object holds all of it, so a decision needs exactly one round trip
// that settles cache, budget and backend choice together (§37.6 speed rules), and
// so the free Workers KV write limit never comes into it (§37.6 pitfalls).
//
// This file takes a storage object rather than a Durable Object state, which is
// what lets node:test drive every path with a fake. src/index.js passes the real
// `ctx.storage`.
import {
  CACHE_SECONDS, MAX_TESTERS, TOTAL_CAP, TESTER_CAP, backendAlive, utcDay, plan,
  newToken, newInviteCode, validateBackendReport, median,
} from './gateway.js'

const LATENCY_KEEP = 50 // enough for a stable median in /admin/status, small enough to write often
const USAGE_KEEP_DAYS = 7
const KAGGLE = 'kaggle'

class State {
  constructor(storage, options = {}) {
    this.storage = storage
    // Injectable only so tests are deterministic; production uses crypto.
    this.newToken = options.newToken ?? newToken
    this.newInviteCode = options.newInviteCode ?? newInviteCode
  }

  // --- K3 auth --------------------------------------------------------------
  async auth(token) {
    if (typeof token !== 'string' || !token) return null
    const row = await this.storage.get(`token:${token}`)
    if (!row || row.revoked) return null
    return { tester: row.tester, name: row.name ?? null }
  }

  // The invite code is the tester id: one code, one tester, for the whole demo.
  // Refuses to mint more than §37.2's budget was sized for.
  async createInvites({ count = MAX_TESTERS, now = Date.now() } = {}) {
    const wanted = Math.floor(Number(count))
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > MAX_TESTERS) {
      throw { status: 400, message: `count must be 1 to ${MAX_TESTERS}` }
    }
    const invites = await this.storage.list({ prefix: 'invite:' })
    const tokens = await this.storage.list({ prefix: 'token:' })
    const open = [...invites.values()].filter((i) => !i.used_by).length
    const live = [...tokens.values()].filter((t) => !t.revoked).length
    if (open + live + wanted > MAX_TESTERS) {
      throw {
        status: 409,
        message: `${open} unused codes and ${live} active testers already; the free budget is sized for ${MAX_TESTERS}`,
      }
    }
    const codes = []
    for (let i = 0; i < wanted; i++) {
      let code = this.newInviteCode()
      while (await this.storage.get(`invite:${code}`)) code = this.newInviteCode()
      await this.storage.put({ [`invite:${code}`]: { code, used_by: null, created_at: now } })
      codes.push(code)
    }
    return { codes }
  }

  async redeem({ code, name = null, now = Date.now() } = {}) {
    const key = `invite:${String(code ?? '').trim().toUpperCase()}`
    const invite = await this.storage.get(key)
    if (!invite) throw { status: 404, message: 'no such invite code' }
    if (invite.used_by) throw { status: 409, message: 'that invite code has already been used' }
    const token = this.newToken()
    // The code is the tester id, so a revoked-and-reissued token keeps the same
    // budget row and the same place in /admin/status.
    await this.storage.put({
      [key]: { ...invite, used_by: token },
      [`token:${token}`]: { token, tester: invite.code, name, revoked: 0 },
    })
    return { token, tester: invite.code }
  }

  async revoke({ token } = {}) {
    const key = `token:${String(token ?? '')}`
    const row = await this.storage.get(key)
    if (!row) throw { status: 404, message: 'no such token' }
    await this.storage.put({ [key]: { ...row, revoked: 1 } })
    return { revoked: row.tester }
  }

  // --- K4 one round trip per decision --------------------------------------
  // What /v1/decide calls: the token check and prepare in the same round trip.
  async authPrepare({ token, ...args } = {}) {
    const who = await this.auth(token)
    if (!who) throw { status: 401, message: 'unauthorized' }
    return { ...(await this.prepare({ ...args, tester: who.tester })), tester: who.tester }
  }

  // Reads cache, today's usage and the backend record together, applies §37.3 and
  // §37.2, and reserves the neurons when the answer is Workers AI's to give.
  async prepare({ tester, sig, scope, kind, estNeurons, deadlineMs, now = Date.now() } = {}) {
    const day = utcDay(now)
    const cacheKey = `cache:${sig}`
    const usageKey = `usage:${day}`
    const read = await this.storage.get([cacheKey, usageKey, `backend:${KAGGLE}`])
    const found = read.get(cacheKey) ?? null
    // An entry another tester or another brief wrote is not this caller's answer.
    const cache = found && found.scope === scope ? found : null
    const usage = read.get(usageKey) ?? { day, total: 0, testers: {} }
    const backend = read.get(`backend:${KAGGLE}`) ?? null

    const decision = plan({
      kind,
      now,
      cache,
      usage: { total: usage.total ?? 0, tester: usage.testers?.[tester] ?? 0 },
      backend,
      estNeurons,
      deadlineMs,
    })

    // A stale entry is dropped as it is found, which keeps recurring signatures
    // from piling up without a sweep on the hot path.
    if (found && decision.route !== 'cache') await this.storage.delete(cacheKey)

    if (decision.reserve > 0) {
      usage.day = day
      usage.total = (usage.total ?? 0) + decision.reserve
      usage.testers = { ...(usage.testers ?? {}), [tester]: (usage.testers?.[tester] ?? 0) + decision.reserve }
      await this.storage.put({ [usageKey]: usage })
    }
    return decision
  }

  // Everything that can wait until after the response (§37.6 K4.5, run under
  // ctx.waitUntil): cache the answers, correct the reservation against the real
  // neuron count if the backend reported one, and record the latency.
  async settle({ tester, sig, scope, answers, backend, ms, reserved = 0, actualNeurons = null, now = Date.now() } = {}) {
    const writes = {}
    if (answers && sig) writes[`cache:${sig}`] = { answers, scope, expires: now + CACHE_SECONDS * 1000 }

    if (Number.isFinite(actualNeurons) && reserved > 0 && actualNeurons !== reserved) {
      const usageKey = `usage:${utcDay(now)}`
      const usage = (await this.storage.get(usageKey)) ?? { day: utcDay(now), total: 0, testers: {} }
      const fix = actualNeurons - reserved
      usage.total = Math.max(0, (usage.total ?? 0) + fix)
      usage.testers = { ...(usage.testers ?? {}), [tester]: Math.max(0, (usage.testers?.[tester] ?? 0) + fix) }
      writes[usageKey] = usage
    }

    if (backend && Number.isFinite(ms)) {
      const key = `lat:${backend}`
      const seen = (await this.storage.get(key)) ?? []
      writes[key] = [...seen, Math.round(ms)].slice(-LATENCY_KEEP)
    }

    if (Object.keys(writes).length) await this.storage.put(writes)
    await this.pruneUsage(now)
  }

  // §34.9 R6: when a backend answers in a shape we don't understand, keep one raw
  // sample so the parser can be fixed against something real (§32.5 rule 2), and
  // only one, so a broken backend can't fill the object.
  async saveSample({ backend, raw, reason, now = Date.now() } = {}) {
    if (await this.storage.get('sample:clef')) return
    await this.storage.put({
      'sample:clef': { at: now, backend, reason, raw: String(raw).slice(0, 8000) },
    })
  }

  async pruneUsage(now) {
    const keep = new Set()
    for (let i = 0; i < USAGE_KEEP_DAYS; i++) keep.add(`usage:${utcDay(now - i * 86_400_000)}`)
    const rows = await this.storage.list({ prefix: 'usage:' })
    for (const key of rows.keys()) if (!keep.has(key)) await this.storage.delete(key)
  }

  // --- K5 Kaggle register and heartbeat ------------------------------------
  async reportBackend({ now = Date.now(), ...body } = {}) {
    const { url, p50_ms } = validateBackendReport(body)
    await this.storage.put({ [`backend:${KAGGLE}`]: { name: KAGGLE, url, p50_ms, last_beat: now } })
    return { ok: true, url, p50_ms }
  }

  // --- K3 /admin/status -----------------------------------------------------
  async status({ now = Date.now() } = {}) {
    const day = utcDay(now)
    const usage = (await this.storage.get(`usage:${day}`)) ?? { total: 0, testers: {} }
    const tokens = await this.storage.list({ prefix: 'token:' })
    const invites = await this.storage.list({ prefix: 'invite:' })
    const backend = (await this.storage.get(`backend:${KAGGLE}`)) ?? null
    const latency = {}
    for (const name of ['workers_ai', KAGGLE]) {
      latency[name] = median((await this.storage.get(`lat:${name}`)) ?? [])
    }
    const sample = await this.storage.get('sample:clef')
    return {
      day,
      neurons: {
        used: usage.total ?? 0,
        total_cap: TOTAL_CAP,
        tester_cap: TESTER_CAP,
        testers: [...tokens.values()]
          .filter((t) => !t.revoked)
          .map((t) => ({ tester: t.tester, name: t.name ?? null, used: usage.testers?.[t.tester] ?? 0 })),
      },
      invites: {
        unused: [...invites.values()].filter((i) => !i.used_by).map((i) => i.code),
        used: [...invites.values()].filter((i) => i.used_by).length,
        revoked: [...tokens.values()].filter((t) => t.revoked).length,
      },
      kaggle: backend
        ? { url: backend.url, p50_ms: backend.p50_ms, last_beat: backend.last_beat, alive: backendAlive(backend, now) }
        : null,
      latency_median_ms: latency,
      // Present only when a backend answered in a shape the parser didn't know.
      unknown_answer_sample: sample ? { at: sample.at, backend: sample.backend, reason: sample.reason } : null,
    }
  }
}

export { State, LATENCY_KEEP }
