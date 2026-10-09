'use strict'
// The hosted MCP for cloud agents (spec §37.6 K6): ChatGPT dots, Grok Bot, Meta
// Muse and claude.ai have no hooks, so they ask Mewndo by calling a tool.
//
// This is MCP's JSON-RPC by hand rather than the Agents SDK's McpAgent. Three
// methods are all a tool server needs (initialize, tools/list, tools/call), it is
// about 90 lines, it adds no dependency, and it runs under plain `node --test`,
// which `@modelcontextprotocol/sdk` + `zod` + `agents` do not. The deviation and
// the way back are recorded in ../README.md.
//
// Runtime-free: `handle` takes a context holding the tester's Hub, so node:test
// drives every tool without a Worker.

const PROTOCOL_VERSION = '2025-06-18'

// Input schemas are plain JSON Schema, which is what MCP puts on the wire anyway.
const TOOLS = [
  {
    name: 'ask_user',
    description: 'Ask the user a question and wait for the answer. Call this BEFORE sending an email, '
      + 'deleting anything, buying, posting publicly or changing a shared document. One line, plus options.',
    inputSchema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', description: 'One line: what you are about to do.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Up to 9 choices.' },
        context: { type: 'string', description: 'What the user needs to know to decide.' },
      },
    },
  },
  {
    name: 'get_answer',
    description: 'Read the answer to a card ask_user did not get in time.',
    inputSchema: { type: 'object', required: ['card_id'], properties: { card_id: { type: 'string' } } },
  },
  {
    name: 'report_progress',
    description: 'Tell the user what you are doing now. One line.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  },
  {
    name: 'report_done',
    description: 'Finish a turn: a two-line summary and the claims you are making, so Mewndo can check them.',
    inputSchema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string' },
        claims: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'skills_list',
    description: 'List the recorded workflows the user chose to share with cloud agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skills_get',
    description: 'Read one shared workflow by slug.',
    inputSchema: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
  },
]

// One JSON-RPC request in, one response out (or null for a notification).
async function handle(rpc, ctx) {
  if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return error(rpc?.id ?? null, -32600, 'not a JSON-RPC 2.0 request')
  }
  const notification = rpc.id === undefined || rpc.id === null
  try {
    switch (rpc.method) {
      case 'initialize':
        return reply(rpc.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'mewndo', version: '0.1.0' },
          instructions: 'Call ask_user before any action the user would want to approve, and report_done at the end. '
            + 'Never retry an action the user denied.',
        })
      case 'ping':
        return reply(rpc.id, {})
      case 'notifications/initialized':
        return null
      case 'tools/list':
        return reply(rpc.id, { tools: TOOLS })
      case 'tools/call':
        return reply(rpc.id, await callTool(rpc.params ?? {}, ctx))
      default:
        return notification ? null : error(rpc.id, -32601, `unknown method ${rpc.method}`)
    }
  } catch (e) {
    // A tool failure is a tool result with isError, not a protocol error, so the
    // agent can read why and stop instead of retrying blindly (§36.6 U5.8).
    if (rpc.method === 'tools/call') return reply(rpc.id, text(`Mewndo: ${e.message || e}`, true))
    return error(rpc.id ?? null, -32603, String(e.message || e))
  }
}

async function callTool({ name, arguments: args = {} }, ctx) {
  switch (name) {
    case 'ask_user': {
      const { card, answer } = await ctx.hub.ask({
        agent: ctx.agent, question: args.question, options: args.options ?? [], context: args.context ?? null,
      })
      if (!answer) {
        return text(`No answer yet; call get_answer with card_id ${card.id} later. `
          + 'Do not go ahead without one.')
      }
      return text(answered(answer))
    }
    case 'get_answer': {
      const card = await ctx.hub.getCard({ card_id: args.card_id })
      if (card.state !== 'answered') return text('No answer yet. Do not go ahead without one.')
      return text(answered(card.answer))
    }
    case 'report_progress':
      await ctx.hub.progress({ agent: ctx.agent, text: args.text })
      return text('Noted.')
    case 'report_done': {
      const card = await ctx.hub.done({ agent: ctx.agent, summary: args.summary, claims: args.claims ?? [] })
      return text(`Done card shown to the user (${card.id}).`)
    }
    case 'skills_list': {
      const slugs = await ctx.skills.list()
      return text(slugs.length ? slugs.join('\n') : 'The user has not shared any workflows with cloud agents.')
    }
    case 'skills_get': {
      const skill = await ctx.skills.get(args.slug)
      if (!skill) return text(`No shared workflow called ${args.slug}.`, true)
      return text(skill)
    }
    default:
      return text(`Unknown tool ${name}.`, true)
  }
}

function answered(answer) {
  if (answer.choice) return `User chose: ${answer.choice}`
  if (answer.text) return `User said: ${answer.text}`
  return 'The user answered with no choice; treat that as a no.'
}

const text = (body, isError = false) => ({ content: [{ type: 'text', text: body }], isError })
const reply = (id, result) => ({ jsonrpc: '2.0', id, result })
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

export { handle, TOOLS, PROTOCOL_VERSION }
