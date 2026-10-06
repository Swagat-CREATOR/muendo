// Where the Mewndo bar sits (app/bar-layout.js): at 100 % and 150 % display scale, docking, and a second display.
const { test } = require('node:test');
const assert = require('node:assert');
const { placeBar, dropBar, SIZE, MARGIN } = require('../app/bar-layout');

test('bottom right by default, docks to the side edge it is dropped near, stays on screen: at 100 % and 150 %', () => {
  // 1920x1080 at 100 %: a 40 px taskbar. The same screen at 150 %: 1280x720 DIPs, a 27 DIP taskbar.
  for (const [scale, wa] of [[1, { x: 0, y: 0, width: 1920, height: 1040 }], [1.5, { x: 0, y: 0, width: 1280, height: 693 }]]) {
    const d = { scaleFactor: scale, workArea: wa };
    const home = placeBar(d);
    assert.deepStrictEqual([home.x + home.width + MARGIN, home.y + home.height + MARGIN], [wa.width, wa.height], `bottom right at ${scale}`);
    assert.ok(home.x > wa.width / 2 + 200, "clear of Wispr Flow's bar at bottom centre");
    assert.strictEqual(dropBar(d, { x: 10, y: 300 }).bounds.x, MARGIN, 'docks left');
    assert.strictEqual(dropBar(d, { x: wa.width - SIZE.width - 5, y: 300 }).saved.dock, 'right', 'docks right');
    const free = dropBar(d, { x: 500, y: 300 });
    assert.deepStrictEqual([free.saved.dock, free.bounds.x, free.bounds.y], [null, 500, 300]);
    const lost = placeBar(d, { dock: null, x: 99999, y: -50 });
    assert.ok(lost.x + lost.width <= wa.width && lost.y >= 0, 'kept on screen');
  }
});

test('remembered relative to the work area, so another display (or a resolution change) keeps the spot', () => {
  const left = { workArea: { x: -1280, y: 100, width: 1280, height: 984 } };
  assert.deepStrictEqual(placeBar(left), { x: -1280 + 1280 - SIZE.width - MARGIN, y: 100 + 984 - SIZE.height - MARGIN, ...SIZE });
  const { saved } = dropBar(left, { x: -1270, y: 400 });
  assert.deepStrictEqual(saved, { dock: 'left', x: 10, y: 300 });
  assert.deepStrictEqual(placeBar(left, saved), { x: -1280 + MARGIN, y: 400, ...SIZE });
});
