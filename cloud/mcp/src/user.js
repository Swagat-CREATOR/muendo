'use strict'
// Durable Objects for the hosted MCP server.
//
// MewndoUser: one per user. Holds what the desktop app pushed up (status, save
// points, the Continue card) and the hold queue. Held tools (request_delete,
// send_email) only ever create a hold here; nothing is performed in the cloud.
// File contents and names never leave the PC, so anything needing the PC answers
// from what the desktop pushed, and says when the desktop is offline.

const DESKTOP_STALE_MS = 60_000

export class MewndoUser {
  constructor(state) {
    this.state = state
    this.sockets = new Set()
  }

  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage

    // P5.4 connects the desktop app here over a WebSocket.
    if (url.pathname === '/link') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      server.accept()
      this.sockets.add(server)
      server.addEventListener('message', async (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'state') await s.put('desktop', { ...msg.state, at: Date.now() })
        if (msg.type === 'resolve') await this.resolve(msg.id, msg.decision, msg.approver)
      })
      server.addEventListener('close', () => this.sockets.delete(server))
      await s.put('desktopSeen', Date.now())
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname.startsWith('/tool/')) {
      const name = url.pathname.slice('/tool/'.length)
      const { args, at } = await request.json()
      return json(await this.tool(name, args, at))
    }

    if (url.pathname === '/holds') return json({ holds: await this.holds() })

    return json({ error: 'not found' }, 404)
  }

  async tool(name, args, at) {
    const s = this.state.storage
    const desktop = await s.get('desktop')
    const online = desktop && Date.now() - desktop.at < DESKTOP_STALE_MS
    const offline = {
      error: 'Mewndo\'s desktop app is offline, so this is the last state it reported.',
      desktop_online: false,
    }

    switch (name) {
      case 'mewndo_status':
        return { ...(desktop?.status || {}), desktop_online: !!online, ...(online ? {} : offline) }
      case 'list_changes':
        return online
          ? { changes: desktop?.changes || [], since: args.since || null }
          : { ...offline, changes: desktop?.changes || [] }
      case 'get_project_card':
        return desktop?.card
          ? { card: desktop.card, verified: !!desktop.card.verified }
          : { error: 'No Continue card yet. Mewndo writes one after a brief or a brake.' }
      case 'create_save_point':
      case 'append_progress': {
        // Harmless writes: queue for the desktop, which does the real work.
        const id = crypto.randomUUID()
        await s.put(`queued:${id}`, { id, name, args, at })
        this.push({ type: 'do', id, name, args })
        return online
          ? { queued: true, id, note: 'Mewndo is doing this on the PC.' }
          : { queued: true, id, ...offline, note: 'It will run when the PC comes back.' }
      }
      case 'request_delete':
      case 'send_email': {
        // Held: the user approves on the bar or the phone. Never performed here.
        const id = crypto.randomUUID()
        const hold = {
          id,
          kind: name,
          args,
          at,
          state: 'pending_approval',
          // A send is never released without a verdict (spec §28.4 Flow D, P5.5).
        }
        await s.put(`hold:${id}`, hold)
        this.push({ type: 'hold', hold })
        return {
          status: 'pending_approval',
          hold_id: id,
          message:
            name === 'send_email'
              ? 'Send Guard is checking this and the user must approve it. Nothing has been sent.'
              : 'Nothing has been deleted. The user approves or cancels; approved files go to Mewndo\'s trash.',
        }
      }
      default:
        return { error: `unknown tool ${name}` }
    }
  }

  async holds() {
    const map = await this.state.storage.list({ prefix: 'hold:' })
    return [...map.values()].filter((h) => h.state === 'pending_approval')
  }

  async resolve(id, decision, approver) {
    const s = this.state.storage
    const hold = await s.get(`hold:${id}`)
    if (!hold) return
    await s.put(`hold:${id}`, { ...hold, state: decision, approver, resolved: Date.now() })
  }

  // Tell the linked desktop app (P5.4). Nothing is lost if it's offline: it is stored.
  push(msg) {
    for (const ws of this.sockets) {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        this.sockets.delete(ws)
      }
    }
  }
}

// OAuth clients, codes and tokens. Only hashes of codes and tokens are stored.
export class OAuthStore {
  constructor(state) {
    this.state = state
  }

  async fetch(request) {
    const url = new URL(request.url)
    const s = this.state.storage
    const p = url.pathname

    if (p === '/client' && request.method === 'POST') {
      const c = await request.json()
      await s.put(`client:${c.client_id}`, c)
      return json({ ok: true })
    }
    if (p === '/client') return json((await s.get(`client:${url.searchParams.get('id')}`)) || {})

    if (p === '/code' && request.method === 'POST') {
      const c = await request.json()
      await s.put(`code:${c.code}`, c)
      return json({ ok: true })
    }
    if (p === '/code') {
      const key = `code:${url.searchParams.get('hash')}`
      const c = await s.get(key)
      if (c) await s.delete(key) // one use only
      return json(c || {})
    }

    if (p === '/access' && request.method === 'POST') {
      const a = await request.json()
      await s.put(`access:${a.hash}`, a)
      return json({ ok: true })
    }
    if (p === '/access') return json((await s.get(`access:${url.searchParams.get('hash')}`)) || {})

    if (p === '/refresh' && request.method === 'POST') {
      const r = await request.json()
      await s.put(`refresh:${r.hash}`, r)
      return json({ ok: true })
    }
    if (p === '/refresh') return json((await s.get(`refresh:${url.searchParams.get('hash')}`)) || {})

    return json({ error: 'not found' }, 404)
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
