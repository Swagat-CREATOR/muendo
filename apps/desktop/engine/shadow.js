// Shadow mode (spec P1.7): the v0 engine and mewndo-core each scan the same protected folder and their manifests
// are compared, so any difference between the engines shows up in the log before Rust is trusted alone.
// Compared per path: type, size, modified time, hash, link target and why a file was skipped. Files still being
// written (pending) are left out, and a difference must show in two scans in a row: a file that changed between
// the two engines' scans isn't one.
const FIELDS = ['type', 'size', 'mtimeMs', 'hash', 'target', 'skipped'];

function differences(v0, rust) {
  const out = [];
  for (const p of new Set([...Object.keys(v0), ...Object.keys(rust)])) {
    const a = v0[p];
    const b = rust[p];
    if (!a || !b) { out.push({ path: p, field: 'exists', v0: !!a, rust: !!b }); continue; }
    if (a.pending || b.pending) continue;
    const f = FIELDS.find((k) => a[k] !== b[k]);
    if (f) out.push({ path: p, field: f, v0: a[f], rust: b[f] });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// Scan `journal`'s folder with both engines. previous: the core's manifest from last time (only changed files are
// hashed again). Returns the core's manifest and the differences.
async function compareEngines(journal, core, previous = {}) {
  const { ignore, ignorePatterns, maxFileSize } = journal.scanOptions;
  const both = async (prev) => {
    const v0 = await journal.sync();
    const { manifest } = await core.request('scan', {
      root: journal.root, previous: prev, options: { ignore, ignore_patterns: ignorePatterns, max_file_size: maxFileSize },
    }, { within: 60 * 60_000 });
    return { v0, manifest };
  };
  const first = await both(previous);
  let found = differences(first.v0, first.manifest);
  if (!found.length) return { manifest: first.manifest, differences: [] };
  const again = await both(first.manifest);
  const still = new Set(differences(again.v0, again.manifest).map((d) => d.path));
  found = found.filter((d) => still.has(d.path));
  return { manifest: again.manifest, differences: found };
}

module.exports = { compareEngines, differences };
