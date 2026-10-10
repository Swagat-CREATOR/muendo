// Where the dock sits (app/dock-place.js, design spec §11.8): any edge, any display, whole pixels, a smooth snap.
const { test } = require('node:test');
const assert = require('node:assert');
const { CANVAS, CORNER, orientationOf, nearestEdge, fractionAlong, displayFor, place, drop, snapPath, surfaceCentre } = require('../app/dock-place');

// 1920 x 1080 at 100 %, taskbar 48 px at the bottom.
const D1 = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
// The same screen at 150 %: Electron reports it in DIPs.
const D150 = { id: 2, workArea: { x: 0, y: 0, width: 1280, height: 688 } };
// A second monitor to the left, with negative coordinates.
const LEFT = { id: 3, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };

const inside = (b, wa) => b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
const integers = (b) => [b.x, b.y, b.width, b.height].every(Number.isInteger);

test('the shape follows the edge: left and right stand it up, top and bottom lay it down', () => {
  assert.deepStrictEqual(['left', 'right', 'top', 'bottom'].map(orientationOf), ['vertical', 'vertical', 'horizontal', 'horizontal']);
});

test('a drop snaps to the nearest edge of the work area', () => {
  assert.strictEqual(nearestEdge(D1.workArea, { x: 10, y: 500 }), 'left');
  assert.strictEqual(nearestEdge(D1.workArea, { x: 1900, y: 500 }), 'right');
  assert.strictEqual(nearestEdge(D1.workArea, { x: 900, y: 5 }), 'top');
  assert.strictEqual(nearestEdge(D1.workArea, { x: 900, y: 1020 }), 'bottom');
  assert.strictEqual(nearestEdge(LEFT.workArea, { x: -1900, y: 300 }), 'left', 'works with negative coordinates');
});

test('the canvas sits flush on its edge, inside the work area, with whole numbers', () => {
  for (const display of [D1, D150, LEFT]) {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      for (const fraction of [0, 0.5, 1]) {
        const p = place(display, { edge, fraction });
        const wa = display.workArea;
        assert.ok(integers(p.bounds), `${edge} ${fraction}`);
        assert.ok(inside(p.bounds, wa), `${display.id} ${edge} ${fraction}: ${JSON.stringify(p.bounds)}`);
        assert.deepStrictEqual({ width: p.bounds.width, height: p.bounds.height }, CANVAS[p.orientation]);
        const flush = { left: p.bounds.x === wa.x, right: p.bounds.x + p.bounds.width === wa.x + wa.width,
          top: p.bounds.y === wa.y, bottom: p.bounds.y + p.bounds.height === wa.y + wa.height }[edge];
        assert.ok(flush, `${edge} is flush`);
      }
    }
  }
});

test('the surface keeps its spot along the edge, and stays clear of the corners', () => {
  const mid = place(D1, { edge: 'bottom', fraction: 0.5 });
  assert.strictEqual(mid.bounds.x + mid.anchor, 960, 'centred where it was dropped');
  const corner = place(D1, { edge: 'right', fraction: 0 });
  assert.ok(corner.bounds.y + corner.anchor >= D1.workArea.y + CORNER + 100, 'not in the corner');
  const end = place(D1, { edge: 'bottom', fraction: 1 });
  assert.ok(end.bounds.x + end.anchor <= 1920 - CORNER - 80);
  assert.ok(end.anchor > CANVAS.horizontal.width / 2, 'near the right end the surface sits right of the canvas centre');
});

test('the position is remembered as a share of the edge, so scaling keeps it in the same place', () => {
  const at100 = drop(D1, { x: 480, y: 1030 });
  assert.deepStrictEqual([at100.saved.edge, at100.saved.fraction], ['bottom', 0.25]);
  const at150 = place(D150, at100.saved);
  assert.strictEqual(at150.bounds.x + at150.anchor, 320, 'a quarter of the way along, at 150 % too');
});

test('a missing display falls back to the primary, and nothing saved means bottom right', () => {
  assert.strictEqual(displayFor([D1, LEFT], { displayId: 99 }, D1), D1);
  assert.strictEqual(displayFor([D1, LEFT], { displayId: 3 }, D1), LEFT);
  const fresh = place(D1, undefined);
  assert.strictEqual(fresh.edge, 'bottom');
  assert.ok(fresh.bounds.x + fresh.anchor > 1600, 'bottom right');
  const nonsense = place(D1, { edge: 'diagonal', fraction: NaN });
  assert.strictEqual(nonsense.edge, 'bottom');
});

test('the snap moves in whole pixels, never back, and ends exactly on the target', () => {
  const path = snapPath({ x: 700, y: 400 }, { x: 1450, y: 472 });
  assert.ok(path.length >= 10 && path.length <= 23, `${path.length} steps over 180 ms`);
  assert.deepStrictEqual(path[path.length - 1], { x: 1450, y: 472 });
  for (let i = 1; i < path.length; i++) {
    assert.ok(path[i].x >= path[i - 1].x && path[i].y >= path[i - 1].y, 'no back-and-forth steps');
    assert.ok(Number.isInteger(path[i].x) && Number.isInteger(path[i].y));
  }
  assert.deepStrictEqual(snapPath({ x: 5, y: 5 }, { x: 5, y: 5 }), [{ x: 5, y: 5 }]);
});

test('fractions are clamped to the edge', () => {
  assert.strictEqual(fractionAlong(D1.workArea, 'left', { x: 0, y: -50 }), 0);
  assert.strictEqual(fractionAlong(D1.workArea, 'top', { x: 5000, y: 0 }), 1);
});

test('the surface middle, which the eyes measure "near" from, sits against the edge at the anchor', () => {
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const p = place(D1, { edge, fraction: 0.5 });
    const c = surfaceCentre(p.bounds, edge, p.anchor);
    const gap = { left: c.x - 0, right: 1920 - c.x, top: c.y - 0, bottom: 1032 - c.y }[edge];
    assert.strictEqual(gap, 28, edge);
    assert.strictEqual(['left', 'right'].includes(edge) ? c.y : c.x, ['left', 'right'].includes(edge) ? 516 : 960, edge);
  }
});
