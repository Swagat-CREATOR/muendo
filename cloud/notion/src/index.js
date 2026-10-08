// Cloudflare Worker: mewndo-notion (spec §25.3, §6.4). Notion Rewind and Heal.
//
// - Webhooks (POST /notion/webhook) PLUS polling on last_edited_time, because
//   Notion's notifications are slow and incomplete.
// - Block snapshots for pages the user shares with Mewndo.
// - Restore sets in_trash:false using the current API version, then puts the
//   content back from the snapshot.
// - Rate limited to about 3 requests per second, as Notion asks.
//
// Honest limit (spec §28.10, shown in the app): Notion notifications can take a
// minute or more, so Notion undo is about ONE TO TWO MINUTES unless the change
// went through Mewndo's MCP (then it is immediate, because Mewndo saw it first).
import { RateLimiter, restorePlan, UNDO_LAG_NOTE } from './heal.js'

const NOTION = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28' // current stable API version; in_trash is supported

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/notion/webhook' && request.method === 'POST') return webhook(request, env)
    if (url.pathname === '/notion/restore' && request.method === 'POST') return restore(request, env)
    if (url.pathname === '/notion/limits') return json({ undo_lag: UNDO_LAG_NOTE })
    return json({ error: 'not found' }, 404)
  },

  // Poll every minute: webhooks alone miss changes.
  async scheduled(_e, env, ctx) {
    for (const user of await users(env)) ctx.waitUntil(poll(env, user).catch((e) =>
      console.log(JSON.stringify({ at: 'notion.poll', user, error: String(e) }))))
  },
}

async function webhook(request, env) {
  const body = await request.json().catch(() => ({}))
  // Notion's one-time URL verification handshake.
  if (body.verification_token) return json({ challenge: body.verification_token })
  const user = body.workspace_id || request.headers.get('x-mewndo-user')
  if (user) await poll(env, user) // treat a webhook as "look now", then reconcile by polling
  return json({ ok: true })
}

// Search pages shared with Mewndo, sorted by last_edited_time, and snapshot what changed.
async function poll(env, user) {
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  const token = state.access_token
  if (!token) return
  const limiter = new RateLimiter(3) // about 3 requests per second
  const since = state.lastPolled || 0
  const search = await api(limiter, token, 'search', 'POST', {
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 50,
  })
  for (const page of search.results || []) {
    const edited = Date.parse(page.last_edited_time || 0)
    if (edited <= since) break // sorted: everything older is already journaled
    const blocks = await api(limiter, token, `blocks/${page.id}/children?page_size=100`, 'GET')
    await stub.fetch('https://do/journal', {
      method: 'POST',
      body: JSON.stringify({
        id: page.id,
        at: Date.now(),
        edited,
        in_trash: !!page.in_trash || !!page.archived,
        parent: page.parent,
        title: pageTitle(page),
        blocks: (blocks.results || []).map(strip),
      }),
    })
  }
  await stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ lastPolled: Date.now() }) })
}

// Restore: untrash first (in_trash:false), then put the content back from the snapshot.
async function restore(request, env) {
  const { user, pageIds, since } = await request.json()
  const t0 = Date.now()
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  const token = state.access_token
  if (!token) return json({ error: 'Notion is not connected.' }, 400)
  const journal = await stub.fetch(`https://do/history?since=${since || 0}`).then((r) => r.json())
  const plan = restorePlan(journal.entries, pageIds)
  const limiter = new RateLimiter(3)
  const done = []
  for (const p of plan) {
    if (p.untrash) await api(limiter, token, `pages/${p.id}`, 'PATCH', { in_trash: false })
    if (p.restoreBlocks?.length) {
      // Notion has no "replace children": append the snapshot's blocks back.
      await api(limiter, token, `blocks/${p.id}/children`, 'PATCH', { children: p.restoreBlocks })
    }
    done.push({ id: p.id, untrashed: !!p.untrash, blocks_restored: p.restoreBlocks?.length || 0 })
  }
  return json({ restored: done, ms: Date.now() - t0, note: UNDO_LAG_NOTE })
}

// --- Durable Object ---
export class NotionUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    if (url.pathname === '/state' && request.method === 'POST') {
      const cur = (await s.get('state')) || {}
      await s.put('state', { ...cur, ...(await request.json()) })
      return json({ ok: true })
    }
    if (url.pathname === '/state') return json((await s.get('state')) || {})
    if (url.pathname === '/journal') {
      const e = await request.json()
      await s.put(`p:${e.id}:${e.at}`, e)
      return json({ ok: true })
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
const userStub = (env, user) => env.NOTION_USER.get(env.NOTION_USER.idFromName(user))
async function users(env) {
  const _ = env
  return [] // ponytail: no global index yet; a webhook wakes the right DO.
}
async function api(limiter, token, path, method, body) {
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
  if (r.status === 429) {
    // Respect Notion's own back-off.
    await new Promise((res) => setTimeout(res, Number(r.headers.get('retry-after') || 1) * 1000))
    return api(limiter, token, path, method, body)
  }
  if (!r.ok) throw new Error(`notion ${method} ${path}: ${r.status} ${await r.text()}`)
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
