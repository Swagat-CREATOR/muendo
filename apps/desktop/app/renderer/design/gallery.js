// Draws the design test page (step D2): every token, type size, status ring, keycap and cat pose, once per
// theme, plus the float set. Open design/gallery.html in Electron or a browser.
MewCat.base = '../../assets/cat/'; // this page is one folder deeper than the windows

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const section = (title, ...children) => {
  const s = el('section');
  s.append(el('div', 'h2 label', title), ...children);
  return s;
};
const row = (...children) => { const r = el('div', 'row'); r.append(...children); return r; };

function swatch(token) {
  const s = el('div', 'swatch');
  const b = el('b');
  b.style.background = `var(${token})`;
  s.append(b, el('span', 'small', token));
  return s;
}

function draw(root, theme) {
  root.append(el('h1', 'display', `Hey Swagat, your work is safe. (${theme})`));
  const keys = el('p', 'body');
  keys.append('Undo anything with ', el('span', 'keycap', 'Alt'), ' + ', el('span', 'keycap', 'Shift'), ' + ', el('span', 'keycap', 'Z'));
  root.append(keys);

  root.append(section('Theme', row(...['--bg', '--sidebar', '--surface', '--surface-2', '--border', '--ink', '--ink-2', '--ink-3', '--focus'].map(swatch))));
  root.append(section('Brand', row(...['--ink-brand', '--milk', '--mint', '--mint-ink', '--whisker'].map(swatch))));

  const statuses = [['working', 'Working'], ['needs', 'Needs you'], ['stopped', 'Stopped'], ['done', 'Done'], ['edited', 'Edited']];
  root.append(section('Status (soft fill, ink, ring with its shape)', row(...statuses.map(([k, words]) => {
    const chip = el('span', 'status small');
    chip.style.background = `var(--${k}-soft)`;
    chip.style.color = `var(--${k})`;
    chip.append(el('span', `ring ${k}`), words);
    return chip;
  }), (() => { const c = el('span', 'status small'); c.append(el('span', 'ring'), 'Idle'); return c; })())));

  const type = el('div', 'card');
  for (const [cls, text] of [['display', 'Display 34/42 Fraunces'], ['title', 'Title 28/34 Fraunces'], ['number', '1,284 · 37 · 4 · 2'],
    ['h2', 'Section title 16/22 Figtree 600'], ['body', 'Body 14/21 Figtree: a calm line of interface text, at most 72 characters.'],
    ['small', 'Small 12.5/18 Figtree 500 · 3:52 pm'], ['mono', 'git push --force origin main']]) {
    const p = el('p', cls, text);
    p.style.margin = '0 0 8px';
    if (cls === 'small') p.style.color = 'var(--ink-3)';
    type.append(p);
  }
  root.append(section('Type', type));

  const cats = row(...Object.keys(MewCat.POSES).map((pose) => {
    const c = el('div', 'cell');
    c.append(MewCat.create({ pose, size: 96 }).el, el('span', 'small', pose));
    return c;
  }));
  cats.classList.add('cats');
  const sizes = row(...MewCat.SIZES.map((size) => {
    const c = el('div', 'cell');
    c.append(MewCat.create({ pose: 'face', size }).el, el('span', 'small', `${size}`));
    return c;
  }));
  sizes.classList.add('cats');
  const big = MewCat.create({ pose: 'sit', size: 160, label: 'Watching: everything is protected' });
  const fade = el('button', null, 'Cross-fade the pose');
  const order = Object.keys(MewCat.POSES);
  fade.onclick = () => big.set(order[(order.indexOf(big.pose()) + 1) % order.length]);
  root.append(section('Cat poses (96 px), sizes, and a 160 px cross-fade', cats, sizes, row(big.el, fade)));

  const motion = el('div', 'motion card small');
  motion.append(el('b'), 'Hover: --m-spring');
  motion.querySelector('b').style.transition = 'transform var(--m-spring)';
  root.append(section('Motion', motion));

  const float = el('div', 'float');
  float.append(el('p', 'h2', 'Float set (the same in both themes)'));
  float.append(row(...['working', 'needs', 'stopped', 'done'].map((k) => {
    const c = el('span', 'status small');
    c.append(el('span', `ring ${k}`), k);
    return c;
  })));
  const fk = el('p', 'muted small');
  fk.append('Undo ', el('span', 'keycap', 'Alt'), '+', el('span', 'keycap', 'Shift'), '+', el('span', 'keycap', 'Z'));
  float.append(fk, row(MewCat.create({ pose: 'face', size: 48 }).el, MewCat.create({ pose: 'pounce', size: 96 }).el));
  root.append(section('Float', float));
}

draw(document.getElementById('light'), 'light');
draw(document.getElementById('dark'), 'dark');
