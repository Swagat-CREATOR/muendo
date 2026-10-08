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
