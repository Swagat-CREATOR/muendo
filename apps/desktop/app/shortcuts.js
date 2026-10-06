// Default global shortcuts (spec §23.7). Wispr Flow dictates while Ctrl + Alt is held, so no default starts with
// Ctrl + Alt. When a default is taken by another app, the next free alternative is used and the user is told.
// Plain data and logic, no Electron: tests run it with plain Node.
const DEFAULTS = {
  undo: ['Alt+Shift+Z', 'Super+Shift+Z', 'Control+Shift+F9'],
  brief: ['Alt+Shift+B', 'Super+Shift+B', 'Control+Shift+F10'],
};

// The first candidate tryRegister(accel) accepts, or null when every one is taken.
function pickShortcut(candidates, tryRegister) {
  return candidates.find((accel) => tryRegister(accel)) ?? null;
}

module.exports = { DEFAULTS, pickShortcut };
