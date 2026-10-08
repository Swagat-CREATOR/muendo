// Cloudflare Worker: mewndo-mcp (spec §22.2, §22.3, §31.5). The hosted Mewndo MCP
// server for cloud agents (claude.ai, ChatGPT, Grok, Gemini) that can only reach
// public URLs.
//
// - Streamable HTTP at POST /mcp (plus GET /mcp for the SSE stream).
// - OAuth 2.1 with Dynamic Client Registration (RFC 7591) and refresh tokens.
// - Per-tool scopes, so a client granted read tools can't call held ones.
// - Each user's state lives in a Durable Object.
// - Same tools as the local server, plus send_email and request_delete, which
//   both go through holds (never performed here).
//
// What it CANNOT do (honest, spec §22.2 / §28.10): file contents and names never
// leave the PC, so this server has no local file access. Tools that need the PC
// answer from the user's Durable Object (what the desktop app pushed to it over
// the P5.4 WebSocket) and say so when the desktop is offline. `undo` is NOT
// exposed to cloud agents.
import { TOOLS, toolScopes, handleToolCall } from './tools.js'
import { oauthRoutes, requireScope } from './oauth.js'

const PROTOCOL_VERSION = '2025-06-18'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // OAuth 2.1: metadata, dynamic client registration, authorize, token.
    const oauth = await oauthRoutes(request, env, url)
    if (oauth) return oauth

    if (url.pathname === '/mcp') {
      if (request.method === 'POST') return mcpPost(request, env, ctx)
      if (request.method === 'GET') return mcpStream(request, env)
      return json({ error: 'method not allowed' }, 405)
    }
    if (url.pathname === '/') return json({ name: 'mewndo-mcp', mcp: '/mcp' })
    return json({ error: 'not found' }, 404)
  },
}

// One JSON-RPC request (Streamable HTTP). Returns JSON, or 202 for notifications.
async function mcpPost(request, env, ctx) {
  const auth = await requireScope(request, env, null)
  if (auth.error) return auth.response
  const body = await request.json().catch(() => null)
  if (!body) return rpcError(null, -32700, 'parse error')
  const batch = Array.isArray(body) ? body : [body]
  const out = []
  for (const msg of batch) {
    const res = await dispatch(msg, env, auth, ctx)
    if (res) out.push(res)
  }
  if (out.length === 0) return new Response(null, { status: 202 })
  return json(Array.isArray(body) ? out : out[0])
}

async function dispatch(msg, env, auth, ctx) {
  const { id, method, params } = msg || {}
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (id === undefined) return null // a notification: nothing to answer

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mewndo', version: '0.1.0' },
        instructions:
          'Mewndo protects the user\'s files and accounts. Make a save point before risky work, '
          + 'use request_delete instead of deleting, and expect send_email and request_delete to be '
          + 'held for the user\'s approval. Undo is the user\'s, not yours.',
      })
    case 'tools/list':
      // Only the tools this token's scopes allow.
      return reply({ tools: TOOLS.filter((t) => auth.scopes.includes(toolScopes[t.name])) })
    case 'tools/call': {
      const name = params?.name
      const need = toolScopes[name]
      if (!need) return fail(-32602, `unknown tool ${name}`)
      if (!auth.scopes.includes(need)) return fail(-32603, `this token lacks the ${need} scope for ${name}`)
      const result = await handleToolCall(env, auth.user, name, params?.arguments || {}, ctx)
      return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !!result.error })
    }
    case 'ping':
      return reply({})
    default:
      return fail(-32601, `unknown method ${method}`)
  }
}

// GET /mcp: the server-to-client SSE stream. Mewndo pushes nothing unprompted yet,
// so the stream stays open and empty (clients accept this).
async function mcpStream(request, env) {
  const auth = await requireScope(request, env, null)
  if (auth.error) return auth.response
  const { readable, writable } = new TransformStream()
  const w = writable.getWriter()
  w.write(new TextEncoder().encode(': open\n\n'))
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function rpcError(id, code, message) {
  return json({ jsonrpc: '2.0', id, error: { code, message } }, 400)
}

export { MewndoUser, OAuthStore } from './user.js'
