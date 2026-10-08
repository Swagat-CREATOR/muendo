'use strict'
// OAuth 2.1 for the hosted MCP server (spec §22.3): discovery metadata, Dynamic
// Client Registration (RFC 7591), authorization code + PKCE, refresh tokens via
// offline_access, short-lived access tokens, and per-tool scopes.
//
// Tokens are random opaque strings hashed before storage, kept in a Durable Object
// (OAUTH). Nothing secret is written to this repo.
import { ALL_SCOPES } from './tools.js'

const ACCESS_TTL = 3600 // 1 hour: short-lived, as §22.3 asks
const CODE_TTL = 600

export async function oauthRoutes(request, env, url) {
  const p = url.pathname
  if (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/oauth-protected-resource') {
    return json(metadata(url.origin))
  }
  if (p === '/oauth/register' && request.method === 'POST') return register(request, env)
  if (p === '/oauth/authorize') return authorize(request, env, url)
  if (p === '/oauth/token' && request.method === 'POST') return token(request, env)
  return null
}

function metadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    resource: `${origin}/mcp`,
    scopes_supported: ALL_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  }
}

// Dynamic Client Registration: any MCP client (Claude, Codex, ChatGPT) can register itself.
async function register(request, env) {
  const body = await request.json().catch(() => ({}))
  const client_id = `mcp_${rand(16)}`
  const record = {
    client_id,
    client_name: body.client_name || 'unknown MCP client',
    redirect_uris: body.redirect_uris || [],
    scope: body.scope || 'mewndo.read offline_access',
    created: Date.now(),
  }
  await oauthStore(env).fetch('https://do/client', { method: 'POST', body: JSON.stringify(record) })
  return json({ ...record, token_endpoint_auth_method: 'none' }, 201)
}

// The user approves in a browser. A real deployment shows Mewndo's own consent page
// and signs the user in; here the page states exactly which scopes are being granted
// and to whom, and the user clicks Approve (POST back to the same URL).
async function authorize(request, env, url) {
  const q = url.searchParams
  const client_id = q.get('client_id')
  const redirect_uri = q.get('redirect_uri')
  const state = q.get('state') || ''
  const challenge = q.get('code_challenge')
  const scope = q.get('scope') || 'mewndo.read offline_access'
  if (!client_id || !redirect_uri) return json({ error: 'invalid_request' }, 400)
  const store = oauthStore(env)
  const client = await store.fetch(`https://do/client?id=${client_id}`).then((r) => r.json())
  if (!client?.client_id) return json({ error: 'invalid_client' }, 400)
  if (client.redirect_uris.length && !client.redirect_uris.includes(redirect_uri)) {
    return json({ error: 'invalid_redirect_uri' }, 400)
  }
  // Scopes a client may ask for are limited to what it registered with.
  const granted = scope.split(/\s+/).filter((s) => client.scope.split(/\s+/).includes(s))

  if (request.method === 'POST') {
    const user = (await request.formData()).get('user') // Mewndo account id; a real deploy signs in
    if (!user) return json({ error: 'sign-in required' }, 400)
    const code = rand(32)
    await store.fetch('https://do/code', {
      method: 'POST',
      body: JSON.stringify({ code: await sha256(code), client_id, user, scope: granted.join(' '), challenge, expires: Date.now() + CODE_TTL * 1000 }),
    })
    const to = new URL(redirect_uri)
    to.searchParams.set('code', code)
    if (state) to.searchParams.set('state', state)
    return Response.redirect(to.toString(), 302)
  }

  return html(consentPage(client, granted, url))
}

async function token(request, env) {
  const form = await request.formData()
  const grant = form.get('grant_type')
  const store = oauthStore(env)
  if (grant === 'authorization_code') {
    const code = form.get('code')
    const verifier = form.get('code_verifier')
    const rec = await store.fetch(`https://do/code?hash=${await sha256(code)}`).then((r) => r.json())
    if (!rec?.user || rec.expires < Date.now()) return json({ error: 'invalid_grant' }, 400)
    if (rec.challenge) {
      const expect = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier || '')))
      if (expect !== rec.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE check failed' }, 400)
    }
    return json(await issue(store, rec.client_id, rec.user, rec.scope))
  }
  if (grant === 'refresh_token') {
    const rt = form.get('refresh_token')
    const rec = await store.fetch(`https://do/refresh?hash=${await sha256(rt)}`).then((r) => r.json())
    if (!rec?.user) return json({ error: 'invalid_grant' }, 400)
    return json(await issue(store, rec.client_id, rec.user, rec.scope))
  }
  return json({ error: 'unsupported_grant_type' }, 400)
}

async function issue(store, client_id, user, scope) {
  const access = rand(32)
  const out = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope }
  await store.fetch('https://do/access', {
    method: 'POST',
    body: JSON.stringify({ hash: await sha256(access), client_id, user, scope, expires: Date.now() + ACCESS_TTL * 1000 }),
  })
  // offline_access: give a refresh token so the client can stay connected (ChatGPT asks for it).
  if (scope.split(/\s+/).includes('offline_access')) {
    const refresh = rand(32)
    out.refresh_token = refresh
    await store.fetch('https://do/refresh', {
      method: 'POST',
      body: JSON.stringify({ hash: await sha256(refresh), client_id, user, scope }),
    })
  }
  return out
}

/// Check the bearer token on an MCP request. `need` null: any valid token.
export async function requireScope(request, env, need) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const unauthorized = (msg) =>
    new Response(JSON.stringify({ error: 'unauthorized', error_description: msg }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        // Tells the client where to start OAuth (RFC 9728).
        'www-authenticate': `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"`,
      },
    })
  if (!token) return { error: true, response: unauthorized('a bearer token is required') }
  const rec = await oauthStore(env)
    .fetch(`https://do/access?hash=${await sha256(token)}`)
    .then((r) => r.json())
  if (!rec?.user || rec.expires < Date.now()) return { error: true, response: unauthorized('token unknown or expired') }
  const scopes = (rec.scope || '').split(/\s+/).filter(Boolean)
  if (need && !scopes.includes(need)) return { error: true, response: unauthorized(`the ${need} scope is required`) }
  return { user: rec.user, scopes, client_id: rec.client_id }
}

function consentPage(client, scopes, url) {
  const what = {
    'mewndo.read': 'see whether your folders are protected and what changed',
    'mewndo.write': 'make save points and add progress notes',
    'mewndo.hold': 'ask to delete files or send email — every one waits for your approval',
    offline_access: 'stay connected without signing in again',
  }
  const list = scopes.map((s) => `<li><b>${s}</b> — ${what[s] || s}</li>`).join('')
  return `<!doctype html><meta charset=utf-8><title>Connect to Mewndo</title>
<style>body{font:16px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem}
ul{line-height:1.6}button{font:inherit;padding:.6rem 1.2rem}</style>
<h1>Connect ${escapeHtml(client.client_name)} to Mewndo?</h1>
<p>It will be able to:</p><ul>${list}</ul>
<p>It can <b>never</b> undo your work, read your file contents, or send anything without your approval.</p>
<form method=post action="${escapeHtml(url.pathname + url.search)}">
<label>Your Mewndo account id: <input name=user required></label>
<p><button type=submit>Approve</button></p></form>`
}

const oauthStore = (env) => env.OAUTH.get(env.OAUTH.idFromName('global'))
const rand = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function sha256(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))))
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const html = (body) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
