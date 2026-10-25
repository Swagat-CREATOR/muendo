'use strict'
// Pure Heal planner and R2 budget for Drive (spec §24.4, §6.3), runtime-free so
// node:test covers it without a Google account.

// Cloudflare R2 free tier: 10 GB-month of storage. Warn before going over, and
// stop copying rather than silently billing the user (CLAUDE.md rule 6).
export const FREE_R2_BYTES = 10 * 1024 ** 3
const WARN_AT = 0.8

// Can we store `size` more bytes? Warn near the limit, refuse past it.
export function r2Budget(used, size) {
  const after = used + size
  if (after > FREE_R2_BYTES) {
    return {
      allowed: false,
      warning: `Mewndo's free Cloudflare R2 copy space (10 GB) would be exceeded (${gb(after)} GB needed). No more copies are being kept. Remove watched folders, or tell Mewndo you'll pay for more space.`,
    }
  }
  if (after > FREE_R2_BYTES * WARN_AT) {
    return { allowed: true, warning: `Mewndo has used ${gb(after)} GB of its 10 GB free copy space.` }
  }
  return { allowed: true, warning: null }
}
const gb = (n) => (n / 1024 ** 3).toFixed(2)

// entries: [{ id, at, gone, trashed, parents, name, revision, size }]
// Returns { untrash: [{id, addParents, removeParents}], gone: [{id, name, parents, revision}], rename: [{id, name}] }
export function healPlan(entries, onlyIds) {
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const untrash = []
  const gone = []
  const rename = []
  for (const [id, list] of byId) {
    if (onlyIds && !onlyIds.includes(id)) continue
    list.sort((a, b) => a.at - b.at)
    const base = list[0]
    const cur = list[list.length - 1]
    if (cur.gone) {
      // Permanently deleted: can only come back as a new file from a copy.
      gone.push({ id, name: base.name, parents: base.parents || [], revision: base.revision })
      continue
    }
    if (cur.trashed && !base.trashed) {
      const baseParents = base.parents || []
      const curParents = (cur.parents || []).filter((p) => p !== 'root')
      untrash.push({
        id,
        addParents: baseParents.filter((p) => !curParents.includes(p)),
        removeParents: curParents.filter((p) => !baseParents.includes(p)),
      })
    } else if (!cur.trashed && differs(base.parents, cur.parents)) {
      // Moved out of scope but not trashed: put it back in its original folder.
      untrash.push({
        id,
        addParents: (base.parents || []).filter((p) => !(cur.parents || []).includes(p)),
        removeParents: (cur.parents || []).filter((p) => !(base.parents || []).includes(p)),
      })
    }
    // Renamed: put the old name back.
    if (base.name && cur.name && base.name !== cur.name) rename.push({ id, name: base.name })
  }
  return { untrash, gone, rename }
}

function differs(a = [], b = []) {
  const x = [...a].sort().join(',')
  const y = [...b].sort().join(',')
  return x !== y
}

// --- Journal helpers for the app (docs/connections-setup.md) ---

// Keep, per file, the entries from the state just before `before` onward, so healPlan's "base" is the state before
// the change the user picked. No `before`: everything.
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

// The state before a change Mewndo sees for a file it has never seen: changes.list only gives the state now.
// Trashing doesn't move a file, so a file first seen in the trash was in the same folders, out of the trash, with
// the same name. Anything else first seen (a move, a rename, a delete) has no knowable "before": null.
export function inferBefore(entry) {
  if (entry.trashed && !entry.gone) return { ...entry, trashed: false, inferred: true }
  return null
}

// What changed between two journaled states, in words, and whether Heal can put it back.
function describe(a, b) {
  if (b.gone && !a.gone) {
    return { kind: 'deleted', what: 'Deleted forever', undoable: false, needsCopy: true,
      why: 'Mewndo has no copy of this file: it was permanently deleted and wasn\u2019t in a watched folder.' }
  }
  if (b.trashed && !a.trashed) return { kind: 'trashed', what: 'Moved to Trash', undoable: true }
  const moved = differs(a.parents, b.parents) && !b.trashed
  const renamed = a.name && b.name && a.name !== b.name
  if (moved && renamed) return { kind: 'moved', what: `Moved and renamed (was \u201c${a.name}\u201d)`, undoable: true }
  if (moved) return { kind: 'moved', what: 'Moved to another folder', undoable: true }
  if (renamed) return { kind: 'renamed', what: `Renamed (was \u201c${a.name}\u201d)`, undoable: true }
  if (a.revision && b.revision && a.revision !== b.revision) {
    return { kind: 'edited', what: 'Content changed', undoable: false,
      why: 'Mewndo doesn\u2019t put back older content yet; use File \u2192 Version history in Drive.' }
  }
  return null
}

// The journal as a list of changes, newest first. `restoreBefore` is what the app passes back as `before`.
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
      if (d) out.push({ id, at: list[i].at, restoreBefore: list[i].at, title: list[i].name || list[i - 1].name || null, ...d, inferred: !!list[i - 1].inferred, by: list[i].by ?? null })
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit)
}
