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

// --- Journal helpers for the app (docs/connections-setup.md) ---

// Keep, per page, the snapshots from the one just before `before` onward, so restorePlan's "base" is the page as
// it was before the change the user picked. No `before`: everything.
export function fromBefore(entries, before) {
  if (!before) return entries
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const out = []
  for (const list of byId.values()) {
    list.sort((a, b) => a.at - b.at)
    let start = 0
    for (let i = 0; i < list.length; i++) if (list[i].at < before) start = i
    out.push(...list.slice(start))
  }
  return out
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

// What changed between two snapshots of a page, in words, and whether it can be put back.
function describe(a, b) {
  if (b.in_trash && !a.in_trash) return { kind: 'trashed', what: 'Moved to Trash', undoable: true }
  const now = new Set((b.blocks || []).map(blockKey))
  const was = new Set((a.blocks || []).map(blockKey))
  const lost = (a.blocks || []).filter((x) => !now.has(blockKey(x))).length
  const added = (b.blocks || []).filter((x) => !was.has(blockKey(x))).length
  if (lost) {
    return { kind: 'blocks', what: `${plural(lost, 'block')} removed or changed${added ? `, ${plural(added, 'block')} added` : ''}`, undoable: true,
      note: 'The old blocks come back at the end of the page with new block ids; blocks added since stay.' }
  }
  if (added) return { kind: 'added', what: `${plural(added, 'block')} added`, undoable: false, why: 'Mewndo puts back what was removed; it doesn’t delete what was added.' }
  if ((a.title || '') !== (b.title || '') && a.title) return { kind: 'title', what: `Title changed (was “${a.title}”)`, undoable: false, why: 'Mewndo doesn’t put back page titles yet.' }
  return null
}

// The journal as a list of changes, newest first. `restoreBefore` is what the app passes back as `before`;
// `changedAt` is Notion's own last_edited_time, closer to when the change really happened than `at`.
export function changeList(entries, { limit = 200 } = {}) {
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const out = []
  for (const [id, list] of byId) {
    list.sort((a, b) => a.at - b.at)
    for (let i = 1; i < list.length; i++) {
      const d = describe(list[i - 1], list[i])
      if (d) out.push({ id, at: list[i].at, changedAt: list[i].edited || null, restoreBefore: list[i].at, title: list[i].title || list[i - 1].title || null, ...d, by: list[i].by ?? null })
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}

// An internal integration secret as Notion shows it ("ntn_…", or "secret_…" for older ones). Checked before it is
// sent anywhere, so a pasted sentence or password never leaves the Worker's front door.
export const looksLikeNotionToken = (t) => typeof t === 'string' && /^(ntn_|secret_)[A-Za-z0-9]{20,200}$/.test(t)
