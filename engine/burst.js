// Burst detector: notices when many files are deleted or changed within a short time, the typical sign of an
// AI agent going wrong. Alerts once per burst; a burst ends after a whole window with no changes.

function createBurstDetector({ windowMs = 60_000, maxDeleted = 20, maxChanged = 50, now = Date.now } = {}) {
  let events = []; // { at, deleted }
  let lastAt = -Infinity;
  let alerted = false;

  return {
    // changes: [{ type: 'added' | 'changed' | 'deleted' }] for files and links, not folders.
    // Returns { deleted, changed } (counts within the window; changed includes deleted) the first time a burst
    // crosses a threshold, otherwise null.
    record(changes) {
      if (!changes.length) return null;
      const t = now();
      if (t - lastAt > windowMs) { events = []; alerted = false; } // quiet for a whole window: a new burst
      lastAt = t;
      for (const c of changes) events.push({ at: t, deleted: c.type === 'deleted' });
      events = events.filter((e) => t - e.at <= windowMs);
      const deleted = events.filter((e) => e.deleted).length;
      const changed = events.length;
      if (alerted || (deleted < maxDeleted && changed < maxChanged)) return null;
      alerted = true;
      return { deleted, changed };
    },
  };
}

module.exports = { createBurstDetector };
