// The pill and the side dock are one surface with two docking modes (spec §33.1, §33.10 Part E steps 2 and 3).
// Plain math on Electron's display objects, in DIPs, like bar-layout.js; no Electron, so tests run it with plain
// Node.
//   Horizontal: the v0 pill above the taskbar, bottom right (bar-layout.js). Unchanged.
//   Vertical: a 44 px strip against a side edge, vertically centred, with the slots of §33.1 top to bottom.
// It stands up when two or more agents are connected, or when the user drags it within 24 px of a side edge; the
// edge is remembered per display, next to the v0 bar position.
//
// The window is wider than the strip, as the v0 pill's window is wider than the pill: the rest is transparent and
// clicks pass through it (bar.js `setIgnoreMouseEvents`), which is where the hint, the drift card and the §23.8
// panel open. `dockStrip` is the 44 px part that takes the mouse.
const { placeBar, SIZE: BAR_SIZE, MARGIN } = require('./bar-layout');

const DOCK_WIDTH = 44; // the strip itself (§33.1)
const EDGE_WITHIN = 24; // dragged this close to a side edge: stand up on that edge (§33.10 Part E step 3)
const FLYOUT_WIDTH = 360; // room beside the strip for the panel and cards, the same width as the card stack
const SLOT = 44; // one dock slot: Inbox, Talk, Shield, ⋯ and one per agent
const DOCK_PADDING = 12;
const CARDS_WIDTH = 360; // the card stack, to the left of the dock (§33.1)
const TALK_HEIGHT = 56; // the one-line Talk input (§33.5)

// Top to bottom (§33.1). The agent column grows with the number of connected agents.
const DOCK_SLOTS = ['inbox', 'agents', 'talk', 'shield', 'more'];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// saved: { dock: 'left' | 'right' | null, x, y, edge: 'left' | 'right' | null } for this display. agents: how many
// are connected. An edge the user chose by dragging wins; otherwise two agents stand it up on the remembered side
// (default right, as §33.1 says).
function orientationFor({ agents = 0, saved } = {}) {
  return (saved?.edge || agents >= 2) ? 'vertical' : 'horizontal';
}

const edgeOf = (saved) => (saved?.edge === 'left' || (!saved?.edge && saved?.dock === 'left') ? 'left' : 'right');

// placeBar reads { dock, x, y } and has no default for a missing x or y: a saved object holding only an edge --
// which is all that is remembered when the user stands the dock up by dragging it there -- would give NaN bounds
// and an invisible window. Fill in the v0 pill's own default spot instead, keeping whichever side was remembered.
function barSaved(display, saved) {
  if (!saved) return undefined;
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  const wa = display.workArea;
  return {
    dock: saved.dock ?? saved.edge ?? null,
    x: wa.width - BAR_SIZE.width - MARGIN,
    y: wa.height - BAR_SIZE.height - MARGIN,
  };
}

// How tall the strip is for this many agents: the four fixed slots plus the agent column.
function dockHeight(agents = 0) {
  return (DOCK_SLOTS.length - 1 + Math.max(1, agents)) * SLOT + DOCK_PADDING * 2;
}

// The window's bounds. Vertical: tall enough for the strip, wide enough for the strip plus its flyouts, against
// the remembered edge of this display's work area, vertically centred. Horizontal: exactly the v0 pill's window.
function placeDock(display, saved, { agents = 0, orientation = orientationFor({ agents, saved }) } = {}) {
  if (orientation !== 'vertical') return { ...placeBar(display, barSaved(display, saved)), orientation: 'horizontal', edge: edgeOf(saved) };
  const wa = display.workArea;
  const edge = edgeOf(saved);
  const width = DOCK_WIDTH + FLYOUT_WIDTH;
  const height = clamp(dockHeight(agents), SLOT, wa.height - MARGIN * 2);
  const x = edge === 'left' ? wa.x : wa.x + wa.width - width;
  const y = wa.y + Math.round((wa.height - height) / 2);
  return { x: Math.round(x), y: Math.round(y), width, height, orientation: 'vertical', edge };
}

// The part of the window that takes the mouse: the 44 px strip hugging the edge. Everything else is click-through.
function dockStrip(bounds) {
  if (bounds.orientation !== 'vertical') {
    // The v0 pill sits at the bottom of its window, its own width (bar.css), against the dropped side.
    return { x: bounds.x, y: bounds.y + bounds.height - SLOT, width: bounds.width, height: SLOT };
  }
  const x = bounds.edge === 'left' ? bounds.x : bounds.x + bounds.width - DOCK_WIDTH;
  return { x, y: bounds.y, width: DOCK_WIDTH, height: bounds.height };
}

// After a drag: the edge to remember, or null when it was dropped away from both side edges. point: the window's
// top left, size: the window's size (the strip is what the user sees, so its own edge is what counts).
function dropEdge(display, { x, y }, { width = DOCK_WIDTH + FLYOUT_WIDTH } = {}) {
  const wa = display.workArea;
  if (x - wa.x <= EDGE_WITHIN) return 'left';
  if (wa.x + wa.width - (x + width) <= EDGE_WITHIN) return 'right';
  return null;
}

// The card stack: 360 px wide, beside the dock, newest on top (§33.1). Left of the dock, or right of it when the
// dock stands on the left edge. Kept inside the work area.
function placeCards(display, bounds, { height = 420 } = {}) {
  const wa = display.workArea;
  const strip = dockStrip(bounds);
  const h = clamp(height, 80, wa.height - MARGIN * 2);
  const x = bounds.edge === 'left' ? strip.x + strip.width : strip.x - CARDS_WIDTH;
  const y = bounds.orientation === 'vertical' ? strip.y : strip.y - h - MARGIN;
  return {
    x: Math.round(clamp(x, wa.x, wa.x + wa.width - CARDS_WIDTH)),
    y: Math.round(clamp(y, wa.y + MARGIN, wa.y + wa.height - h - MARGIN)),
    width: CARDS_WIDTH,
    height: h,
  };
}

// The Talk box: one line, above the dock (§33.10 Part E step 2).
function placeTalk(display, bounds) {
  const wa = display.workArea;
  const strip = dockStrip(bounds);
  const width = clamp(BAR_SIZE.width, 240, wa.width - MARGIN * 2);
  const x = bounds.edge === 'left' ? strip.x + strip.width + MARGIN : strip.x - width - MARGIN;
  const y = bounds.orientation === 'vertical' ? strip.y - TALK_HEIGHT - MARGIN : strip.y - TALK_HEIGHT - MARGIN;
  return {
    x: Math.round(clamp(x, wa.x + MARGIN, wa.x + wa.width - width - MARGIN)),
    y: Math.round(clamp(y, wa.y + MARGIN, wa.y + wa.height - TALK_HEIGHT - MARGIN)),
    width,
    height: TALK_HEIGHT,
  };
}

module.exports = {
  DOCK_WIDTH, EDGE_WITHIN, FLYOUT_WIDTH, SLOT, CARDS_WIDTH, TALK_HEIGHT, DOCK_SLOTS,
  orientationFor, dockHeight, placeDock, dockStrip, dropEdge, placeCards, placeTalk,
};
