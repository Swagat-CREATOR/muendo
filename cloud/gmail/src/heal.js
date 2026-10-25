'use strict'
// Pure Heal planner for Gmail (spec §24.4 / §6.2), runtime-free so node:test can
// cover it without a Google account. Given the journaled label/trash snapshots of
// messages the orchestrator has judged out of scope, it builds the smallest set
// of batchModify calls that puts them back: untrash as one batch, and one batch
// per distinct (add,remove) label change. Permanently deleted messages are
// reported separately — Gmail can't undelete them (they need a prior Mewndo copy).

// entries: [{ id, labelIds, trashed, gone, at }]. onlyIds: restrict to these ids.
export function healPlan(entries, onlyIds) {
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const untrash = []
  const relabel = {}
  const gone = []
  for (const [id, list] of byId) {
    if (onlyIds && !onlyIds.includes(id)) continue
    list.sort((a, b) => a.at - b.at)
    const base = list[0] // the state before the out-of-scope change
    const cur = list[list.length - 1] // the state now
    if (cur.gone) { gone.push(id); continue }
    if (cur.trashed && !base.trashed) untrash.push(id)
    const baseLabels = new Set((base.labelIds || []).filter((l) => l !== 'TRASH'))
    const curLabels = new Set((cur.labelIds || []).filter((l) => l !== 'TRASH'))
    const add = [...baseLabels].filter((l) => !curLabels.has(l)).sort()
    const remove = [...curLabels].filter((l) => !baseLabels.has(l)).sort()
    if (add.length || remove.length) {
      const key = JSON.stringify({ add, remove })
      if (!relabel[key]) relabel[key] = []
      relabel[key].push(id)
    }
  }
  return { untrash, relabel, gone }
}

// --- Journal helpers for the app (docs/connections-setup.md) ---

// Keep, per message, the entries from the state just before `before` onward, so healPlan's "base" is the state
// before the change the user picked rather than the oldest state Mewndo ever saw. No `before`: everything.
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

// Gmail history records -> for each touched message, its state after and (when the records show it) before.
// history.list's records carry each message's labelIds and the labels added or removed, so the state before is
// the state after with those changes walked back: no extra call per message (the free Workers plan allows 50
// subrequests per run, and a 500-message burst would blow through that). A message added in this window has no
// "before" (it didn't exist); one whose labels the records don't show is marked needsFetch.
export function historyToEntries(history) {
  const seen = new Map()
  const get = (id) => {
    if (!seen.has(id)) seen.set(id, { id, labelIds: null, added: false, gone: false, deltas: [] })
    return seen.get(id)
  }
  for (const h of history || []) {
    for (const x of h.messagesAdded || []) if (x.message?.id) { const m = get(x.message.id); m.added = true; if (x.message.labelIds) m.labelIds = x.message.labelIds }
    for (const x of h.labelsAdded || []) if (x.message?.id) { const m = get(x.message.id); m.deltas.push({ add: x.labelIds || [] }); if (x.message.labelIds) m.labelIds = x.message.labelIds }
    for (const x of h.labelsRemoved || []) if (x.message?.id) { const m = get(x.message.id); m.deltas.push({ remove: x.labelIds || [] }); if (x.message.labelIds) m.labelIds = x.message.labelIds }
    for (const x of h.messagesDeleted || []) if (x.message?.id) { const m = get(x.message.id); m.gone = true; if (x.message.labelIds) m.labelIds = x.message.labelIds }
    for (const x of h.messages || []) if (x?.id) get(x.id)
  }
  const out = []
  for (const m of seen.values()) {
    const known = Array.isArray(m.labelIds)
    if (!known && !m.gone) { out.push({ id: m.id, needsFetch: true }); continue }
    const after = { labelIds: m.gone ? [] : m.labelIds, trashed: !m.gone && m.labelIds.includes('TRASH'), gone: m.gone }
    let before = null
    if (!m.added && known) {
      const labels = new Set(m.labelIds)
      for (const d of [...m.deltas].reverse()) {
        for (const l of d.add || []) labels.delete(l)
        for (const l of d.remove || []) labels.add(l)
      }
      const list = [...labels]
      before = { labelIds: list, trashed: list.includes('TRASH'), gone: false }
    }
    out.push({ id: m.id, before, after })
  }
  return out
}

const SYSTEM = { INBOX: 'Inbox', UNREAD: 'Unread', STARRED: 'Starred', SPAM: 'Spam', IMPORTANT: 'Important', SENT: 'Sent', DRAFT: 'Draft' }
const labelName = (l) => SYSTEM[l] ?? (l.startsWith('CATEGORY_') ? null : 'a label')

// What changed between two journaled states, in words, and whether Heal can put it back.
function describe(a, b) {
  if (b.gone && !a.gone) {
    return { kind: 'deleted', what: 'Deleted forever', undoable: false,
      why: 'Gmail has no undelete, and Mewndo keeps no copy of your mail, so this message can’t come back.' }
  }
  if (b.trashed && !a.trashed) return { kind: 'trashed', what: 'Moved to Trash', undoable: true }
  const was = new Set((a.labelIds || []).filter((l) => l !== 'TRASH'))
  const now = new Set((b.labelIds || []).filter((l) => l !== 'TRASH'))
  const added = [...now].filter((l) => !was.has(l))
  const removed = [...was].filter((l) => !now.has(l))
  if (!added.length && !removed.length) return null
  const words = []
  if (removed.includes('INBOX')) words.push('archived')
  if (added.includes('INBOX')) words.push('moved to Inbox')
  if (removed.includes('UNREAD')) words.push('marked read')
  if (added.includes('UNREAD')) words.push('marked unread')
  for (const l of added) if (!['INBOX', 'UNREAD'].includes(l) && labelName(l)) words.push(`${labelName(l)} added`)
  for (const l of removed) if (!['INBOX', 'UNREAD'].includes(l) && labelName(l)) words.push(`${labelName(l)} removed`)
  const what = words.length ? words.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Labels changed'
  return { kind: 'labels', what, undoable: true }
}

// The journal as a list of changes, newest first: one per state change of one message. `restoreBefore` is what
// the app passes back as `before` to undo exactly this change (and anything after it on the same message).
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
      if (d) out.push({ id, at: list[i].at, restoreBefore: list[i].at, ...d, inferred: !!list[i - 1].inferred, by: list[i].by ?? null })
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}
