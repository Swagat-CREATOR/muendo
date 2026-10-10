'use strict'
// StateDO's logic (spec §37.6 K2): judge codes and their devices, tokens, the daily
// neuron budget and its settings table, and the 5-minute answer cache.
//
// One Durable Object holds all of it, so a decision needs exactly one round trip
// that settles auth, cache and budget together (§37.6 speed rules), and so the free
// Workers KV write limit never comes into it (§37.6 pitfalls).
//
// A judge code is an invite code. It can be redeemed on up to `devices_per_code`
// devices; each device gets its own token, and the budget counts per device and per
// code (gateway.js, DEFAULT_SETTINGS).
//
// This file takes a storage object rather than a Durable Object state, which is
// what lets node:test drive every path with a fake. src/index.js passes the real
// `ctx.storage`.
import {
  CACHE_SECONDS, utcDay, resetAt, budgetState, plan, validateSettings,
  newToken, newInviteCode, median,
} from './gateway.js'

const LATENCY_KEEP = 50 // enough for a stable median in /admin/status, small enough to write often
const USAGE_KEEP_DAYS = 7

const emptyUsage = (day) => ({ day, total: 0, codes: {}, devices: {} })

class State {
  constructor(storage, options = {}) {
    this.storage = storage
    // Injectable only so tests are deterministic; production uses crypto.
    this.newToken = options.newToken ?? newToken
    this.newInviteCode = options.newInviteCode ?? newInviteCode
  }

  // --- the settings table -----------------------------------------------------
  async settings() {
    return validateSettings((await this.storage.get('settings')) ?? {})
  }

  // POST /admin/settings: change some settings, keep the rest. Returns the whole table.
  async setSettings({ changes = {} } = {}) {
    const stored = (await this.storage.get('settings')) ?? {}
    const next = { ...stored, ...changes }
    const table = validateSettings(next)
    await this.storage.put({ settings: next })
    return table
  }

  // --- K3 auth --------------------------------------------------------------
  async auth(token) {
    if (typeof token !== 'string' || !token) return null
    const row = await this.storage.get(`token:${token}`)
    if (!row || row.revoked) return null
    return { tester: row.tester, device: row.device ?? row.tester, name: row.name ?? null }
  }

  // Refuses to mint more codes than the budget was sized for (settings.max_codes).
  async createInvites({ count, now = Date.now() } = {}) {
    const settings = await this.settings()
    const wanted = Math.floor(Number(count ?? settings.max_codes))
    if (!Number.isFinite(wanted) || wanted < 1 || wanted > settings.max_codes) {
      throw { status: 400, message: `count must be 1 to ${settings.max_codes}` }
    }
    const invites = await this.storage.list({ prefix: 'invite:' })
    const live = [...invites.values()].filter((i) => !i.retired).length
    if (live + wanted > settings.max_codes) {
      throw {
        status: 409,
        message: `${live} judge codes already; the free budget is sized for ${settings.max_codes}`,
      }
    }
    const codes = []
    for (let i = 0; i < wanted; i++) {
      let code = this.newInviteCode()
      while (await this.storage.get(`invite:${code}`)) code = this.newInviteCode()
      await this.storage.put({ [`invite:${code}`]: { code, devices: [], created_at: now } })
      codes.push(code)
    }
    return { codes }
  }

  // One more device on a judge code, up to devices_per_code live ones.
  async redeem({ code, name = null, now = Date.now() } = {}) {
    const key = `invite:${String(code ?? '').trim().toUpperCase()}`
    const invite = await this.storage.get(key)
    if (!invite || invite.retired) throw { status: 404, message: 'no such invite code' }
    const settings = await this.settings()
    const devices = invite.devices ?? []
    const live = []
    for (const d of devices) {
      const row = await this.storage.get(`token:${d.token}`)
      if (row && !row.revoked) live.push(d)
    }
    if (live.length >= settings.devices_per_code) {
      throw { status: 409, message: `that code is already in use on ${live.length} devices` }
    }
    const token = this.newToken()
    const device = `${invite.code}-${devices.length + 1}`
    await this.storage.put({
      [key]: { ...invite, devices: [...devices, { device, token, name, at: now }] },
      [`token:${token}`]: { token, tester: invite.code, device, name, revoked: 0 },
    })
    return { token, tester: invite.code, device }
  }

  async revoke({ token } = {}) {
    const key = `token:${String(token ?? '')}`
    const row = await this.storage.get(key)
    if (!row) throw { status: 404, message: 'no such token' }
    await this.storage.put({ [key]: { ...row, revoked: 1 } })
    return { revoked: row.device ?? row.tester }
  }

  // --- K4 one round trip per decision --------------------------------------
  // What /v1/decide calls: the token check and prepare in the same round trip.
  async authPrepare({ token, ...args } = {}) {
    const who = await this.auth(token)
    if (!who) throw { status: 401, message: 'unauthorized' }
    return { ...(await this.prepare({ ...args, tester: who.tester, device: who.device })), tester: who.tester, device: who.device }
  }

  // Reads cache, today's usage and the settings together, plans the route, and
  // reserves the neurons when the answer is Workers AI's to give.
  async prepare({ tester, device = tester, sig, scope, kind, estNeurons, deadlineMs, now = Date.now() } = {}) {
    const day = utcDay(now)
    const cacheKey = `cache:${sig}`
    const usageKey = `usage:${day}`
    const read = await this.storage.get([cacheKey, usageKey, 'settings'])
    const found = read.get(cacheKey) ?? null
    // An entry another tester or another brief wrote is not this caller's answer.
    const cache = found && found.scope === scope ? found : null
    const usage = { ...emptyUsage(day), ...(read.get(usageKey) ?? {}) }
    const settings = validateSettings(read.get('settings') ?? {})

    const decision = plan({
      kind,
      now,
      cache,
      usage: { total: usage.total, code: usage.codes[tester] ?? 0, device: usage.devices[device] ?? 0 },
      estNeurons,
      deadlineMs,
      settings,
    })

    // A stale entry is dropped as it is found, which keeps recurring signatures
    // from piling up without a sweep on the hot path.
    if (found && decision.route !== 'cache') await this.storage.delete(cacheKey)

    if (decision.reserve > 0) {
      await this.storage.put({ [usageKey]: charge(usage, tester, device, decision.reserve) })
    }
    return decision
  }

  // Everything that can wait until after the response (§37.6 K4.5, run under
  // ctx.waitUntil): cache the answers, correct the reservation against the real
  // neuron count if the model reported one, and record the latency.
  async settle({
    tester, device = tester, sig, scope, answers, backend, ms, reserved = 0, actualNeurons = null, now = Date.now(),
  } = {}) {
    const writes = {}
    if (answers && sig) writes[`cache:${sig}`] = { answers, scope, expires: now + CACHE_SECONDS * 1000 }

    if (Number.isFinite(actualNeurons) && reserved > 0 && actualNeurons !== reserved) {
      const usageKey = `usage:${utcDay(now)}`
      const usage = { ...emptyUsage(utcDay(now)), ...((await this.storage.get(usageKey)) ?? {}) }
      writes[usageKey] = charge(usage, tester, device, actualNeurons - reserved)
    }

    if (backend && Number.isFinite(ms)) {
      const key = `lat:${backend}`
      const seen = (await this.storage.get(key)) ?? []
      writes[key] = [...seen, Math.round(ms)].slice(-LATENCY_KEEP)
    }

    if (Object.keys(writes).length) await this.storage.put(writes)
    await this.pruneUsage(now)
  }

  // §34.9 R6: when the model answers in a shape we don't understand, keep one raw
  // sample so the parser can be fixed against something real (§32.5 rule 2), and
  // only one, so a broken model can't fill the object.
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

  // --- K3 /admin/status -----------------------------------------------------
  async status({ now = Date.now() } = {}) {
    const day = utcDay(now)
    const usage = { ...emptyUsage(day), ...((await this.storage.get(`usage:${day}`)) ?? {}) }
    const settings = await this.settings()
    const tokens = [...(await this.storage.list({ prefix: 'token:' })).values()]
    const invites = [...(await this.storage.list({ prefix: 'invite:' })).values()]
    const budget = budgetState(settings, usage.total)
    const sample = await this.storage.get('sample:clef')
    return {
      day,
      budget: {
        used: budget.used,
        remaining: budget.remaining,
        total_cap: settings.total_cap,
        // The next 00:00 UTC, when Workers AI's free allowance starts again.
        resets_at: new Date(resetAt(now)).toISOString(),
        resets_in_minutes: Math.ceil((resetAt(now) - now) / 60_000),
        low: budget.low,
        rules_only: budget.rules_only,
      },
      settings,
      codes: invites.map((i) => ({
        code: i.code,
        used: usage.codes[i.code] ?? 0,
        devices: tokens
          .filter((t) => t.tester === i.code)
          .map((t) => ({
            device: t.device ?? t.tester,
            name: t.name ?? null,
            revoked: Boolean(t.revoked),
            used: usage.devices[t.device ?? t.tester] ?? 0,
          })),
      })),
      latency_median_ms: { workers_ai: median((await this.storage.get('lat:workers_ai')) ?? []) },
      // Present only when the model answered in a shape the parser didn't know.
      unknown_answer_sample: sample ? { at: sample.at, backend: sample.backend, reason: sample.reason } : null,
    }
  }
}

// Adds `n` (negative to give back) to the day, the code and the device, never below 0.
function charge(usage, code, device, n) {
  const add = (v) => Math.max(0, (v ?? 0) + n)
  return {
    ...usage,
    total: add(usage.total),
    codes: { ...usage.codes, [code]: add(usage.codes[code]) },
    devices: { ...usage.devices, [device]: add(usage.devices[device]) },
  }
}

export { State, LATENCY_KEEP }
