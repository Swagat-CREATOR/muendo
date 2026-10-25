'use strict'
// How the Mewndo app proves to this Worker which account it speaks for (docs/connections-setup.md).
// The same file is in cloud/gmail, cloud/drive and cloud/notion; a test keeps the copies identical.
//
// - Signing in: the app makes a random claim secret and opens <worker>/oauth/start?claim=<sha256(secret)>. After the
//   provider's callback the Worker parks { user, token } under that hash for 10 minutes, and the app collects it
//   once with POST /oauth/claim { claim: secret }. Only the app knows the secret, so a page that sees the hash in
//   the browser's address bar can't collect the token. No listener on the user's PC is needed.
// - The app token: "mw1.<base64url(account)>.<secret>". The Worker keeps only sha256(secret), in that account's
//   Durable Object; the app keeps the token in Windows Credential Manager. Every /app/* and restore route needs it,
//   and the account comes from the token, never from the request body.
// Web Crypto only, so this runs in Workers and in Node 22 (tests) alike.

export const CLAIM_TTL_MS = 10 * 60_000

const enc = new TextEncoder()
const dec = new TextDecoder()

export function b64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromB64url(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export function newSecret() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const isClaimHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
export const isClaimSecret = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(s)

// A new app token for an account, and the hash the Worker keeps.
export async function makeAppToken(account) {
  const secret = newSecret()
  return { token: `mw1.${b64url(enc.encode(account))}.${secret}`, hash: await sha256hex(secret) }
}

// { account, secret } from "Bearer mw1...." or null.
export function parseAppToken(header) {
  const m = /^Bearer (mw1)\.([A-Za-z0-9_-]{1,700})\.([A-Za-z0-9_-]{32,128})$/.exec(String(header ?? '').trim())
  if (!m) return null
  try {
    const account = dec.decode(fromB64url(m[2]))
    return account ? { account, secret: m[3] } : null
  } catch {
    return null
  }
}

// The account the request speaks for, or null. storedHash(account) reads that account's Durable Object.
export async function accountFrom(request, storedHash) {
  const t = parseAppToken(request.headers.get('authorization'))
  if (!t) return null
  const want = await storedHash(t.account)
  if (!want) return null
  return sameText(await sha256hex(t.secret), want) ? t.account : null
}

// Compare without stopping at the first difference.
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// The page the browser lands on after signing in. Never shows the token.
export function donePage(service, account, error) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const body = error
    ? `<h1>${esc(service)} wasn't connected</h1><p>${esc(error)}</p><p>Go back to Mewndo and try Connect again.</p>`
    : `<h1>${esc(service)} is connected</h1><p>${esc(account)} is now protected by Mewndo. You can close this tab and go back to Mewndo.</p>`
  return new Response(`<!doctype html><meta charset="utf-8"><title>Mewndo</title><body style="font:16px system-ui;margin:48px">${body}`, {
    status: error ? 400 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

// Routes that every account Durable Object answers, for tokens, claims and the account index.
// Returns a Response, or null when the path isn't one of these.
export async function authRoutes(storage, url, request) {
  if (url.pathname === '/app-token' && request.method === 'POST') {
    const b = await request.json()
    await storage.put('appTokenHash', b.hash)
    return Response.json({ ok: true })
  }
  if (url.pathname === '/app-token') return Response.json({ hash: (await storage.get('appTokenHash')) ?? null })
  if (url.pathname === '/claim' && request.method === 'POST') {
    await storage.put('claim', await request.json())
    return Response.json({ ok: true })
  }
  if (url.pathname === '/claim/take') {
    const c = await storage.get('claim')
    await storage.delete('claim')
    return Response.json(c && c.exp > Date.now() ? c : null)
  }
  if (url.pathname === '/index/add') {
    const { account } = await request.json()
    const all = new Set((await storage.get('accounts')) ?? [])
    all.add(account)
    await storage.put('accounts', [...all])
    return Response.json({ ok: true })
  }
  if (url.pathname === '/index/remove') {
    const { account } = await request.json()
    await storage.put('accounts', ((await storage.get('accounts')) ?? []).filter((a) => a !== account))
    return Response.json({ ok: true })
  }
  if (url.pathname === '/index') return Response.json({ accounts: (await storage.get('accounts')) ?? [] })
  if (url.pathname === '/forget' && request.method === 'POST') {
    await storage.deleteAll()
    return Response.json({ ok: true })
  }
  return null
}

// Helpers over a Durable Object namespace: one object per account, one per claim, and one index.
export function accounts(ns) {
  const stub = (name) => ns.get(ns.idFromName(name))
  const post = (name, path, body) => stub(name).fetch(`https://do${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }).then((r) => r.json())
  const get = (name, path) => stub(name).fetch(`https://do${path}`).then((r) => r.json())
  return {
    stub,
    tokenHash: async (account) => (await get(`user:${account}`, '/app-token')).hash,
    setTokenHash: (account, hash) => post(`user:${account}`, '/app-token', { hash }),
    park: (claimHash, value) => post(`claim:${claimHash}`, '/claim', { ...value, exp: Date.now() + CLAIM_TTL_MS }),
    take: (claimHash) => get(`claim:${claimHash}`, '/claim/take'),
    add: (account) => post('__index__', '/index/add', { account }),
    remove: (account) => post('__index__', '/index/remove', { account }),
    list: async () => (await get('__index__', '/index')).accounts,
    forget: (account) => post(`user:${account}`, '/forget'),
  }
}
