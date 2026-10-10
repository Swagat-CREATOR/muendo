// Where the floating dock sits (design spec §11.8): on any edge of any display, wherever it was dropped. Plain math
// on Electron's display objects, in DIPs, so 100 %, 125 % and 150 % scaling need nothing special; no Electron here,
// so tests run it with plain Node.
//
// The window is a fixed-size transparent canvas, created once at the size of its largest state for its orientation
// (§11.8 "Jitter: required implementation" 1). It only changes size when the orientation changes, on a drop onto a
// different kind of edge, never on hover. Inside it, the renderer puts the pill or dock against the edge side at
// `anchor` px along the edge, and opens everything else toward the middle of the screen.
//
//   saved = { displayId, edge: 'left' | 'right' | 'top' | 'bottom', fraction: 0..1 along that edge }

// The canvas per orientation: room for the hover row, the drift card, holds and the 360 x 440 panel, opening toward
// the middle, plus the transparent padding the CSS shadow needs.
const CANVAS = {
  horizontal: { width: 520, height: 560 },
  vertical: { width: 470, height: 600 },
};
const CORNER = 12; // the surface keeps at least this far from a work-area corner (§11.8 Drop)
// Half the surface along its edge, so a drop near a corner still keeps the whole pill or dock on screen.
const HALF = { horizontal: 80, vertical: 110 };
const DEFAULT = { edge: 'bottom', fraction: 0.92 }; // bottom right, clear of Wispr Flow's bar at bottom centre

const EDGES = ['left', 'right', 'top', 'bottom'];
const orientationOf = (edge) => (edge === 'left' || edge === 'right' ? 'vertical' : 'horizontal');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// The edge of the work area nearest to a point (where the pointer was let go).
function nearestEdge(wa, p) {
  const d = {
    left: p.x - wa.x,
    right: wa.x + wa.width - p.x,
    top: p.y - wa.y,
    bottom: wa.y + wa.height - p.y,
  };
  return EDGES.reduce((best, e) => (d[e] < d[best] ? e : best), 'bottom');
}

// How far along that edge the point is, as a share of the edge: what survives a resolution or scaling change.
function fractionAlong(wa, edge, p) {
  const f = orientationOf(edge) === 'vertical' ? (p.y - wa.y) / wa.height : (p.x - wa.x) / wa.width;
  return clamp(Number.isFinite(f) ? f : DEFAULT.fraction, 0, 1);
}

// The display the dock belongs on: the saved one if it is still connected, otherwise the primary (§11.8 Memory).
function displayFor(displays, saved, primary) {
  return displays.find((d) => d.id === saved?.displayId) ?? primary;
}

// The window's bounds, and where the surface sits inside it. Whole numbers only (§11.8 step 3).
function place(display, saved) {
  const edge = EDGES.includes(saved?.edge) ? saved.edge : DEFAULT.edge;
  const fraction = Number.isFinite(saved?.fraction) ? clamp(saved.fraction, 0, 1) : DEFAULT.fraction;
  const orientation = orientationOf(edge);
  const { width, height } = CANVAS[orientation];
  const wa = display.workArea;
  const vertical = orientation === 'vertical';
  const start = vertical ? wa.y : wa.x;
  const length = vertical ? wa.height : wa.width;
  const canvasLength = vertical ? height : width;
  const half = HALF[orientation];

  // The surface's centre along the edge, kept clear of the corners; then the canvas around it, kept on screen.
  const centre = clamp(start + fraction * length, start + CORNER + half, start + length - CORNER - half);
  const canvasStart = clamp(centre - canvasLength / 2, start, start + length - canvasLength);
  const along = Math.round(canvasStart);
  const anchor = Math.round(centre - along);

  const across = {
    left: wa.x,
    right: wa.x + wa.width - width,
    top: wa.y,
    bottom: wa.y + wa.height - height,
  }[edge];
  const bounds = vertical
    ? { x: Math.round(across), y: along, width, height }
    : { x: along, y: Math.round(across), width, height };
  return { bounds, edge, orientation, anchor, saved: { displayId: display.id, edge, fraction } };
}

// The middle of the pill or dock in screen coordinates: what "near the dock" is measured from (§11.9).
const ACROSS = 28; // 8 px gap to the edge plus half the 40 px surface
function surfaceCentre(bounds, edge, anchor) {
  return {
    bottom: { x: bounds.x + anchor, y: bounds.y + bounds.height - ACROSS },
    top: { x: bounds.x + anchor, y: bounds.y + ACROSS },
    left: { x: bounds.x + ACROSS, y: bounds.y + anchor },
    right: { x: bounds.x + bounds.width - ACROSS, y: bounds.y + anchor },
  }[edge];
}

// Where a window that opens from the dock goes (§11.8 step 5): beside the surface, toward the middle of the screen,
// `gap` px clear of it, centred on it along the edge and kept inside the work area.
function beside(bounds, edge, anchor, wa, size, gap = 12) {
  const c = surfaceCentre(bounds, edge, anchor);
  const off = ACROSS + gap;
  const clampX = (x) => Math.round(clamp(x, wa.x + 8, wa.x + wa.width - size.width - 8));
  const clampY = (y) => Math.round(clamp(y, wa.y + 8, wa.y + wa.height - size.height - 8));
  const p = {
    right: { x: c.x - off - size.width, y: c.y - size.height / 2 },
    left: { x: c.x + off, y: c.y - size.height / 2 },
    bottom: { x: c.x - size.width / 2, y: c.y - off - size.height },
    top: { x: c.x - size.width / 2, y: c.y + off },
  }[edge];
  return { x: clampX(p.x), y: clampY(p.y), width: size.width, height: size.height };
}

// After a drop: the edge and position the pointer was released nearest to, on the display under it.
function drop(display, pointer) {
  const edge = nearestEdge(display.workArea, pointer);
  return place(display, { edge, fraction: fractionAlong(display.workArea, edge, pointer) });
}

// The snap (§11.8 step 4): whole-pixel steps every 8 ms over 180 ms, easing out, never the same point twice.
function snapPath(from, to, { ms = 180, step = 8 } = {}) {
  const out = [];
  const frames = Math.max(1, Math.round(ms / step));
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const k = 1 - (1 - t) ** 3;
    const p = { x: Math.round(from.x + (to.x - from.x) * k), y: Math.round(from.y + (to.y - from.y) * k) };
    const last = out[out.length - 1] ?? from;
    if (p.x !== last.x || p.y !== last.y) out.push(p);
  }
  const end = out[out.length - 1];
  if (!end || end.x !== to.x || end.y !== to.y) out.push({ x: to.x, y: to.y });
  return out;
}

module.exports = { CANVAS, CORNER, DEFAULT, EDGES, orientationOf, nearestEdge, fractionAlong, displayFor, place, drop, snapPath, surfaceCentre, beside };
