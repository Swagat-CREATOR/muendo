// The hosted MCP and the hub (spec §37.6 K6, K7), driven through the Worker.
// A cloud agent has no hooks, so ask_user is the only thing standing between it
// and a send it cannot take back: the tests below are about what happens when
// nobody answers, as much as when somebody does.
import { test } from 'node:test'
import assert from 'node:assert'
import worker from '../src/index.js'
import { fakeEnv, fakeCtx, ADMIN_SECRET } from './fake-do.js'
import { TOOLS } from '../src/mcp.js'

async function call(env, ctx, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['content-type'] = 'application/json'
  }
  const res = await worker.fetch(new Request(`https://mewndo-cloud.test${path}`, init), env, ctx)
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function withTester(env, ctx) {
  const mint = await call(env, ctx, 'POST', '/admin/invites', {
    headers: { 'x-admin-secret': ADMIN_SECRET }, body: { count: 1 },
  })
  const redeemed = await call(env, ctx, 'POST', '/invite/redeem', { body: { code: mint.body.codes[0], name: 'Priya' } })
  return redeemed.body.token
}

const rpc = (env, ctx, token, method, params, id = 1) => call(env, ctx, 'POST', '/mcp', {
  headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id, method, params },
})

const tool = (env, ctx, token, name, args, id = 2) =>
  rpc(env, ctx, token, 'tools/call', { name, arguments: args }, id)

// The desktop's side of the hub, without a real WebSocket.
const desktop = (env, message) => env.hubObject.webSocketMessage(
  { send: (s) => env.pushed.push(JSON.parse(s)) },
  JSON.stringify(message),
)

test('/mcp refuses anyone without a tester token', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  assert.equal((await call(env, ctx, 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 401)
  assert.equal((await rpc(env, ctx, 'not-a-token', 'ping', {})).status, 401)
})

test('a token in the query string works, for agents that cannot set headers', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const res = await call(env, ctx, 'POST', `/mcp?token=${token}`, { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.result, {})
})

test('initialize and tools/list advertise the §37.6 K6 tools', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const init = await rpc(env, ctx, token, 'initialize', { clientInfo: { name: 'grok-bot' } })
  assert.equal(init.body.result.serverInfo.name, 'mewndo')
  assert.ok(init.body.result.capabilities.tools)

  const list = await rpc(env, ctx, token, 'tools/list', {})
  const names = list.body.result.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['ask_user', 'get_answer', 'report_done', 'report_progress', 'skills_get', 'skills_list'])
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object', t.name)
})

test('ask_user raises a card on the desktop and returns the answer', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)

  const asked = tool(env, ctx, token, 'ask_user', {
    question: 'Send the invoice to priya@acme.com?',
    options: ['Send it', 'Hold it'],
    context: 'Invoice October, 2 attachments',
  })
  // The card reaches the desktop before the tool call returns.
  await new Promise((r) => setTimeout(r, 5))
  const pushed = env.pushed.find((m) => m.type === 'inbox.card')
  assert.equal(pushed.source, 'cloud')
  assert.equal(pushed.agent, 'cloud agent')
  assert.equal(pushed.card.title, 'Send the invoice to priya@acme.com?')
  assert.deepEqual(pushed.card.options, ['Send it', 'Hold it'])

  await desktop(env, { type: 'inbox.answer', card_id: pushed.card.id, choice: 0, via: 'key' })
  const out = await asked
  assert.equal(out.body.result.isError, false)
  assert.equal(out.body.result.content[0].text, 'User chose: Send it')
})

test('nobody answering is never an approval', async () => {
  const env = fakeEnv({ askWaitMs: 20 })
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const out = await tool(env, ctx, token, 'ask_user', { question: 'Delete the folder?' })
  const said = out.body.result.content[0].text
  assert.match(said, /No answer yet/)
  assert.match(said, /Do not go ahead without one/)

  // The card id it hands back reads the answer later (§37.6 K6 get_answer).
  const cardId = said.match(/card_id ([\w-]+)/)[1]
  const early = await tool(env, ctx, token, 'get_answer', { card_id: cardId })
  assert.match(early.body.result.content[0].text, /No answer yet/)

  await desktop(env, { type: 'inbox.answer', card_id: cardId, text: 'no, leave it' })
  const late = await tool(env, ctx, token, 'get_answer', { card_id: cardId })
  assert.equal(late.body.result.content[0].text, 'User said: no, leave it')
})

test('an answer survives the object being evicted mid-wait', async () => {
  // The waiter lives in memory; the card and its answer live in storage, so a
  // reconstructed object still finds the answer.
  const env = fakeEnv({ askWaitMs: 20 })
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const out = await tool(env, ctx, token, 'ask_user', { question: 'Post it publicly?' })
  const cardId = out.body.result.content[0].text.match(/card_id ([\w-]+)/)[1]
  await desktop(env, { type: 'inbox.answer', card_id: cardId, text: 'go ahead' })
  env.hubObject.hub.waiting.clear() // what eviction costs
  const late = await tool(env, ctx, token, 'get_answer', { card_id: cardId })
  assert.equal(late.body.result.content[0].text, 'User said: go ahead')
})

test('a second answer to the same card is ignored', async () => {
  const env = fakeEnv({ askWaitMs: 20 })
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const out = await tool(env, ctx, token, 'ask_user', { question: 'Pay the invoice?', options: ['Pay', 'Hold'] })
  const cardId = out.body.result.content[0].text.match(/card_id ([\w-]+)/)[1]
  await desktop(env, { type: 'inbox.answer', card_id: cardId, choice: 1 })
  await desktop(env, { type: 'inbox.answer', card_id: cardId, choice: 0 })
  const read = await tool(env, ctx, token, 'get_answer', { card_id: cardId })
  assert.equal(read.body.result.content[0].text, 'User chose: Hold')
})

test('report_progress and report_done reach the desktop', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  await tool(env, ctx, token, 'report_progress', { text: 'reading the thread' })
  const status = env.pushed.find((m) => m.type === 'agent.status')
  assert.equal(status.last_line, 'reading the thread')
  assert.equal(status.status, 'working')

  await tool(env, ctx, token, 'report_done', { summary: 'Sent the invoice.\nUpdated the sheet.', claims: ['tests pass'] })
  const done = env.pushed.filter((m) => m.type === 'inbox.card').pop()
  assert.equal(done.card.kind, 'done')
  assert.equal(done.card.title, 'Sent the invoice. Updated the sheet.')
  assert.match(done.card.body, /claims: tests pass/)
})

test('skills are empty until the desktop shares one', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const empty = await tool(env, ctx, token, 'skills_list', {})
  assert.match(empty.body.result.content[0].text, /has not shared any/)
  assert.equal((await tool(env, ctx, token, 'skills_get', { slug: 'nope' })).body.result.isError, true)

  await desktop(env, { type: 'skills.share', slug: 'send-monthly-invoice', text: '# Send the monthly invoice' })
  const list = await tool(env, ctx, token, 'skills_list', {})
  assert.equal(list.body.result.content[0].text, 'send-monthly-invoice')
  const got = await tool(env, ctx, token, 'skills_get', { slug: 'send-monthly-invoice' })
  assert.equal(got.body.result.content[0].text, '# Send the monthly invoice')
})

test('a bad tool call is a tool error the agent can read, not a protocol error', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const blank = await tool(env, ctx, token, 'ask_user', { question: '   ' })
  assert.equal(blank.body.result.isError, true)
  assert.match(blank.body.result.content[0].text, /needs a question/)

  const unknown = await tool(env, ctx, token, 'no_such_tool', {})
  assert.equal(unknown.body.result.isError, true)

  const badMethod = await rpc(env, ctx, token, 'nonsense', {})
  assert.equal(badMethod.body.error.code, -32601)
  const notRpc = await call(env, ctx, 'POST', '/mcp', {
    headers: { authorization: `Bearer ${token}` }, body: { hello: true },
  })
  assert.equal(notRpc.body.error.code, -32600)
})

test('a notification gets no reply body', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  const res = await call(env, ctx, 'POST', '/mcp', {
    headers: { authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  })
  assert.equal(res.status, 202)
})

test('/hub needs a token and a WebSocket upgrade', async () => {
  const env = fakeEnv()
  const ctx = fakeCtx()
  const token = await withTester(env, ctx)
  assert.equal((await call(env, ctx, 'GET', '/hub')).status, 401)
  const plain = await call(env, ctx, 'GET', '/hub', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(plain.status, 426)
})
