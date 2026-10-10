// The design tokens and the cat (design spec §3, §4). What a later restyle must not break: every token the
// screens use exists in both themes, text pairs stay readable (WCAG AA, §14), and every cat pose is a single
// currentColor path that themes cleanly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DESIGN = path.join(__dirname, '..', 'app', 'renderer', 'design');
const CAT = path.join(__dirname, '..', 'app', 'assets', 'cat');
const css = fs.readFileSync(path.join(DESIGN, 'tokens.css'), 'utf8');

// The custom properties declared in the first block whose selector matches.
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(start, css.indexOf('\n}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const light = block(':root, [data-theme="light"]');
const dark = block('[data-theme="dark"]');
const root = block(':root');

test('both themes define every token the screens use', () => {
  const needed = ['--bg', '--sidebar', '--surface', '--surface-2', '--border', '--ink', '--ink-2', '--ink-3', '--focus',
    '--working', '--needs', '--stopped', '--done', '--edited', '--cat'];
  for (const t of needed) {
    assert.ok(light[t], `light ${t}`);
    assert.ok(dark[t], `dark ${t}`);
  }
  for (const t of ['--float-bg', '--float-raised', '--float-ink', '--float-ink-2', '--t-display', '--t-body', '--t-mono',
    '--m-quick', '--m-open', '--m-close', '--m-spring', '--r-card', '--r-pill']) {
    assert.ok(root[t], t);
  }
});

test('the system dark theme matches the explicit one', () => {
  const start = css.indexOf('@media (prefers-color-scheme: dark)');
  const system = Object.fromEntries([...css.slice(start).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  assert.deepStrictEqual(system, dark);
});

test('body and status text meet WCAG AA (4.5:1) in both themes', () => {
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['--bg', '--surface']) {
      for (const fg of ['--ink', '--ink-2', '--ink-3', '--working', '--needs', '--stopped', '--done']) {
        const ratio = contrast(t[fg], t[bg]);
        assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.ok(contrast(root['--float-ink'], '#121416') >= 4.5);
  assert.ok(contrast(root['--float-ink-2'], '#121416') >= 4.5);
});

test('every cat pose is one currentColor path with even-odd cut-outs', () => {
  const MewCat = require(path.join(DESIGN, 'cat.js'));
  for (const pose of [...Object.keys(MewCat.POSES), 'face-small']) {
    const svg = fs.readFileSync(path.join(CAT, `cat-${pose}.svg`), 'utf8');
    assert.strictEqual((svg.match(/<path/g) ?? []).length, 1, `${pose}: one path`);
    assert.match(svg, /fill="currentColor"/, pose);
    assert.match(svg, /fill-rule="evenodd"/, pose);
    assert.doesNotMatch(svg, /<script|on\w+=|href="http/i, `${pose}: nothing active inside`);
  }
});

test('the cat picks the small face below 32 px and refuses sizes the spec does not have', () => {
  const MewCat = require(path.join(DESIGN, 'cat.js'));
  assert.strictEqual(MewCat.file('sit', 24), 'cat-face-small.svg');
  assert.strictEqual(MewCat.file('pounce', 96), 'cat-pounce.svg');
  assert.throws(() => MewCat.file('dance', 96), /no such cat pose/);
  assert.throws(() => MewCat.create({ pose: 'sit', size: 100, doc: {} }), /comes in/);
});

test('the bundled fonts and their licences are there', () => {
  for (const f of ['fraunces-latin-full-normal.woff2', 'figtree-latin-wght-normal.woff2', 'jetbrains-mono-latin-wght-normal.woff2',
    'LICENSE-fraunces.txt', 'LICENSE-figtree.txt', 'LICENSE-jetbrains-mono.txt']) {
    assert.ok(fs.statSync(path.join(DESIGN, 'fonts', f)).size > 0, f);
  }
  assert.match(fs.readFileSync(path.join(DESIGN, 'fonts', 'LICENSE-fraunces.txt'), 'utf8'), /SIL Open Font License/);
});
