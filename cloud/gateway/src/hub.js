'use strict'
// HubDO's logic (spec §37.6 K7): one hub per tester, holding the cards cloud
// agents raise and the answers the desktop sends back.
//
// Runtime-free, like ./state.js: it takes a storage object and a `push` function
// instead of a Durable Object state and a WebSocket, so node:test drives every
// path. src/index.js passes the real ones.
//
// A card lives in storage as well as in memory, because the Durable Object can be
// evicted while a cloud agent is still waiting: `ask_user` then answers "no answer
// yet" and the agent calls `get_answer` later (§37.6 K6).

const ASK_WAIT_MS = 110_000 // under the 120 s most MCP clients allow a tool call
const CARD_KEEP_MS = 24 * 3600_000
const MAX_OPTIONS = 9 // the Inbox answers with keys 1-9 (§33.2)

class Hub {
  constructor(storage, push, options = {}) {
    this.storage = storage
    // Sends one JSON message to every connected desktop socket. No socket means
    // nobody is home, which is not an error: the card waits in storage.
    this.push = push
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.waitMs = options.waitMs ?? ASK_WAIT_MS
    this.waiting = new Map() // card id -> resolve, in memory only
  }

  // A cloud agent asks the user something. Returns the answer, or null if nobody
  // answered within the wait.
  async ask({ agent, question, options = [], context = null, now = Date.now(), waitMs = this.waitMs } = {}) {
    const card = await this.createCard({
      agent, kind: options.length ? 'question' : 'permission', title: question, body: context, options, now,
    })
    const answer = await this.wait(card.id, waitMs)
    return { card, answer }
  }

  async createCard({ agent, kind = 'question', title, body = null, options = [], risk = 2, now = Date.now() } = {}) {
    if (typeof title !== 'string' || !title.trim()) throw { status: 400, message: 'a card needs a question' }
    if (!Array.isArray(options) || options.length > MAX_OPTIONS) {
      throw { status: 400, message: `at most ${MAX_OPTIONS} options` }
    }
    const card = {
      id: this.newId(),
      source: 'cloud',
      agent: String(agent || 'cloud agent'),
      kind,
      title: String(title).slice(0, 400),
      body: body == null ? null : String(body).slice(0, 2000),
      options: options.map((o) => String(o).slice(0, 120)),
      risk,
      state: 'open',
      created_at: now,
      answer: null,
    }
    await this.storage.put({ [`card:${card.id}`]: card })
    // The desktop maps this straight into the local Inbox (§37.6 K8).
    await this.send({ type: 'inbox.card', source: 'cloud', agent: card.agent, card })
    return card
  }

  // Resolves when the desktop answers, or after waitMs. The timer is cleared on an
  // answer, so a Durable Object with no pending work can hibernate.
  wait(cardId, waitMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(cardId)
        resolve(null)
      }, waitMs)
      this.waiting.set(cardId, (answer) => {
        clearTimeout(timer)
        this.waiting.delete(cardId)
        resolve(answer)
      })
    })
  }

  // An inbox.answer from the desktop. Writes it down first, then wakes whoever is
  // waiting, so an eviction between the two still leaves the answer readable.
  async answer({ card_id, choice = null, text = null, via = 'key', now = Date.now() } = {}) {
    const key = `card:${card_id}`
    const card = await this.storage.get(key)
    if (!card) throw { status: 404, message: 'no such card' }
    if (card.state !== 'open') return card
    const picked = Number.isInteger(choice) && card.options[choice] != null ? card.options[choice] : null
    card.answer = { choice: picked, text: text == null ? null : String(text).slice(0, 2000), via, at: now }
    card.state = 'answered'
    await this.storage.put({ [key]: card })
    this.waiting.get(card_id)?.(card.answer)
    return card
  }

  async getCard({ card_id } = {}) {
    const card = await this.storage.get(`card:${card_id}`)
    if (!card) throw { status: 404, message: 'no such card' }
    return card
  }

  // report_progress: the dock shows the agent working, with its last line.
  async progress({ agent, text, now = Date.now() } = {}) {
    await this.send({
      type: 'agent.status',
      source: 'cloud',
      agent: String(agent || 'cloud agent'),
      status: 'working',
      last_line: String(text ?? '').slice(0, 200),
      at: now,
    })
    return { ok: true }
  }

  // report_done: a Done card, with the agent's claims kept as-is so Receipts
  // (§35) can check them against evidence later.
  async done({ agent, summary, claims = [], now = Date.now() } = {}) {
    const card = await this.createCard({
      agent, kind: 'done', title: String(summary ?? '').split('\n').slice(0, 2).join(' ').slice(0, 400),
      body: claims.length ? `claims: ${claims.map(String).join(' | ')}`.slice(0, 2000) : null,
      risk: 1, now,
    })
    return card
  }

  async send(message) {
    try {
      await this.push(message)
    } catch {
      // The desktop being offline is normal; the card is already stored.
    }
  }

  async openCards({ now = Date.now() } = {}) {
    const rows = await this.storage.list({ prefix: 'card:' })
    const open = []
    for (const [key, card] of rows) {
      if (now - card.created_at > CARD_KEEP_MS) await this.storage.delete(key)
      else if (card.state === 'open') open.push(card)
    }
    return open
  }
}

export { Hub, ASK_WAIT_MS, MAX_OPTIONS }
