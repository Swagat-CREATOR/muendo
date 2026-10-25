// Cloudflare Worker: mewndo-gmail (spec §25.3, §28.4, §6.2). Gmail Rewind and Heal.
//
// - Daily scheduled trigger renews users.watch (Gmail watches expire in 7 days).
// - Receives Pub/Sub pushes at POST /gmail/push, but ALWAYS reconciles with
//   history.list, because Gmail drops notifications above one per second. The app
//   also asks for a reconcile (POST /app/sync) every few minutes, so the journal
//   keeps going even without Pub/Sub.
// - Journals each message's labels and trash state in a per-user Durable Object.
// - Puts messages back with one batchModify call per distinct label change,
//   restoring the exact labels, and untrashes trashed ones.
//
// Honest limit (spec §28.10): permanently deleted mail can only come back from a
// copy Mewndo made before it was deleted; Gmail has no "undelete", and this Worker
// keeps no copies of mail. The app says so.
//
// The app talks to it with an app token (src/app-auth.js); every route that reads
// the journal or changes the mailbox needs it, and the account comes from the token.
//
// Setup: docs/connections-setup.md and docs/google-setup.md. Secrets (never committed):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   MEWNDO_DECIDE_URL, MEWNDO_DECIDE_TOKEN (Send Guard's decision service)
// Var: GOOGLE_PUBSUB_TOPIC (wrangler.toml; optional, see docs/connections-setup.md)
import { healPlan, fromBefore, historyToEntries, changeList } from './heal.js'
import { guardSend, sendViaGmail } from './send-guard.js'
import { accounts, accountFrom, authRoutes, makeAppToken, isClaimHash, isClaimSecret, sha256hex, donePage } from './app-auth.js'

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const DAY = 24 * 3600 * 1000

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/oauth/start') return oauthStart(env, url)
    if (url.pathname === '/oauth/callback') return oauthCallback(env, url)
    if (url.pathname === '/oauth/claim' && request.method === 'POST') return oauthClaim(request, env)
    if (url.pathname === '/gmail/push' && request.method === 'POST') return gmailPush(request, env)
    if (url.pathname === '/gmail/send' && request.method === 'POST') return gmailSend(request, env)
    // Everything below speaks for one account: the app token says which.
    if (url.pathname === '/app/status' || url.pathname === '/app/sync' || url.pathname === '/app/changes'
      || url.pathname === '/app/disconnect' || url.pathname === '/gmail/restore') {
      const user = await accountFrom(request, (a) => accounts(env.GMAIL_USER).tokenHash(a))
      if (!user) return json({ error: 'Mewndo isn’t signed in to this Gmail Worker. Connect Gmail again in Mewndo.' }, 401)
      if (url.pathname === '/app/status') return json(await status(env, user))
      if (url.pathname === '/app/sync' && request.method === 'POST') return json(await sync(env, user))
      if (url.pathname === '/app/changes') return json(await changes(env, user, url))
      if (url.pathname === '/app/disconnect' && request.method === 'POST') return json(await disconnect(env, user))
      if (url.pathname === '/gmail/restore' && request.method === 'POST') return gmailRestore(request, env, user)
    }
    return json({ error: 'not found' }, 404)
  },

  // Daily: renew every connected user's Gmail watch (spec §6.2) and reconcile.
  async scheduled(_event, env, ctx) {
    for (const user of await accounts(env.GMAIL_USER).list()) {
      ctx.waitUntil(sync(env, user, { renew: true }).catch((e) => console.log(JSON.stringify({ at: 'renew', error: String(e) }))))
    }
  },
}

// --- Signing in (Testing mode: refresh tokens expire after 7 days, P6.1) ---
function oauthStart(env, url) {
  const claim = url.searchParams.get('claim')
  if (!isClaimHash(claim)) return json({ error: 'missing claim' }, 400)
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return donePage('Gmail', null, 'This Worker has no Google client yet: run `npx wrangler@3 secret put GOOGLE_CLIENT_ID` and GOOGLE_CLIENT_SECRET in cloud/gmail (docs/connections-setup.md).')
  }
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/oauth/callback`, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state: claim,
  })
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302)
}

async function oauthCallback(env, url) {
  const code = url.searchParams.get('code')
  const claim = url.searchParams.get('state')
  if (url.searchParams.get('error')) return donePage('Gmail', null, `Google said: ${url.searchParams.get('error')}.`)
  if (!code) return donePage('Gmail', null, 'Google sent no sign-in code.')
  const token = await exchangeCode(env, code, `${url.origin}/oauth/callback`)
  if (!token.refresh_token) return donePage('Gmail', null, 'Google gave no refresh token. Remove Mewndo at myaccount.google.com/permissions and connect again.')
  if (!String(token.scope || '').includes(SCOPE)) return donePage('Gmail', null, 'Mewndo needs the "read, compose and change labels" Gmail permission to undo changes. Connect again and leave it ticked.')
  const profile = await gmailGET(env, token.access_token, 'profile')
  const user = profile.emailAddress
  const acct = accounts(env.GMAIL_USER)
  await userStub(env, user).fetch('https://do/connect', { method: 'POST', body: JSON.stringify({ refresh_token: token.refresh_token, historyId: profile.historyId }) })
  await acct.add(user)
  // No Pub/Sub topic yet is not a failure: the app's sync every few minutes keeps the journal going.
  await renewWatch(env, user).catch((e) => setState(env, user, { watchError: String(e.message || e) }))
  if (isClaimHash(claim)) {
    const app = await makeAppToken(user)
    await acct.setTokenHash(user, app.hash)
    await acct.park(claim, { user, token: app.token })
  }
  return donePage('Gmail', user)
}

// The app collects its token once, with the secret behind the claim hash.
async function oauthClaim(request, env) {
  const { claim } = await request.json().catch(() => ({}))
  if (!isClaimSecret(claim)) return json({ error: 'bad claim' }, 400)
  const got = await accounts(env.GMAIL_USER).take(await sha256hex(claim))
  return got ? json({ user: got.user, token: got.token }) : json({ pending: true }, 404)
}

function exchangeCode(env, code, redirect_uri) {
  return postForm('https://oauth2.googleapis.com/token', {
    code, redirect_uri, grant_type: 'authorization_code',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
}

// Short-lived access token from the stored refresh token, per call.
async function accessToken(env, user) {
  const { refresh_token } = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  if (!refresh_token) throw new SignInError(`no refresh token for this account (connect again)`)
  const t = await postForm('https://oauth2.googleapis.com/token', {
    refresh_token, grant_type: 'refresh_token',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
  if (!t.access_token) throw new SignInError('Google refused the saved sign-in. In Testing mode it lasts 7 days: connect Gmail again.')
  return t.access_token
}
class SignInError extends Error {}

// --- Watch renewal (needs GOOGLE_PUBSUB_TOPIC; optional) ---
async function renewWatch(env, user) {
  if (!env.GOOGLE_PUBSUB_TOPIC || env.GOOGLE_PUBSUB_TOPIC.includes('YOUR-PROJECT')) throw new Error('no Pub/Sub topic set, so Gmail push is off; Mewndo checks every few minutes instead')
  const access = await accessToken(env, user)
  const res = await gmailPOST(env, access, 'watch', { topicName: env.GOOGLE_PUBSUB_TOPIC, labelFilterBehavior: 'INCLUDE' })
  await userStub(env, user).fetch('https://do/watch', { method: 'POST', body: JSON.stringify({ expiration: Number(res.expiration), watchError: null }) })
  return res
}

// --- Push + reconcile ---
async function gmailPush(request, env) {
  // Pub/Sub wraps the Gmail notification as base64 in message.data.
  const body = await request.json().catch(() => ({}))
  const data = body?.message?.data
  if (!data) return json({ ok: true }) // malformed; nothing to do
  let note
  try { note = JSON.parse(atob(data)) } catch { return json({ ok: true }) }
  const user = note.emailAddress
  // Only accounts that connected through Mewndo; don't trust the push for content: always reconcile.
  if (user && (await accounts(env.GMAIL_USER).tokenHash(user))) await reconcile(env, user).catch(() => null)
  return json({ ok: true })
}

async function sync(env, user, { renew = false } = {}) {
  const state = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  if (renew || !state.watchExpiration || state.watchExpiration - Date.now() < DAY) {
    await renewWatch(env, user).catch((e) => setState(env, user, { watchError: String(e.message || e) }))
  }
  try {
    return { ok: true, ...(await reconcile(env, user)) }
  } catch (e) {
    if (e instanceof SignInError) { await setState(env, user, { signInError: e.message }); return { ok: false, signIn: true, error: e.message } }
    throw e
  }
}

async function reconcile(env, user, { by = null } = {}) {
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  let startHistoryId = state.historyId
  if (!startHistoryId) return { journaled: 0 }
  let pageToken
  const history = []
  try {
    do {
      const q = new URLSearchParams({ startHistoryId, maxResults: '500' })
      if (pageToken) q.set('pageToken', pageToken)
      const page = await gmailGET(env, access, `history?${q}`)
      history.push(...(page.history || []))
      pageToken = page.nextPageToken
      if (page.historyId && !pageToken) startHistoryId = page.historyId
    } while (pageToken)
  } catch (e) {
    // Gmail keeps history for about a week; past that, start again from now and say there's a gap.
    if (!String(e.message).includes(': 404')) throw e
    const profile = await gmailGET(env, access, 'profile')
    await setState(env, user, { historyId: profile.historyId, gapAt: Date.now(), signInError: null })
    return { journaled: 0, gap: true }
  }
  const items = historyToEntries(history)
  // A message the records don't show labels for: ask Gmail, a few per run (the free plan's subrequest limit).
  let skipped = 0
  let fetched = 0
  for (const it of items) {
    if (!it.needsFetch) continue
    if (fetched >= 20) { skipped++; continue }
    fetched++
    const msg = await gmailGET(env, access, `messages/${it.id}?format=minimal`).catch(() => null)
    it.after = msg ? { labelIds: msg.labelIds || [], trashed: (msg.labelIds || []).includes('TRASH'), gone: false } : { labelIds: [], trashed: false, gone: true }
    it.before = null
    delete it.needsFetch
  }
  const ready = items.filter((it) => !it.needsFetch)
  await stub.fetch('https://do/journal-batch', { method: 'POST', body: JSON.stringify({ at: Date.now(), items: ready, by }) })
  await setState(env, user, { historyId: startHistoryId, lastSync: Date.now(), signInError: null, skipped })
  return { journaled: ready.length, skipped }
}

async function status(env, user) {
  const s = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  return {
    user, connected: !!s.refresh_token, lastSync: s.lastSync ?? null, watchExpiration: s.watchExpiration ?? null,
    pushOn: !!s.watchExpiration && s.watchExpiration > Date.now(), watchError: s.watchError ?? null,
    gapAt: s.gapAt ?? null, signInError: s.signInError ?? null, skipped: s.skipped ?? 0,
  }
}

// The journal as changes, newest first, with each message's subject for the newest few.
async function changes(env, user, url) {
  const since = Number(url.searchParams.get('since') || 0)
  const journal = await userStub(env, user).fetch(`https://do/history?since=0`).then((r) => r.json())
  const list = changeList(journal.entries).filter((c) => c.at >= since).slice(0, 100)
  const access = await accessToken(env, user).catch(() => null)
  if (access) {
    await Promise.all(list.slice(0, 20).map(async (c) => {
      const m = await gmailGET(env, access, `messages/${c.id}?format=metadata&metadataHeaders=Subject`).catch(() => null)
      const subject = m?.payload?.headers?.find((h) => h.name.toLowerCase() === 'subject')?.value
      if (subject) c.title = subject.slice(0, 120)
    }))
  }
  return { changes: list }
}

// --- Restore / Heal ---
// Body: { messageIds?, before? }. `before` puts each message back as it was just before that time. Untrash in one
// batchModify, then one per distinct label change. Returns what came back, what can't, and the time taken.
async function gmailRestore(request, env, user) {
  const { messageIds, before } = await request.json().catch(() => ({}))
  if (messageIds !== undefined && !(Array.isArray(messageIds) && messageIds.every((x) => typeof x === 'string'))) return json({ error: 'bad messageIds' }, 400)
  const t0 = Date.now()
  const access = await accessToken(env, user)
  await reconcile(env, user).catch(() => null) // catch up first, so the next reconcile holds only Mewndo's own changes
  const journal = await userStub(env, user).fetch('https://do/history?since=0').then((r) => r.json())
  const plan = healPlan(fromBefore(journal.entries, Number(before) || 0), messageIds)
  for (let i = 0; i < plan.untrash.length; i += 1000) {
    await gmailPOST(env, access, 'messages/batchModify', { ids: plan.untrash.slice(i, i + 1000), removeLabelIds: ['TRASH'] })
  }
  for (const [key, ids] of Object.entries(plan.relabel)) {
    const { add, remove } = JSON.parse(key)
    for (let i = 0; i < ids.length; i += 1000) {
      await gmailPOST(env, access, 'messages/batchModify', { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove })
    }
  }
  // Journal what was put back right away, marked as Mewndo's own, so the app's list doesn't show it as an agent's.
  await reconcile(env, user, { by: 'mewndo' }).catch(() => null)
  return json({
    restored: new Set([...plan.untrash, ...Object.values(plan.relabel).flat()]).size,
    permanently_deleted: plan.gone, // honest: Gmail can't undelete and this Worker keeps no copy
    ms: Date.now() - t0,
  })
}

// Disconnect: stop the watch, revoke Google's grant, and forget this account here (journal included).
async function disconnect(env, user) {
  const stub = userStub(env, user)
  const { refresh_token } = await stub.fetch('https://do/state').then((r) => r.json())
  if (refresh_token) {
    const access = await accessToken(env, user).catch(() => null)
    if (access) await gmailPOST(env, access, 'stop', {}).catch(() => null)
    await postForm('https://oauth2.googleapis.com/revoke', { token: refresh_token }).catch(() => null)
  }
  const acct = accounts(env.GMAIL_USER)
  await acct.forget(user)
  await acct.remove(user)
  return { ok: true }
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

// --- Durable Object: one per account (and one per sign-in claim, and the account index) ---
export class GmailUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    const shared = await authRoutes(s, url, request)
    if (shared) return shared
    if (url.pathname === '/connect') {
      const b = await request.json()
      await s.put('refresh_token', b.refresh_token)
      // Keep the journal's place on a re-connect (the 7-day Testing-mode re-sign-in): only a first connect starts it.
      if (!(await s.get('historyId'))) await s.put('historyId', b.historyId)
      await s.put('signInError', null)
      return json({ ok: true })
    }
    if (url.pathname === '/state') {
      // send_refresh_token is Send Guard's own gmail.send-only credential; it is
      // absent until P6.1 grants one, and then /gmail/send cannot send.
      const keys = ['refresh_token', 'send_refresh_token', 'historyId', 'watchExpiration', 'watchError', 'lastSync', 'gapAt', 'signInError', 'skipped']
      const got = await s.get(keys)
      return json(Object.fromEntries(keys.map((k) => [k, got.get(k)])))
    }
    if (url.pathname === '/watch' || url.pathname === '/set') {
      const b = await request.json()
      for (const [k, v] of Object.entries(b)) {
        if (!['historyId', 'expiration', 'watchExpiration', 'watchError', 'lastSync', 'gapAt', 'signInError', 'skipped'].includes(k)) continue
        if (k === 'historyId' && !v) continue
        await s.put(k === 'expiration' ? 'watchExpiration' : k, v)
      }
      return json({ ok: true })
    }
    if (url.pathname === '/journal-batch') {
      // items: [{ id, before, after }]. A message seen for the first time also gets its state before the change,
      // walked back from Gmail's history, so the very first change Mewndo sees can be undone.
      const { at, items, by } = await request.json()
      for (const it of items) {
        const known = (await s.list({ prefix: `msg:${it.id}:`, limit: 1 })).size > 0
        if (!known && it.before) await s.put(`msg:${it.id}:${at - 1}`, { id: it.id, ...it.before, at: at - 1, inferred: true })
        await s.put(`msg:${it.id}:${at}`, { id: it.id, ...it.after, at, ...(by ? { by } : {}) })
      }
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
function userStub(env, user) { return accounts(env.GMAIL_USER).stub(`user:${user}`) }
function setState(env, user, patch) {
  return userStub(env, user).fetch('https://do/set', { method: 'POST', body: JSON.stringify(patch) })
}
async function gmailGET(env, access, path) {
  const r = await fetch(`${GMAIL}/${path}`, { headers: { authorization: `Bearer ${access}` } })
  if (!r.ok) throw new Error(`gmail GET ${path.split('?')[0]}: ${r.status}`)
  return r.json()
}
async function gmailPOST(env, access, path, body) {
  const r = await fetch(`${GMAIL}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`gmail POST ${path}: ${r.status} ${await r.text()}`)
  return r.status === 204 ? {} : r.json().catch(() => ({}))
}
async function postForm(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  return r.json().catch(() => ({}))
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
