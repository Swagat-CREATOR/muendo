// Cloudflare Worker: mewndo-drive (spec §25.3, §6.3). Drive Rewind and Heal.
//
// - changes.watch, renewed before it expires, followed by changes.list. The app also
//   asks for a reconcile (POST /app/sync) every few minutes.
// - Journals trash state, parent folders, name and revision per file.
// - Untrash, put back the original parents and the old name when Heal says so.
// - Optionally (an R2 bucket bound as COPIES), keeps a copy of files in folders the
//   user marks watched, inside R2's free 10 GB, and warns before going over it.
// - If a file was permanently deleted, re-uploads it from that copy and says
//   plainly that it has a NEW id and its share links need redoing.
//
// The app talks to it with an app token (src/app-auth.js); the account comes from
// the token, never from the request body.
//
// Setup: docs/connections-setup.md, docs/google-setup.md. Secrets: GOOGLE_CLIENT_ID/SECRET.
import { healPlan, r2Budget, FREE_R2_BYTES, fromBefore, inferBefore, changeList } from './heal.js'
import { accounts, accountFrom, authRoutes, makeAppToken, isClaimHash, isClaimSecret, sha256hex, donePage } from './app-auth.js'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const SCOPE = 'https://www.googleapis.com/auth/drive'
const APP_ROUTES = new Set(['/app/status', '/app/sync', '/app/changes', '/app/disconnect', '/drive/restore', '/drive/watched', '/drive/budget'])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/oauth/start') return oauthStart(env, url)
    if (url.pathname === '/oauth/callback') return oauthCallback(env, url)
    if (url.pathname === '/oauth/claim' && request.method === 'POST') return oauthClaim(request, env)
    if (url.pathname === '/drive/push' && request.method === 'POST') return push(request, env)
    if (APP_ROUTES.has(url.pathname)) {
      const user = await accountFrom(request, (a) => accounts(env.DRIVE_USER).tokenHash(a))
      if (!user) return json({ error: 'Mewndo isn’t signed in to this Drive Worker. Connect Google Drive again in Mewndo.' }, 401)
      if (url.pathname === '/app/status') return json(await status(env, user))
      if (url.pathname === '/app/sync' && request.method === 'POST') return json(await sync(env, user))
      if (url.pathname === '/app/changes') return json(await changes(env, user, url))
      if (url.pathname === '/app/disconnect' && request.method === 'POST') return json(await disconnect(env, user))
      if (url.pathname === '/drive/restore' && request.method === 'POST') return restore(request, env, user)
      if (url.pathname === '/drive/watched' && request.method === 'POST') return setWatched(request, env, user)
      if (url.pathname === '/drive/budget') return budget(env, user)
    }
    return json({ error: 'not found' }, 404)
  },

  // Renew the changes watch well before its expiry, then reconcile.
  async scheduled(_e, env, ctx) {
    for (const user of await accounts(env.DRIVE_USER).list()) {
      ctx.waitUntil(renew(env, user).then(() => reconcile(env, user)).catch((e) =>
        console.log(JSON.stringify({ at: 'drive.renew', error: String(e) }))))
    }
  },
}

// --- Signing in (Testing mode: refresh tokens expire after 7 days) ---
function oauthStart(env, url) {
  const claim = url.searchParams.get('claim')
  if (!isClaimHash(claim)) return json({ error: 'missing claim' }, 400)
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return donePage('Google Drive', null, 'This Worker has no Google client yet: run `npx wrangler@3 secret put GOOGLE_CLIENT_ID` and GOOGLE_CLIENT_SECRET in cloud/drive (docs/connections-setup.md).')
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
  if (url.searchParams.get('error')) return donePage('Google Drive', null, `Google said: ${url.searchParams.get('error')}.`)
  if (!code) return donePage('Google Drive', null, 'Google sent no sign-in code.')
  const token = await postForm('https://oauth2.googleapis.com/token', {
    code, redirect_uri: `${url.origin}/oauth/callback`, grant_type: 'authorization_code',
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
  })
  if (!token.refresh_token) return donePage('Google Drive', null, 'Google gave no refresh token. Remove Mewndo at myaccount.google.com/permissions and connect again.')
  if (!String(token.scope || '').split(' ').includes(SCOPE)) return donePage('Google Drive', null, 'Mewndo needs the "see, edit, create and delete all of your Google Drive files" permission to put files back. Connect again and leave it ticked.')
  const about = await driveGET(token.access_token, 'about?fields=user(emailAddress)')
  const user = about.user.emailAddress
  const acct = accounts(env.DRIVE_USER)
  // The Worker's own address, for the Drive watch callback (no need to edit wrangler.toml).
  await setState(env, user, { refresh_token: token.refresh_token, origin: url.origin, signInError: null })
  await acct.add(user)
  await renew(env, user).catch((e) => setState(env, user, { watchError: String(e.message || e) }))
  if (isClaimHash(claim)) {
    const app = await makeAppToken(user)
    await acct.setTokenHash(user, app.hash)
    await acct.park(claim, { user, token: app.token })
  }
  return donePage('Google Drive', user)
}

async function oauthClaim(request, env) {
  const { claim } = await request.json().catch(() => ({}))
  if (!isClaimSecret(claim)) return json({ error: 'bad claim' }, 400)
  const got = await accounts(env.DRIVE_USER).take(await sha256hex(claim))
  return got ? json({ user: got.user, token: got.token }) : json({ pending: true }, 404)
}

async function renew(env, user) {
  const access = await accessToken(env, user)
  const state = await getState(env, user)
  let token = state.pageToken
  if (!token) token = (await driveGET(access, 'changes/startPageToken')).startPageToken
  const origin = state.origin || env.WORKER_ORIGIN
  // Stop the previous channel so pushes don't arrive twice.
  if (state.channelId && state.resourceId) {
    await drivePOST(access, 'channels/stop', { id: state.channelId, resourceId: state.resourceId }).catch(() => null)
  }
  const channel = {
    id: crypto.randomUUID(),
    type: 'web_hook',
    address: `${origin}/drive/push`,
    token: user, // comes back as x-goog-channel-token, so the push names the account
    // Drive channels expire; ask for a day and renew daily from the cron.
    expiration: String(Date.now() + 24 * 3600 * 1000),
  }
  const res = await drivePOST(access, `changes/watch?pageToken=${token}`, channel).catch((e) => ({ error: String(e.message || e) }))
  await setState(env, user, {
    pageToken: token, channelId: res.error ? null : channel.id, resourceId: res.resourceId ?? null,
    watchExpiration: res.error ? null : Number(res.expiration || channel.expiration), watchError: res.error ?? null,
  })
}

// A push only says "something changed": always follow with changes.list.
async function push(request, env) {
  const user = request.headers.get('x-goog-channel-token')
  if (user && (await accounts(env.DRIVE_USER).tokenHash(user))) await reconcile(env, user).catch(() => null)
  return json({ ok: true })
}

async function sync(env, user) {
  const state = await getState(env, user)
  try {
    if (!state.watchExpiration || state.watchExpiration - Date.now() < 3600_000) await renew(env, user)
    return { ok: true, ...(await reconcile(env, user)) }
  } catch (e) {
    if (e instanceof SignInError) { await setState(env, user, { signInError: e.message }); return { ok: false, signIn: true, error: e.message } }
    throw e
  }
}

async function reconcile(env, user, { by = null } = {}) {
  const access = await accessToken(env, user)
  const state = await getState(env, user)
  let pageToken = state.pageToken
  if (!pageToken) return { journaled: 0 }
  const watched = new Set(state.watchedFolders || [])
  let newToken = pageToken
  const at = Date.now()
  const entries = []
  const toCopy = []
  do {
    const q = new URLSearchParams({
      pageToken,
      fields: 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,trashed,parents,mimeType,size,headRevisionId,md5Checksum))',
      includeRemoved: 'true',
      pageSize: '1000',
    })
    const page = await driveGET(access, `changes?${q}`)
    for (const c of page.changes || []) {
      const f = c.file
      entries.push({
        id: c.fileId,
        at,
        gone: !!c.removed && !f,
        trashed: !!f?.trashed,
        parents: f?.parents || [],
        name: f?.name,
        revision: f?.headRevisionId,
        size: Number(f?.size || 0),
        md5: f?.md5Checksum,
        ...(by ? { by } : {}),
      })
      if (f && !f.trashed && (f.parents || []).some((p) => watched.has(p))) toCopy.push(f)
    }
    pageToken = page.nextPageToken
    if (page.newStartPageToken) newToken = page.newStartPageToken
  } while (pageToken)
  // One call to the Durable Object for the whole batch (the free plan allows 50 subrequests per run).
  await userStub(env, user).fetch('https://do/journal-batch', { method: 'POST', body: JSON.stringify({ entries }) })
  // Keep copies for watched folders, a few per run, inside the R2 free tier (only if R2 is bound).
  for (const f of toCopy.slice(0, 5)) await keepCopy(env, user, access, f)
  await setState(env, user, { pageToken: newToken, lastSync: Date.now(), signInError: null, copiesPending: Math.max(0, toCopy.length - 5) })
  return { journaled: entries.length }
}

// R2 copy, free tier aware: warn (and stop copying) before going over. Off without an R2 binding.
async function keepCopy(env, user, access, file) {
  if (!env.COPIES) return
  const state = await getState(env, user)
  const used = Number(state.r2Used || 0)
  const plan = r2Budget(used, Number(file.size || 0))
  if (!plan.allowed) {
    await setState(env, user, { r2Warning: plan.warning })
    console.log(JSON.stringify({ at: 'drive.r2', skipped: file.id, reason: plan.warning }))
    return
  }
  const body = await fetch(`${DRIVE}/files/${file.id}?alt=media`, { headers: { authorization: `Bearer ${access}` } })
  if (!body.ok) return
  await env.COPIES.put(`${file.id}/${file.headRevisionId || 'head'}`, body.body, {
    customMetadata: { name: file.name, parents: (file.parents || []).join(','), md5: file.md5Checksum || '' },
  })
  await setState(env, user, { r2Used: used + Number(file.size || 0), r2Warning: plan.warning || null })
}

async function setWatched(request, env, user) {
  const { folders } = await request.json().catch(() => ({}))
  if (!Array.isArray(folders) || !folders.every((f) => typeof f === 'string' && f.length < 200) || folders.length > 50) return json({ error: 'bad folders' }, 400)
  await setState(env, user, { watchedFolders: folders })
  return json({ watched: folders, copies: !!env.COPIES })
}

async function budget(env, user) {
  const state = await getState(env, user)
  return json({ copies: !!env.COPIES, r2_used_bytes: Number(state.r2Used || 0), r2_free_bytes: FREE_R2_BYTES, warning: state.r2Warning || null })
}

async function status(env, user) {
  const s = await getState(env, user)
  return {
    user, connected: !!s.refresh_token, lastSync: s.lastSync ?? null, watchExpiration: s.watchExpiration ?? null,
    pushOn: !!s.watchExpiration && s.watchExpiration > Date.now(), watchError: s.watchError ?? null,
    signInError: s.signInError ?? null, copies: !!env.COPIES, watchedFolders: s.watchedFolders ?? [],
    r2Warning: s.r2Warning ?? null,
  }
}

// The journal as changes, newest first. A permanent delete is undoable only if R2 holds a copy.
async function changes(env, user, url) {
  const since = Number(url.searchParams.get('since') || 0)
  const journal = await userStub(env, user).fetch('https://do/history?since=0').then((r) => r.json())
  const list = changeList(journal.entries).filter((c) => c.at >= since).slice(0, 100)
  if (env.COPIES) {
    const revisions = new Map()
    for (const e of journal.entries) if (e.revision) revisions.set(e.id, e.revision)
    for (const c of list.filter((x) => x.needsCopy).slice(0, 20)) {
      if (await env.COPIES.head(`${c.id}/${revisions.get(c.id) || 'head'}`)) {
        c.undoable = true
        c.why = 'Comes back from Mewndo’s copy as a NEW file with a new id: old share links stop working.'
      }
    }
  }
  return { changes: list }
}

// Heal: untrash and put files back in their original parents and names; re-upload what was permanently deleted,
// from the R2 copy, and say the id changed. Body: { fileIds?, before? }.
async function restore(request, env, user) {
  const { fileIds, before } = await request.json().catch(() => ({}))
  if (fileIds !== undefined && !(Array.isArray(fileIds) && fileIds.every((x) => typeof x === 'string'))) return json({ error: 'bad fileIds' }, 400)
  const t0 = Date.now()
  const access = await accessToken(env, user)
  await reconcile(env, user).catch(() => null) // catch up first, so the next reconcile holds only Mewndo's own changes
  const journal = await userStub(env, user).fetch('https://do/history?since=0').then((r) => r.json())
  const plan = healPlan(fromBefore(journal.entries, Number(before) || 0), fileIds)
  const done = []
  const failed = []
  for (const f of plan.untrash) {
    try {
      await drivePATCH(access, `files/${f.id}`, { trashed: false })
      if (f.addParents.length || f.removeParents.length) {
        const q = new URLSearchParams()
        if (f.addParents.length) q.set('addParents', f.addParents.join(','))
        if (f.removeParents.length) q.set('removeParents', f.removeParents.join(','))
        await drivePATCH(access, `files/${f.id}?${q}`, {})
      }
      done.push({ id: f.id, restored: 'untrashed', parents_restored: f.addParents })
    } catch (e) { failed.push({ id: f.id, why: String(e.message || e) }) }
  }
  for (const r of plan.rename) {
    try {
      await drivePATCH(access, `files/${r.id}`, { name: r.name })
      done.push({ id: r.id, restored: 'renamed', name: r.name })
    } catch (e) { failed.push({ id: r.id, why: String(e.message || e) }) }
  }
  const reuploaded = []
  for (const f of plan.gone) {
    const copy = env.COPIES ? await env.COPIES.get(`${f.id}/${f.revision || 'head'}`) : null
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
  await reconcile(env, user, { by: 'mewndo' }).catch(() => null)
  return json({ restored: done, failed, reuploaded, ms: Date.now() - t0 })
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

// Disconnect: stop the watch, revoke Google's grant, and forget this account here (journal included). R2 copies
// stay in the user's own bucket (Mewndo never deletes them on its own); docs/connections-setup.md says how.
async function disconnect(env, user) {
  const s = await getState(env, user)
  if (s.refresh_token) {
    const access = await accessToken(env, user).catch(() => null)
    if (access && s.channelId && s.resourceId) await drivePOST(access, 'channels/stop', { id: s.channelId, resourceId: s.resourceId }).catch(() => null)
    await postForm('https://oauth2.googleapis.com/revoke', { token: s.refresh_token }).catch(() => null)
  }
  const acct = accounts(env.DRIVE_USER)
  await acct.forget(user)
  await acct.remove(user)
  return { ok: true }
}

// --- Durable Object: one per account (and one per sign-in claim, and the account index) ---
export class DriveUser {
  constructor(state) { this.state = state }
  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    const shared = await authRoutes(s, url, request)
    if (shared) return shared
    if (url.pathname === '/state' && request.method === 'POST') {
      const patch = await request.json()
      const cur = (await s.get('state')) || {}
      await s.put('state', { ...cur, ...patch })
      return json({ ok: true })
    }
    if (url.pathname === '/state') return json((await s.get('state')) || {})
    if (url.pathname === '/journal-batch') {
      // A file seen for the first time in the trash also gets its state before (same folders, not trashed), so the
      // first change Mewndo sees can be undone.
      const { entries } = await request.json()
      for (const e of entries) {
        const known = (await s.list({ prefix: `f:${e.id}:`, limit: 1 })).size > 0
        const before = known ? null : inferBefore(e)
        if (before) await s.put(`f:${e.id}:${e.at - 1}`, { ...before, at: e.at - 1 })
        await s.put(`f:${e.id}:${e.at}`, e)
      }
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
class SignInError extends Error {}
const userStub = (env, user) => accounts(env.DRIVE_USER).stub(`user:${user}`)
const getState = (env, user) => userStub(env, user).fetch('https://do/state').then((r) => r.json())
const setState = (env, user, patch) => userStub(env, user).fetch('https://do/state', { method: 'POST', body: JSON.stringify(patch) })
async function accessToken(env, user) {
  const { refresh_token } = await getState(env, user)
  if (!refresh_token) throw new SignInError('no saved sign-in for this account (connect again)')
  const r = await postForm('https://oauth2.googleapis.com/token', { refresh_token, grant_type: 'refresh_token', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET })
  if (!r.access_token) throw new SignInError('Google refused the saved sign-in. In Testing mode it lasts 7 days: connect Google Drive again.')
  return r.access_token
}
async function postForm(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  return r.json().catch(() => ({}))
}
async function driveGET(access, path) {
  const r = await fetch(`${DRIVE}/${path}`, { headers: { authorization: `Bearer ${access}` } })
  if (!r.ok) throw new Error(`drive GET ${path.split('?')[0]}: ${r.status}`)
  return r.json()
}
async function drivePOST(access, path, body) {
  const r = await fetch(`${DRIVE}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`drive POST ${path.split('?')[0]}: ${r.status}`)
  return r.status === 204 ? {} : r.json().catch(() => ({}))
}
async function drivePATCH(access, path, body) {
  const r = await fetch(`${DRIVE}/${path}`, { method: 'PATCH', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`drive PATCH ${path.split('?')[0]}: ${r.status}`)
  return r.json()
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
