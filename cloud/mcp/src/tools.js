'use strict'
// The hosted server's tools (spec §22.3) and their scopes. Same tools as the local
// server, plus send_email and request_delete, which go through holds. `undo` is
// deliberately absent: it is never exposed to cloud agents.
//
// Per-tool scopes mean a client granted only read tools cannot call a held one.
export const toolScopes = {
  mewndo_status: 'mewndo.read',
  list_changes: 'mewndo.read',
  get_project_card: 'mewndo.read',
  create_save_point: 'mewndo.write',
  append_progress: 'mewndo.write',
  request_delete: 'mewndo.hold',
  send_email: 'mewndo.hold',
}

export const ALL_SCOPES = ['mewndo.read', 'mewndo.write', 'mewndo.hold', 'offline_access']

export const TOOLS = [
  {
    name: 'mewndo_status',
    description: 'Is this project or account protected by Mewndo? Its newest save point and any actions waiting for the user\'s approval.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project name; the user\'s default if left out' } } },
  },
  {
    name: 'create_save_point',
    description: 'Ask Mewndo for a save point before risky work, so the user can undo back to it.',
    inputSchema: { type: 'object', properties: { label: { type: 'string' }, project: { type: 'string' } } },
  },
  {
    name: 'list_changes',
    description: 'What changed since a save point, as Mewndo\'s journal saw it.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, project: { type: 'string' } } },
  },
  {
    name: 'request_delete',
    description: 'Ask to delete files or messages. Nothing is deleted now: the user approves or cancels, and approved items go to Mewndo\'s trash. Returns pending_approval.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
      required: ['paths', 'reason'],
    },
  },
  {
    name: 'send_email',
    description: 'Ask Mewndo to send an email. Send Guard checks it and the user approves; it is never sent without a verdict. Returns pending_approval or held.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        attachments: { type: 'array', items: { type: 'object' } },
      },
      required: ['to', 'subject'],
    },
  },
  {
    name: 'get_project_card',
    description: 'The verified Continue card for a project: the task, what really changed, and the rules to keep.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } } },
  },
  {
    name: 'append_progress',
    description: 'Report progress. Stored as "Agent says" until Mewndo\'s journal confirms it.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
]

// Every tool goes to the user's Durable Object. Held tools create a hold the
// desktop app and phone show; they never perform the action here.
export async function handleToolCall(env, user, name, args, ctx) {
  const stub = env.MEWNDO_USER.get(env.MEWNDO_USER.idFromName(user))
  const res = await stub.fetch(`https://do/tool/${name}`, {
    method: 'POST',
    body: JSON.stringify({ args, at: Date.now() }),
  })
  return res.json()
}
