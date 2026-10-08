'use strict'
// Pure Notion Heal logic (spec §24.4, §6.4), runtime-free so node:test covers it
// without a Notion workspace.

// The honest limit the app must show (spec §28.10).
export const UNDO_LAG_NOTE =
  'Notion tells Mewndo about changes a minute or more late, so Notion undo takes about '
  + 'one to two minutes — unless the change went through Mewndo\'s MCP, which is immediate.'

// About 3 requests per second, as Notion asks. Simple spacing, not a token bucket:
// ponytail: good enough for one worker; use a shared limiter if several workers
// ever hit the same workspace.
export class RateLimiter {
  constructor(perSecond) {
    this.gap = 1000 / perSecond
    this.next = 0
  }
  async wait() {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.gap
    if (at > now) await new Promise((r) => setTimeout(r, at - now))
  }
}

// entries: [{ id, at, edited, in_trash, parent, title, blocks }]
// Returns [{ id, untrash, restoreBlocks }] — the oldest snapshot is the state to
// return to, the newest is the state now.
export function restorePlan(entries, onlyIds) {
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const plan = []
  for (const [id, list] of byId) {
    if (onlyIds && !onlyIds.includes(id)) continue
    list.sort((a, b) => a.at - b.at)
    const base = list[0]
    const cur = list[list.length - 1]
    const untrash = !!cur.in_trash && !base.in_trash
    // Blocks the page had before and does not have now.
    const curKeys = new Set((cur.blocks || []).map(blockKey))
    const restoreBlocks = (base.blocks || []).filter((b) => !curKeys.has(blockKey(b)))
    if (untrash || restoreBlocks.length) plan.push({ id, untrash, restoreBlocks })
  }
  return plan
}

// A block's identity for comparison: its type plus its text, since restored
// blocks get new ids.
function blockKey(block) {
  const t = block.type
  const rich = block[t]?.rich_text || []
  return `${t}:${rich.map((r) => r.plain_text ?? r.text?.content ?? '').join('')}`
}
