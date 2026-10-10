// The pill standing up as the side dock (app/dock-layout.js): the orientation switch at 2 agents and at a 24 px
// edge drag, and where the strip, the card stack and the Talk box go (spec §33.1, §33.10 Part E steps 2 and 3).
// Plain math on Electron display objects, in DIPs, so no Electron is needed here.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DOCK_WIDTH, EDGE_WITHIN, FLYOUT_WIDTH, SLOT, CARDS_WIDTH, TALK_HEIGHT, DOCK_SLOTS,
  orientationFor, dockHeight, placeDock, dockStrip, dropEdge, placeCards, placeTalk,
} = require('../app/dock-layout');
const { placeBar, SIZE: BAR_SIZE, MARGIN } = require('../app/bar-layout');

// 1920x1080 at 100 % with a 40 px taskbar, and the same screen at 150 % (1280x720 DIPs).
const SCREENS = [
  ['100 %', { scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
  ['150 %', { scaleFactor: 1.5, workArea: { x: 0, y: 0, width: 1280, height: 693 } }],
];
const [, display] = SCREENS[0];

test('the dock is 44 px wide with the §33.1 slots, top to bottom', () => {
  assert.strictEqual(DOCK_WIDTH, 44);
  assert.strictEqual(SLOT, 44);
  assert.deepStrictEqual(DOCK_SLOTS, ['inbox', 'agents', 'talk', 'shield', 'more']);
  assert.strictEqual(CARDS_WIDTH, 360, 'cards fly out 360 px wide (§33.1)');
  assert.strictEqual(EDGE_WITHIN, 24, 'dragged within 24 px of a side edge (Part E step 3)');
});

test('the orientation switch: horizontal with 0 or 1 agents, vertical from 2', () => {
  // "When two or more agents are connected… it stands up as a vertical side dock" (§33.1).
  assert.strictEqual(orientationFor({ agents: 0 }), 'horizontal');
  assert.strictEqual(orientationFor({ agents: 1 }), 'horizontal', 'one agent is still the v0 pill');
  assert.strictEqual(orientationFor({ agents: 2 }), 'vertical', 'two agents stand it up');
  assert.strictEqual(orientationFor({ agents: 7 }), 'vertical');
  // An edge the user chose by dragging wins, whatever the agent count.
  assert.strictEqual(orientationFor({ agents: 0, saved: { edge: 'left' } }), 'vertical');
  assert.strictEqual(orientationFor({ agents: 0, saved: { edge: 'right' } }), 'vertical');
  // Dropped away from both edges (edge null) and only one agent: back to the pill.
  assert.strictEqual(orientationFor({ agents: 1, saved: { edge: null, dock: 'right', x: 500, y: 100 } }), 'horizontal');
  assert.strictEqual(orientationFor({ agents: 2, saved: { edge: null } }), 'vertical', 'two agents still stand it up');
  assert.strictEqual(orientationFor({}), 'horizontal', 'no arguments at all: the v0 pill');
});

test('a 24 px edge drag is what remembers an edge; a 25 px one does not', () => {
  for (const [name, d] of SCREENS) {
    const wa = d.workArea;
    const width = DOCK_WIDTH + FLYOUT_WIDTH;
    // The window's left edge, measured from the work area's left edge.
    assert.strictEqual(dropEdge(d, { x: wa.x, y: 300 }), 'left', `${name}: flush left`);
    assert.strictEqual(dropEdge(d, { x: wa.x + EDGE_WITHIN, y: 300 }), 'left', `${name}: exactly 24 px is near enough`);
    assert.strictEqual(dropEdge(d, { x: wa.x + EDGE_WITHIN + 1, y: 300 }), null, `${name}: 25 px is not`);
    // The right edge is measured from the window's right-hand side.
    const flush = wa.x + wa.width - width;
    assert.strictEqual(dropEdge(d, { x: flush, y: 300 }), 'right', `${name}: flush right`);
    assert.strictEqual(dropEdge(d, { x: flush - EDGE_WITHIN, y: 300 }), 'right', `${name}: exactly 24 px`);
    assert.strictEqual(dropEdge(d, { x: flush - EDGE_WITHIN - 1, y: 300 }), null, `${name}: 25 px is not`);
    // Dropped in the middle: no edge, so the pill stays a pill.
    assert.strictEqual(dropEdge(d, { x: wa.x + Math.round(wa.width / 2), y: 300 }), null, `${name}: the middle`);
  }
});

test('a drag of a narrower window measures that window\'s own right-hand edge', () => {
  // The strip is what the user sees and grabs, so a caller may pass its width instead of the whole window's.
  const wa = display.workArea;
  const atRight = wa.x + wa.width - DOCK_WIDTH;
  assert.strictEqual(dropEdge(display, { x: atRight, y: 0 }, { width: DOCK_WIDTH }), 'right');
  // The same drop with the full window width hangs 360 px off the screen, which is nearer the right edge still,
  // not further from it: overshooting an edge docks to it.
  assert.strictEqual(dropEdge(display, { x: atRight, y: 0 }), 'right');
  // A window that is wider than the work area is near both edges; left is checked first and wins.
  const huge = { workArea: { x: 0, y: 0, width: 300, height: 700 } };
  assert.strictEqual(dropEdge(huge, { x: 0, y: 0 }), 'left');
});

test('a partial saved spot (an edge but no position) still gives a real window, never NaN', () => {
  // Standing the dock up by dragging remembers only the edge. If the agent count then drops and the caller asks
  // for the horizontal pill, there is no saved x or y to place it by.
  for (const saved of [{ edge: 'right' }, { edge: 'left' }, { dock: 'left' }, {}]) {
    const bounds = placeDock(display, saved, { agents: 1, orientation: 'horizontal' });
    for (const k of ['x', 'y', 'width', 'height']) {
      assert.ok(Number.isFinite(bounds[k]), `${JSON.stringify(saved)}: ${k} is ${bounds[k]}`);
    }
    assert.ok(bounds.y + bounds.height <= display.workArea.y + display.workArea.height, 'on screen');
  }
  assert.strictEqual(placeDock(display, { edge: 'left' }, { agents: 1, orientation: 'horizontal' }).x, MARGIN, 'the side is kept');
});

test('horizontal is exactly the v0 pill\'s window, unchanged', () => {
  for (const [name, d] of SCREENS) {
    const saved = { dock: 'right', x: 10, y: 20, edge: null };
    const bounds = placeDock(d, saved, { agents: 1 });
    const pill = placeBar(d, saved);
    assert.deepStrictEqual(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      pill,
      `${name}: the v0 pill is not moved or resized by the dock code`,
    );
    assert.strictEqual(bounds.orientation, 'horizontal');
  }
});

test('vertical: against the remembered edge, vertically centred, tall enough for its slots', () => {
  for (const [name, d] of SCREENS) {
    const wa = d.workArea;
    const width = DOCK_WIDTH + FLYOUT_WIDTH;
    const right = placeDock(d, { edge: 'right' }, { agents: 3 });
    assert.strictEqual(right.orientation, 'vertical');
    assert.strictEqual(right.edge, 'right');
    assert.strictEqual(right.width, width, `${name}: the strip plus room for its flyouts`);
    assert.strictEqual(right.x + right.width, wa.x + wa.width, `${name}: flush with the right edge`);
    assert.strictEqual(right.height, dockHeight(3));
    // Vertically centred: the gap above equals the gap below, to within the rounding of one pixel.
    const above = right.y - wa.y;
    const below = wa.y + wa.height - (right.y + right.height);
    assert.ok(Math.abs(above - below) <= 1, `${name}: centred (${above} vs ${below})`);
    const left = placeDock(d, { edge: 'left' }, { agents: 3 });
    assert.strictEqual(left.x, wa.x, `${name}: flush with the left edge`);
    assert.strictEqual(left.edge, 'left');
  }
});

test('the default side is the right edge, and a v0 left dock is honoured', () => {
  // "default: right edge, vertically centred" (§33.1).
  assert.strictEqual(placeDock(display, undefined, { agents: 2 }).edge, 'right');
  // A pill the user had docked left in v0 stands up on the left, rather than jumping across the screen.
  assert.strictEqual(placeDock(display, { dock: 'left', x: 8, y: 400 }, { agents: 2 }).edge, 'left');
  assert.strictEqual(placeDock(display, { dock: 'right', x: 8, y: 400 }, { agents: 2 }).edge, 'right');
});

test('the strip grows one slot per agent and is kept inside the work area', () => {
  // Four fixed slots (Inbox, Talk, Shield, ⋯) plus the agent column, which is at least one slot tall.
  assert.strictEqual(dockHeight(0), 5 * SLOT + 24, 'an empty agent column still takes one slot');
  assert.strictEqual(dockHeight(1), dockHeight(0));
  assert.strictEqual(dockHeight(2), dockHeight(1) + SLOT);
  assert.strictEqual(dockHeight(9), dockHeight(1) + 8 * SLOT);
  // Twenty agents is taller than a laptop screen: the window is clamped to the work area, not pushed off it.
  const small = { workArea: { x: 0, y: 0, width: 1366, height: 700 } };
  const many = placeDock(small, { edge: 'right' }, { agents: 40 });
  assert.ok(many.height <= small.workArea.height - MARGIN * 2, `clamped (${many.height})`);
  assert.ok(many.y >= small.workArea.y, 'still on screen');
});

test('the strip is the 44 px part against the edge; the rest of the window is click-through', () => {
  const right = placeDock(display, { edge: 'right' }, { agents: 2 });
  const strip = dockStrip(right);
  assert.deepStrictEqual(strip, { x: right.x + right.width - DOCK_WIDTH, y: right.y, width: DOCK_WIDTH, height: right.height });
  assert.strictEqual(strip.x + strip.width, display.workArea.x + display.workArea.width, 'hugs the edge');
  const left = placeDock(display, { edge: 'left' }, { agents: 2 });
  assert.deepStrictEqual(dockStrip(left), { x: left.x, y: left.y, width: DOCK_WIDTH, height: left.height });
  // Horizontal: the v0 pill sits at the bottom of its taller window (bar.css).
  const flat = placeDock(display, { dock: 'right' }, { agents: 1 });
  const bottom = dockStrip(flat);
  assert.deepStrictEqual(bottom, { x: flat.x, y: flat.y + flat.height - SLOT, width: flat.width, height: SLOT });
});

test('the card stack: 360 px beside the dock, on the far side from the edge, inside the work area', () => {
  for (const [name, d] of SCREENS) {
    const wa = d.workArea;
    const right = placeDock(d, { edge: 'right' }, { agents: 2 });
    const cards = placeCards(d, right);
    assert.strictEqual(cards.width, CARDS_WIDTH);
    assert.strictEqual(cards.x + cards.width, dockStrip(right).x, `${name}: to the left of a right-hand dock`);
    assert.strictEqual(cards.y, right.y, `${name}: level with the top of the strip`);
    const left = placeDock(d, { edge: 'left' }, { agents: 2 });
    assert.strictEqual(placeCards(d, left).x, dockStrip(left).x + DOCK_WIDTH, `${name}: to the right of a left-hand dock`);
    // A stack taller than the screen is clamped, never drawn off the bottom.
    const tall = placeCards(d, right, { height: 10_000 });
    assert.ok(tall.y >= wa.y && tall.y + tall.height <= wa.y + wa.height, `${name}: kept on screen`);
  }
});

test('the card stack above the pill when the dock is still horizontal', () => {
  const flat = placeDock(display, { dock: 'right' }, { agents: 1 });
  const cards = placeCards(display, flat, { height: 420 });
  assert.ok(cards.y + cards.height <= dockStrip(flat).y, 'above the pill, not over it');
  assert.ok(cards.x >= display.workArea.x, 'on screen');
});

test('the Talk box: one line above the dock, beside it, inside the work area', () => {
  for (const [name, d] of SCREENS) {
    const wa = d.workArea;
    const right = placeDock(d, { edge: 'right' }, { agents: 2 });
    const talk = placeTalk(d, right);
    assert.strictEqual(talk.height, TALK_HEIGHT);
    assert.strictEqual(TALK_HEIGHT, 56);
    assert.ok(talk.y + talk.height <= dockStrip(right).y, `${name}: above the strip`);
    assert.ok(talk.x + talk.width <= wa.x + wa.width && talk.x >= wa.x, `${name}: on screen`);
    const left = placeTalk(d, placeDock(d, { edge: 'left' }, { agents: 2 }));
    assert.ok(left.x >= wa.x, `${name}: on screen on the left edge too`);
    assert.ok(left.x > wa.x, `${name}: beside the strip, not under it`);
  }
  // On a narrow screen the box is squeezed rather than pushed off the edge.
  const narrow = { workArea: { x: 0, y: 0, width: 300, height: 700 } };
  const squeezed = placeTalk(narrow, placeDock(narrow, { edge: 'right' }, { agents: 2 }));
  assert.ok(squeezed.width <= 300 - MARGIN * 2, `squeezed (${squeezed.width})`);
  assert.ok(squeezed.width <= BAR_SIZE.width, 'never wider than the v0 pill\'s window');
});

test('a second display: the dock stands on that display\'s own edge, not the primary one\'s', () => {
  const secondary = { workArea: { x: -1280, y: 100, width: 1280, height: 984 } };
  const right = placeDock(secondary, { edge: 'right' }, { agents: 2 });
  assert.strictEqual(right.x + right.width, -1280 + 1280, 'the left-hand display\'s right edge');
  const left = placeDock(secondary, { edge: 'left' }, { agents: 2 });
  assert.strictEqual(left.x, -1280);
  assert.ok(left.y >= 100, 'inside that display\'s work area');
  assert.strictEqual(dropEdge(secondary, { x: -1275, y: 300 }), 'left', 'a drag is measured against that display');
});
