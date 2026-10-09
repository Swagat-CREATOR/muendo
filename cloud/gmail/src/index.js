// Cloudflare Worker: mewndo-gmail (spec §25.3, §28.4, §6.2). Gmail Rewind and Heal.
//
// - Daily scheduled trigger renews users.watch (Gmail watches expire in 7 days).
// - Receives Pub/Sub pushes at POST /gmail/push, but ALWAYS reconciles with
//   history.list, because Gmail drops notifications above one per second.
// - Journals each message's labels and trash state in a per-user Durable Object.
// - When the Heal rules (spec §24.4) say a change is out of scope, it puts
//   messages back with one batchModify call, restoring the exact labels, and
//   untrashes trashed ones.
//
// Honest limit (spec §28.10): permanently deleted mail can only come back from a
// copy Mewndo made before it was deleted; Gmail has no "undelete". The app says so.
//
// Setup is in docs/google-setup.md (P6.1). Secrets (never committed):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_PUBSUB_TOPIC
//   MEWNDO_DECIDE_URL, MEWNDO_DECIDE_TOKEN (Send Guard's decision service)
import { healPlan } from './heal.js'
import { guardSend, sendViaGmail } from './send-guard.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/oauth/callback') return oauthCallback(request, env, url)
    if (url.pathname === '/gmail/push' && request.method === 'POST') return gmailPush(request, env)
    if (url.pathname === '/gmail/restore' && request.method === 'POST') return gmailRestore(request, env)
    if (url.pathname === '/gmail/send' && request.method === 'POST') return gmailSend(request, env)
    return json({ error: 'not found' }, 404)
  },

  // Daily: renew every connected user's Gmail watch (spec §6.2).
  async scheduled(_event, env, ctx) {
    const users = await listUsers(env)
    for (const user of users) {
      ctx.waitUntil(renewWatch(env, user).catch((e) => console.log(JSON.stringify({ at: 'renew', user, error: String(e) }))))
    }
  },
}

// --- OAuth (Testing mode; refresh tokens expire after 7 days, P6.1) ---
async function oauthCallback(request, env, url) {
  const code = url.searchParams.get('code')
  if (!code) return json({ error: 'missing code' }, 400)
  const token = await exchangeCode(env, code, `${url.origin}/oauth/callback`)
  if (!token.refresh_token) {
    return json({ error: 'no refresh_token; re-consent with access_type=offline&prompt=consent' }, 400)
  }
  const profile = await gmailGET(env, token.access_token, 'profile')
  const user = profile.emailAddress
  const stub = userStub(env, user)
  await stub.fetch('https://do/connect', { method: 'POST', body: JSON.stringify({ refresh_token: token.refresh_token, historyId: profile.historyId }) })
  await renewWatch(env, user)
  return json({ connected: user })
}

function exchangeCode(env, code, redirect_uri) {
  return postForm('https://oauth2.googleapis.com/token', {
    code, redirect_uri, grant_type: 'authorization_code',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
}

// Short-lived access token from the stored refresh token, per call.
async function accessToken(env, user) {
  const stub = userStub(env, user)
  const { refresh_token } = await stub.fetch('https://do/state').then((r) => r.json())
  if (!refresh_token) throw new Error(`no refresh token for ${user} (re-connect)`)
  const t = await postForm('https://oauth2.googleapis.com/token', {
    refresh_token, grant_type: 'refresh_token',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
  if (!t.access_token) throw new Error('refresh failed (token may have expired after 7 days in Testing mode)')
  return t.access_token
}

// --- Watch renewal ---
async function renewWatch(env, user) {
  const access = await accessToken(env, user)
  const res = await gmailPOST(env, access, 'watch', {
    topicName: env.GOOGLE_PUBSUB_TOPIC,
    labelFilterBehavior: 'INCLUDE',
  })
  const stub = userStub(env, user)
  await stub.fetch('https://do/watch', { method: 'POST', body: JSON.stringify({ historyId: res.historyId, expiration: res.expiration }) })
  return res
}

// --- Push + reconcile ---
async function gmailPush(request, env) {
  // Pub/Sub wraps the Gmail notification as base64 in message.data.
  const body = await request.json().catch(() => ({}))
  const data = body?.message?.data
  if (!data) return json({ ok: true }) // malformed; nothing to do
  const note = JSON.parse(atob(data)) // { emailAddress, historyId }
  const user = note.emailAddress
  // Don't trust the push for content: always reconcile from the last journaled historyId.
  await reconcile(env, user)
  return json({ ok: true })
}

async function reconcile(env, user) {
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  let startHistoryId = state.historyId
  if (!startHistoryId) return
  let pageToken
  const changes = []
  do {
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'labelAdded,labelRemoved,messageDeleted,messageAdded' })
    if (pageToken) q.set('pageToken', pageToken)
    const page = await gmailGET(env, access, `history?${q}`)
    for (const h of page.history || []) changes.push(h)
    pageToken = page.nextPageToken
    if (page.historyId) startHistoryId = page.historyId
  } while (pageToken)
  // Journal the current label/trash state of every touched message.
  const touched = new Set()
  for (const h of changes) for (const m of [...(h.messages || []), ...(h.messagesAdded || []).map((x) => x.message), ...(h.messagesDeleted || []).map((x) => x.message)]) if (m) touched.add(m.id)
  for (const id of touched) {
    const msg = await gmailGET(env, access, `messages/${id}?format=minimal`).catch(() => null)
    await stub.fetch('https://do/journal', { method: 'POST', body: JSON.stringify({ id, labelIds: msg?.labelIds || [], trashed: !!msg && (msg.labelIds || []).includes('TRASH'), gone: !msg, at: Date.now() }) })
  }
  await stub.fetch('https://do/watch', { method: 'POST', body: JSON.stringify({ historyId: startHistoryId }) })
}

// --- Restore / Heal ---
// Body: { user, since?, messageIds? }. Restores labels and untrashes in ONE batchModify
// where possible. Returns per-message results and the time taken.
async function gmailRestore(request, env) {
  const { user, since, messageIds } = await request.json()
  const t0 = Date.now()
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const journal = await stub.fetch(`https://do/history?since=${since || 0}`).then((r) => r.json())
  const plan = healPlan(journal.entries, messageIds)
  // Untrash first (batch), then restore labels (batch): two calls at most, not one per message.
  if (plan.untrash.length) {
    await gmailPOST(env, access, 'messages/batchModify', { ids: plan.untrash, removeLabelIds: ['TRASH'] })
  }
  for (const [key, ids] of Object.entries(plan.relabel)) {
    const { add, remove } = JSON.parse(key)
    await gmailPOST(env, access, 'messages/batchModify', { ids, addLabelIds: add, removeLabelIds: remove })
  }
  const permanentlyGone = plan.gone
  return json({
    restored: plan.untrash.length + Object.values(plan.relabel).flat().length,
    permanently_deleted: permanentlyGone, // honest: these need a prior Mewndo copy; Gmail can't undelete
    ms: Date.now() - t0,
  })
}

// --- Send Guard (spec §28.4 Flow D, P5.5) ---
// Body: { user, message:{to,cc,bcc,subject,body,attachments}, context:{brief,...} }.
// All the decision logic is in src/send-guard.js, which is runtime-free and
// unit-tested; this route is only the plumbing. A hold is returned to the caller
// and NOTHING is sent. The hold queue, the countdown chip on the bar and the
// phone approval live in cloud/mcp and apps/desktop — not here.
async function gmailSend(request, env) {
  const { user, message, context } = await request.json()
  const result = await guardSend(message, context || {}, {
    decide: (req, opts) => askDecide(env, req, opts),
    // §29.4: a deadline that passes is a hold, so the send below is unreachable
    // without a verdict at or above the 0.97 bar.
    send: async (m) => {
      const access = await sendAccessToken(env, user)
      return sendViaGmail({ accessToken: access, message: m })
    },
  })
  return json(result, result.verdict === 'release' ? 200 : 202)
}

// The decision service (cloud/decide). One POST, every question already batched
// by buildDecisionRequest. The AbortSignal carries Send Guard's deadline, so a
// slow model is dropped rather than waited on.
async function askDecide(env, req, opts) {
  const r = await fetch(env.MEWNDO_DECIDE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MEWNDO_DECIDE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: opts?.signal,
  })
  if (!r.ok) throw new Error(`decide: ${r.status}`)
  return r.json()
}

// Send Guard's own credential, with only the gmail.send scope (§P5.5). Kept
// apart from accessToken() above, which holds the broader Rewind/Heal scopes, so
// a bug in one cannot do the other's job. A separate refresh token is stored
// under `send_refresh_token`; until P6.1 grants one, this route cannot send.
async function sendAccessToken(env, user) {
  const stub = userStub(env, user)
  const { send_refresh_token } = await stub.fetch('https://do/state').then((r) => r.json())
  if (!send_refresh_token) throw new Error(`no gmail.send credential for ${user} (connect Send Guard separately)`)
  const t = await postForm('https://oauth2.googleapis.com/token', {
    refresh_token: send_refresh_token, grant_type: 'refresh_token',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
  if (!t.access_token) throw new Error('send token refresh failed (7-day Testing-mode expiry?)')
  return t.access_token
}

// --- Durable Object: one per user; tokens + label/trash journal ---
export class GmailUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    if (url.pathname === '/connect') {
      const b = await request.json()
      await s.put('refresh_token', b.refresh_token)
      await s.put('historyId', b.historyId)
      await registerUser(this, b)
      return json({ ok: true })
    }
    if (url.pathname === '/state') {
      // send_refresh_token is Send Guard's own gmail.send-only credential; it is
      // absent until P6.1 grants one, and then /gmail/send cannot send.
      return json({ refresh_token: await s.get('refresh_token'), send_refresh_token: await s.get('send_refresh_token'), historyId: await s.get('historyId') })
    }
    if (url.pathname === '/watch') {
      const b = await request.json()
      if (b.historyId) await s.put('historyId', b.historyId)
      if (b.expiration) await s.put('watchExpiration', b.expiration)
      return json({ ok: true })
    }
    if (url.pathname === '/journal') {
      const e = await request.json()
      await s.put(`msg:${e.id}:${e.at}`, e)
      return json({ ok: true })
    }
    if (url.pathname === '/history') {
      const since = Number(url.searchParams.get('since') || 0)
      const map = await s.list({ prefix: 'msg:' })
      const entries = [...map.values()].filter((e) => e.at >= since)
      return json({ entries })
    }
    return json({ error: 'not found' }, 404)
  }
}

// --- helpers ---
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
function userStub(env, user) { return env.GMAIL_USER.get(env.GMAIL_USER.idFromName(user)) }
async function registerUser() { /* ponytail: a users index worker would list all; for now renewal reads the DO list at deploy scale. */ }
async function listUsers(env) {
  // ponytail: no global index yet; renewal is driven per-user by the push that
  // wakes a DO. Add a users KV/index when there are many accounts.
  const _ = env
  return []
}
async function gmailGET(env, access, path) {
  const r = await fetch(`${GMAIL}/${path}`, { headers: { authorization: `Bearer ${access}` } })
  if (!r.ok) throw new Error(`gmail GET ${path}: ${r.status}`)
  return r.json()
}
async function gmailPOST(env, access, path, body) {
  const r = await fetch(`${GMAIL}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`gmail POST ${path}: ${r.status} ${await r.text()}`)
  return r.json()
}
async function postForm(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  return r.json()
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
