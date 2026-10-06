// Where the Mewndo bar sits on a display (spec §23.5, §23.7). Plain math on Electron's display objects, in DIPs
// (device-independent pixels), so 100 % and 150 % display scale need nothing special. No Electron here: tests
// run it with plain Node.
//   Default: bottom right of the work area (above the taskbar, just left of the tray), clear of Wispr Flow's bar
//   at bottom centre. Dragged near a side edge, it docks to that edge. Remembered per display, relative to its
//   work area, so a resolution or scale change keeps it in the same place.

const SIZE = { width: 380, height: 480 }; // the window: room above the pill for its hint, drift card and panel; the rest is click-through
const MARGIN = 8;
const DOCK_WITHIN = 32; // dropped this close to a side edge: docks to it

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// saved: { dock: 'left' | 'right' | null, x, y } relative to the work area, or undefined (never moved).
function placeBar(display, saved) {
  const wa = display.workArea;
  const maxX = wa.width - SIZE.width - MARGIN;
  const maxY = wa.height - SIZE.height - MARGIN;
  let x = saved?.dock === 'left' ? MARGIN : saved?.dock === 'right' || !saved ? maxX : saved.x;
  let y = saved ? saved.y : maxY;
  x = clamp(x, MARGIN, maxX);
  y = clamp(y, MARGIN, maxY);
  return { x: Math.round(wa.x + x), y: Math.round(wa.y + y), ...SIZE };
}

// After a drag: what to remember for this display, and where the bar goes (docked to an edge it was dropped near).
function dropBar(display, { x, y }) {
  const wa = display.workArea;
  const rx = x - wa.x;
  const ry = y - wa.y;
  const dock = rx < DOCK_WITHIN ? 'left' : rx > wa.width - SIZE.width - DOCK_WITHIN ? 'right' : null;
  const saved = { dock, x: Math.round(rx), y: Math.round(ry) };
  return { saved, bounds: placeBar(display, saved) };
}

module.exports = { placeBar, dropBar, SIZE, MARGIN };

