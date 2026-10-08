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
// Returns { untrash: [{id, addParents, removeParents}], gone: [{id, name, parents, revision}] }
export function healPlan(entries, onlyIds) {
  const byId = new Map()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, [])
    byId.get(e.id).push(e)
  }
  const untrash = []
  const gone = []
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
  }
  return { untrash, gone }
}

function differs(a = [], b = []) {
  const x = [...a].sort().join(',')
  const y = [...b].sort().join(',')
  return x !== y
}
