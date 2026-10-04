// Compare two indexes (scanner manifests): a save point's and the folder's current one.

// Same content as far as undo cares. mtime only matters when there is no hash (skipped files).
function sameEntry(a, b) {
  return a.type === b.type && a.hash === b.hash && a.target === b.target && a.size === b.size
    && a.skipped === b.skipped && (a.hash !== undefined || a.mtimeMs === b.mtimeMs);
}

// Every path that differs, directories included. Used for the journal's 'change' events.
function changes(before, after) {
  const list = [];
  for (const [p, e] of Object.entries(after)) {
    if (!before[p]) list.push({ path: p, type: 'added' });
    else if (!sameEntry(before[p], e)) list.push({ path: p, type: 'changed' });
  }
  for (const p of Object.keys(before)) if (!after[p]) list.push({ path: p, type: 'deleted' });
  return list;
}

// What changed for the user: files and links only (folders follow from them), sorted by path.
// A deleted file and a created file with the same hash count as one move.
function compare(before, after) {
  const isItem = (e) => e && e.type !== 'directory';
  let deleted = Object.keys(before).filter((p) => isItem(before[p]) && !isItem(after[p])).sort();
  let created = Object.keys(after).filter((p) => isItem(after[p]) && !isItem(before[p])).sort();
  const edited = Object.keys(after)
    .filter((p) => isItem(after[p]) && isItem(before[p]) && !sameEntry(before[p], after[p])).sort();

  const createdByHash = new Map();
  for (const p of created) {
    const h = after[p].hash;
    if (h) createdByHash.set(h, [...(createdByHash.get(h) ?? []), p]);
  }
  const moved = [];
  for (const from of deleted) {
    const to = before[from].hash && createdByHash.get(before[from].hash)?.shift();
    if (to) moved.push({ from, to });
  }
  deleted = deleted.filter((p) => !moved.some((m) => m.from === p));
  created = created.filter((p) => !moved.some((m) => m.to === p));

  const totals = { deleted: deleted.length, edited: edited.length, moved: moved.length, created: created.length };
  const parts = Object.entries(totals).map(([kind, n]) => `${n} ${kind}`);
  const summary = Object.values(totals).some((n) => n > 0)
    ? `Since this save point, ${parts.join(', ')}.`
    : 'Since this save point, nothing changed.';
  return { deleted, edited, moved, created, totals, summary };
}

module.exports = { sameEntry, changes, compare };
