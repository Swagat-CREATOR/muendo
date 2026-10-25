// Cloudflare Worker: mewndo-notion (spec §25.3, §6.4). Notion Rewind and Heal.
//
// - Connect: the app sends the user's Notion internal integration secret once
//   (POST /notion/connect). The Worker checks it with Notion, keeps it in the
//   account's Durable Object (it needs it to poll), and gives the app an app token.
//   The app never stores the Notion secret.
// - Polling on last_edited_time every minute (cron), plus POST /app/sync from the
//   app. Webhooks (POST /notion/webhook) only mean "look now".
// - Block snapshots (top level, first 100 blocks) for pages shared with the integration.
// - Restore sets in_trash:false, then appends the missing blocks from the snapshot.
// - Rate limited to about 3 requests per second, as Notion asks.
//
// Honest limit (spec §28.10, shown in the app): Notion notifications can take a
// minute or more, so Notion undo is about ONE TO TWO MINUTES unless the change
// went through Mewndo's MCP (then it is immediate, because Mewndo saw it first).
import { RateLimiter, restorePlan, UNDO_LAG_NOTE, fromBefore, changeList, looksLikeNotionToken } from './heal.js'
import { accounts, accountFrom, authRoutes, makeAppToken } from './app-auth.js'

const NOTION = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28' // current stable API version; in_trash is supported
const PAGES_PER_POLL = 15 // the free Workers plan allows 50 subrequests per run
const TRASH_CHECKS_PER_POLL = 10
const APP_ROUTES = new Set(['/app/status', '/app/sync', '/app/changes', '/app/disconnect', '/notion/restore'])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/notion/webhook' && request.method === 'POST') return webhook(request, env)
    if (url.pathname === '/notion/connect' && request.method === 'POST') return connect(request, env)
    if (url.pathname === '/notion/limits') return json({ undo_lag: UNDO_LAG_NOTE })
    if (APP_ROUTES.has(url.pathname)) {
      const user = await accountFrom(request, (a) => accounts(env.NOTION_USER).tokenHash(a))
      if (!user) return json({ error: 'Mewndo isn’t signed in to this Notion Worker. Connect Notion again in Mewndo.' }, 401)
      if (url.pathname === '/app/status') return json(await status(env, user))
      if (url.pathname === '/app/sync' && request.method === 'POST') return json(await sync(env, user))
      if (url.pathname === '/app/changes') return json(await changes(env, user, url))
      if (url.pathname === '/app/disconnect' && request.method === 'POST') return json(await disconnect(env, user))
      if (url.pathname === '/notion/restore' && request.method === 'POST') return restore(request, env, user)
    }
    return json({ error: 'not found' }, 404)
  },

  // Poll every minute: webhooks alone miss changes.
  async scheduled(_e, env, ctx) {
    for (const user of await accounts(env.NOTION_USER).list()) ctx.waitUntil(poll(env, user).catch((e) =>
      console.log(JSON.stringify({ at: 'notion.poll', error: String(e) }))))
  },
}

// The app sends the integration secret once; the Worker checks it with Notion and keeps it.
async function connect(request, env) {
  const { token } = await request.json().catch(() => ({}))
  if (!looksLikeNotionToken(token)) return json({ error: 'That doesn’t look like a Notion integration secret (it starts with ntn_ or secret_).' }, 400)
  const r = await fetch(`${NOTION}/users/me`, { headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION } })
  if (r.status === 401) return json({ error: 'Notion didn’t accept that secret. Copy it again from notion.so/profile/integrations.' }, 400)
  if (!r.ok) return json({ error: `Notion answered ${r.status}; try again in a minute.` }, 502)
  const me = await r.json()
  const user = me.id
  const workspace = me.bot?.workspace_name || me.name || 'Notion'
  const acct = accounts(env.NOTION_USER)
  // This route needs no sign-in, so cap how many workspaces one deploy will poll: someone who finds the URL can't
  // make your Worker spend its free requests on theirs.
  const known = await acct.list()
  if (!known.includes(user) && known.length >= Number(env.MAX_ACCOUNTS || 3)) {
    return json({ error: 'This Worker already protects as many Notion workspaces as it allows (MAX_ACCOUNTS in wrangler.toml).' }, 403)
  }
  await setState(env, user, { access_token: token, workspace, signInError: null })
  await acct.add(user)
  const app = await makeAppToken(user)
  await acct.setTokenHash(user, app.hash)
  // A first look now, so the journal has a "before" for pages that change next.
  await poll(env, user).catch(() => null)
  return json({ user, workspace, token: app.token })
}

async function webhook(request, env) {
  const body = await request.json().catch(() => ({}))
  // Notion's one-time URL verification handshake.
  if (body.verification_token) return json({ challenge: body.verification_token })
  const user = body.workspace_id || request.headers.get('x-mewndo-user')
  // Only an account that connected through Mewndo; the minute cron covers the rest.
  if (user && (await accounts(env.NOTION_USER).tokenHash(user))) await poll(env, user).catch(() => null)
  return json({ ok: true })
}

async function sync(env, user) {
  try {
    return { ok: true, ...(await poll(env, user)) }
  } catch (e) {
    if (String(e.message).includes(': 401')) {
      await setState(env, user, { signInError: 'Notion no longer accepts the saved secret. Connect Notion again.' })
      return { ok: false, signIn: true, error: 'Notion no longer accepts the saved secret. Connect Notion again.' }
    }
    throw e
  }
}

// Search pages shared with the integration, sorted by last_edited_time, and snapshot what changed. Then check a
// few known pages that dropped out of search: search leaves trashed pages out, so that's how a trash shows up.
async function poll(env, user, { by = null } = {}) {
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  const token = state.access_token
  if (!token) return { journaled: 0 }
  const limiter = new RateLimiter(3) // about 3 requests per second
  const since = state.lastPolled || 0
  const started = Date.now()
  const search = await api(limiter, token, 'search', 'POST', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 25,
  })
  const at = Date.now()
  const entries = []
  const seen = new Set()
  for (const page of search.results || []) {
    seen.add(page.id)
    const edited = Date.parse(page.last_edited_time || 0)
    if (edited <= since - 60_000) break // sorted: everything older is already journaled (a minute of overlap)
    if (entries.length >= PAGES_PER_POLL) break
    const blocks = await api(limiter, token, `blocks/${page.id}/children?page_size=100`, 'GET')
    entries.push({
      id: page.id, at, edited, in_trash: !!page.in_trash || !!page.archived, parent: page.parent,
      title: pageTitle(page), blocks: (blocks.results || []).map(strip), ...(by ? { by } : {}),
    })
  }
  const latest = await stub.fetch('https://do/latest').then((r) => r.json())
  const missing = latest.pages.filter((p) => !p.in_trash && !seen.has(p.id)).slice(0, TRASH_CHECKS_PER_POLL)
  for (const p of missing) {
    const page = await api(limiter, token, `pages/${p.id}`, 'GET').catch((e) => (String(e.message).includes(': 404') ? { gone: true } : null))
    if (page && (page.in_trash || page.archived || page.gone)) {
      const { by: _old, ...last } = p.entry
      entries.push({ ...last, at, edited: Date.parse(page.last_edited_time || 0) || at, in_trash: true, ...(by ? { by } : {}) })
    }
  }
  await stub.fetch('https://do/journal-batch', { method: 'POST', body: JSON.stringify({ entries }) })
  await stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ lastPolled: started, signInError: null }) })
  return { journaled: entries.length }
}

async function status(env, user) {
  const s = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  return { user, workspace: s.workspace ?? null, connected: !!s.access_token, lastSync: s.lastPolled ?? null, signInError: s.signInError ?? null, undoLag: UNDO_LAG_NOTE }
}

async function changes(env, user, url) {
  const since = Number(url.searchParams.get('since') || 0)
  const journal = await userStub(env, user).fetch('https://do/history?since=0').then((r) => r.json())
  return { changes: changeList(journal.entries).filter((c) => c.at >= since).slice(0, 100) }
}

// Restore: untrash first (in_trash:false), then put the content back from the snapshot. Body: { pageIds?, before? }.
async function restore(request, env, user) {
  const { pageIds, before } = await request.json().catch(() => ({}))
  if (pageIds !== undefined && !(Array.isArray(pageIds) && pageIds.every((x) => typeof x === 'string'))) return json({ error: 'bad pageIds' }, 400)
  const t0 = Date.now()
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  const token = state.access_token
  if (!token) return json({ error: 'Notion is not connected.' }, 400)
  const journal = await stub.fetch('https://do/history?since=0').then((r) => r.json())
  const plan = restorePlan(fromBefore(journal.entries, Number(before) || 0), pageIds)
  const limiter = new RateLimiter(3)
  const done = []
  const failed = []
  for (const p of plan) {
    try {
      if (p.untrash) await api(limiter, token, `pages/${p.id}`, 'PATCH', { in_trash: false })
      // Notion has no "replace children": append the snapshot's blocks back, at most 100 per call.
      for (let i = 0; i < (p.restoreBlocks?.length || 0); i += 100) {
        await api(limiter, token, `blocks/${p.id}/children`, 'PATCH', { children: p.restoreBlocks.slice(i, i + 100) })
      }
      done.push({ id: p.id, untrashed: !!p.untrash, blocks_restored: p.restoreBlocks?.length || 0 })
    } catch (e) { failed.push({ id: p.id, why: String(e.message || e).slice(0, 200) }) }
  }
  // Snapshot the restored pages now, marked as Mewndo's own, so the list doesn't show them as an agent's change.
  await poll(env, user, { by: 'mewndo' }).catch(() => null)
  return json({ restored: done, failed, ms: Date.now() - t0, note: UNDO_LAG_NOTE })
}

// Disconnect: forget the secret and the journal here. The integration itself stays in Notion until the user
// removes it (notion.so/profile/integrations); the app says so.
async function disconnect(env, user) {
  const acct = accounts(env.NOTION_USER)
  await acct.forget(user)
  await acct.remove(user)
  return { ok: true }
}

// --- Durable Object: one per account (and the account index) ---
export class NotionUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    const shared = await authRoutes(s, url, request)
    if (shared) return shared
    if (url.pathname === '/state' && request.method === 'POST') {
      const cur = (await s.get('state')) || {}
      await s.put('state', { ...cur, ...(await request.json()) })
      return json({ ok: true })
    }
    if (url.pathname === '/state') return json((await s.get('state')) || {})
    if (url.pathname === '/journal-batch') {
      const { entries } = await request.json()
      const latest = (await s.get('latest')) || {}
      for (const e of entries) {
        await s.put(`p:${e.id}:${e.at}`, e)
        latest[e.id] = { id: e.id, in_trash: e.in_trash, edited: e.edited }
      }
      await s.put('latest', latest)
      return json({ ok: true })
    }
    if (url.pathname === '/latest') {
      // The newest snapshot of each known page, newest-edited first (for the trash check).
      const latest = Object.values((await s.get('latest')) || {}).sort((a, b) => (b.edited || 0) - (a.edited || 0)).slice(0, 50)
      const pages = []
      for (const p of latest) {
        const last = [...(await s.list({ prefix: `p:${p.id}:` })).values()].pop()
        if (last) pages.push({ id: p.id, in_trash: !!last.in_trash, entry: last })
      }
      return json({ pages })
    }
    if (url.pathname === '/history') {
      const since = Number(url.searchParams.get('since') || 0)
      const map = await s.list({ prefix: 'p:' })
      return json({ entries: [...map.values()].filter((e) => e.at >= since) })
    }
    return json({ error: 'not found' }, 404)
  }
}

// --- helpers ---
const userStub = (env, user) => accounts(env.NOTION_USER).stub(`user:${user}`)
const setState = (env, user, patch) => userStub(env, user).fetch('https://do/state', { method: 'POST', body: JSON.stringify(patch) })
async function api(limiter, token, path, method, body, tries = 0) {
  await limiter.wait()
  const r = await fetch(`${NOTION}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 429 && tries < 3) {
    // Respect Notion's own back-off, a few times at most.
    await new Promise((res) => setTimeout(res, Number(r.headers.get('retry-after') || 1) * 1000))
    return api(limiter, token, path, method, body, tries + 1)
  }
  if (!r.ok) throw new Error(`notion ${method} ${path.split('?')[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
// Keep only what can be written back; Notion rejects read-only fields on create.
function strip(block) {
  const { type } = block
  return { object: 'block', type, [type]: block[type] }
}
function pageTitle(page) {
  const props = page.properties || {}
  for (const v of Object.values(props)) {
    if (v?.type === 'title') return (v.title || []).map((t) => t.plain_text).join('')
  }
  return page.id
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
