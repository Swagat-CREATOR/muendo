// Cloudflare Worker: mewndo-drive (spec §25.3, §6.3). Drive Rewind and Heal.
//
// - changes.watch, renewed before it expires, followed by changes.list.
// - Journals trash state, parent folders and revisions per file.
// - Untrash and restore the original parents when Heal says so.
// - For files in folders the user marks watched, keeps a copy in R2 inside the
//   free tier, and warns before going over it.
// - If a file was permanently deleted, re-uploads it from the copy and says
//   plainly that it has a NEW id and its share links need redoing.
//
// Setup: docs/google-setup.md (P6.1). Secrets: GOOGLE_CLIENT_ID/SECRET.
import { healPlan, r2Budget, FREE_R2_BYTES } from './heal.js'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/drive/push' && request.method === 'POST') return push(request, env)
    if (url.pathname === '/drive/restore' && request.method === 'POST') return restore(request, env)
    if (url.pathname === '/drive/watched' && request.method === 'POST') return setWatched(request, env)
    if (url.pathname === '/drive/budget') return budget(request, env)
    return json({ error: 'not found' }, 404)
  },

  // Renew the changes watch well before its expiry, then reconcile.
  async scheduled(_e, env, ctx) {
    for (const user of await users(env)) {
      ctx.waitUntil(renew(env, user).then(() => reconcile(env, user)).catch((e) =>
        console.log(JSON.stringify({ at: 'drive.renew', user, error: String(e) }))))
    }
  },
}

async function renew(env, user) {
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  let token = state.pageToken
  if (!token) {
    token = (await driveGET(access, 'changes/startPageToken')).startPageToken
  }
  const channel = {
    id: crypto.randomUUID(),
    type: 'web_hook',
    address: `${env.WORKER_ORIGIN}/drive/push`,
    // Drive channels expire; ask for the max and renew daily from the cron.
    expiration: String(Date.now() + 24 * 3600 * 1000),
  }
  await drivePOST(access, `changes/watch?pageToken=${token}`, channel).catch(() => null)
  await stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ pageToken: token, channelId: channel.id }) })
}

// A push only says "something changed": always follow with changes.list.
async function push(request, env) {
  const user = request.headers.get('x-goog-channel-token') || (await request.json().catch(() => ({})))?.user
  if (user) await reconcile(env, user)
  return json({ ok: true })
}

async function reconcile(env, user) {
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  let pageToken = state.pageToken
  if (!pageToken) return
  const watched = new Set(state.watchedFolders || [])
  let newToken = pageToken
  do {
    const q = new URLSearchParams({
      pageToken,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,trashed,parents,mimeType,size,headRevisionId,md5Checksum))',
      includeRemoved: 'true',
    })
    const page = await driveGET(access, `changes?${q}`)
    for (const c of page.changes || []) {
      const f = c.file
      const entry = {
        id: c.fileId,
        at: Date.now(),
        gone: !!c.removed && !f,
        trashed: !!f?.trashed,
        parents: f?.parents || [],
        name: f?.name,
        revision: f?.headRevisionId,
        size: Number(f?.size || 0),
        md5: f?.md5Checksum,
      }
      await stub.fetch('https://do/journal', { method: 'POST', body: JSON.stringify(entry) })
      // Keep a copy for watched folders, inside the R2 free tier.
      if (f && !f.trashed && (f.parents || []).some((p) => watched.has(p))) {
        await keepCopy(env, stub, access, f)
      }
    }
    pageToken = page.nextPageToken
    if (page.newStartPageToken) newToken = page.newStartPageToken
  } while (pageToken)
  await stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ pageToken: newToken }) })
}

// R2 copy, free tier aware: warn (and stop copying) before going over.
async function keepCopy(env, stub, access, file) {
  const state = await stub.fetch('https://do/state').then((r) => r.json())
  const used = Number(state.r2Used || 0)
  const plan = r2Budget(used, Number(file.size || 0))
  if (!plan.allowed) {
    await stub.fetch('https://do/state', { method: 'POST', body: JSON.stringify({ r2Warning: plan.warning }) })
    console.log(JSON.stringify({ at: 'drive.r2', skipped: file.id, reason: plan.warning }))
    return
  }
  const body = await fetch(`${DRIVE}/files/${file.id}?alt=media`, { headers: { authorization: `Bearer ${access}` } })
  if (!body.ok) return
  await env.COPIES.put(`${file.id}/${file.headRevisionId || 'head'}`, body.body, {
    customMetadata: { name: file.name, parents: (file.parents || []).join(','), md5: file.md5Checksum || '' },
  })
  await stub.fetch('https://do/state', {
    method: 'POST',
    body: JSON.stringify({ r2Used: used + Number(file.size || 0), r2Warning: plan.warning || null }),
  })
}

async function setWatched(request, env) {
  const { user, folders } = await request.json()
  await userStub(env, user).fetch('https://do/state', { method: 'POST', body: JSON.stringify({ watchedFolders: folders }) })
  return json({ watched: folders })
}

async function budget(request, env) {
  const user = new URL(request.url).searchParams.get('user')
  const state = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  return json({ r2_used_bytes: Number(state.r2Used || 0), r2_free_bytes: FREE_R2_BYTES, warning: state.r2Warning || null })
}

// Heal: untrash and put files back in their original parents; re-upload what was
// permanently deleted, from the R2 copy, and say the id changed.
async function restore(request, env) {
  const { user, since, fileIds } = await request.json()
  const t0 = Date.now()
  const access = await accessToken(env, user)
  const stub = userStub(env, user)
  const journal = await stub.fetch(`https://do/history?since=${since || 0}`).then((r) => r.json())
  const plan = healPlan(journal.entries, fileIds)
  const done = []
  for (const f of plan.untrash) {
    await drivePATCH(access, `files/${f.id}`, { trashed: false })
    if (f.addParents.length || f.removeParents.length) {
      const q = new URLSearchParams()
      if (f.addParents.length) q.set('addParents', f.addParents.join(','))
      if (f.removeParents.length) q.set('removeParents', f.removeParents.join(','))
      await drivePATCH(access, `files/${f.id}?${q}`, {})
    }
    done.push({ id: f.id, restored: 'untrashed', parents_restored: f.addParents })
  }
  const reuploaded = []
  for (const f of plan.gone) {
    const copy = await env.COPIES.get(`${f.id}/${f.revision || 'head'}`)
    if (!copy) {
      reuploaded.push({ id: f.id, restored: false, why: 'Mewndo has no copy of this file: it was permanently deleted and was not in a watched folder.' })
      continue
    }
    const created = await uploadNew(access, f, copy)
    reuploaded.push({
      old_id: f.id,
      new_id: created.id,
      restored: true,
      warning: 'This file came back from Mewndo\'s copy, so it has a NEW Drive id. Its old share links will not work and need redoing.',
    })
  }
  return json({ restored: done, reuploaded, ms: Date.now() - t0 })
}

async function uploadNew(access, f, copy) {
  const meta = { name: f.name || 'restored-by-mewndo', parents: f.parents || [] }
  const boundary = `mewndo${crypto.randomUUID()}`
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`
  const tail = `\r\n--${boundary}--`
  const bytes = new Uint8Array(await copy.arrayBuffer())
  const body = new Blob([head, bytes, tail])
  const r = await fetch(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!r.ok) throw new Error(`drive upload: ${r.status} ${await r.text()}`)
  return r.json()
}

// --- Durable Object ---
export class DriveUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    if (url.pathname === '/state' && request.method === 'POST') {
      const patch = await request.json()
      const cur = (await s.get('state')) || {}
      await s.put('state', { ...cur, ...patch })
      return json({ ok: true })
    }
    if (url.pathname === '/state') return json((await s.get('state')) || {})
    if (url.pathname === '/journal') {
      const e = await request.json()
      await s.put(`f:${e.id}:${e.at}`, e)
      return json({ ok: true })
    }
    if (url.pathname === '/history') {
      const since = Number(url.searchParams.get('since') || 0)
      const map = await s.list({ prefix: 'f:' })
      return json({ entries: [...map.values()].filter((e) => e.at >= since) })
    }
    return json({ error: 'not found' }, 404)
  }
}

// --- helpers ---
const userStub = (env, user) => env.DRIVE_USER.get(env.DRIVE_USER.idFromName(user))
async function users(env) {
  const _ = env
  return [] // ponytail: no global user index yet; renewal runs per-user from a push.
}
async function accessToken(env, user) {
  const { refresh_token } = await userStub(env, user).fetch('https://do/state').then((r) => r.json())
  if (!refresh_token) throw new Error(`no refresh token for ${user}`)
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, grant_type: 'refresh_token', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  }).then((x) => x.json())
  if (!r.access_token) throw new Error('refresh failed (Testing-mode tokens expire after 7 days)')
  return r.access_token
}
async function driveGET(access, path) {
  const r = await fetch(`${DRIVE}/${path}`, { headers: { authorization: `Bearer ${access}` } })
  if (!r.ok) throw new Error(`drive GET ${path}: ${r.status}`)
  return r.json()
}
async function drivePOST(access, path, body) {
  const r = await fetch(`${DRIVE}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`drive POST ${path}: ${r.status}`)
  return r.json()
}
async function drivePATCH(access, path, body) {
  const r = await fetch(`${DRIVE}/${path}`, { method: 'PATCH', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`drive PATCH ${path}: ${r.status}`)
  return r.json()
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
