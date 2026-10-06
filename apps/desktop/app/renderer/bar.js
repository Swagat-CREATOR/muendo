// The Mewndo bar (app/bar.js). Mouse input reaches this window only while the pointer is over an element marked
// .hit; everywhere else clicks go through to the app below. Resting: protection dot, agent dots, mic, up-arrow.
// Hover: the shortcuts hint, the change ticker (−deleted ~edited +created since the last save point) and Undo last,
// Brake, Save point. Shrinks to a dot after 5 s idle; an alert or hover brings it back.
// Pointer: a press that moves more than 4 px drags the bar; held 600 ms on a [data-long] element it's a long-press
// (agent dot: brake it; ticker: undo that burst); otherwise it's a tap ([data-action]).
const $ = (id) => document.getElementById(id);
const pill = $('pill');
const IDLE_MS = 5000;
const LONG_MS = 600;
let state = {};
let idle = null;
let overHit = false;
let overPill = false;

function wake() {
  pill.classList.remove('dot');
  clearTimeout(idle);
  idle = setTimeout(() => { if (!overHit && !state.alert && !press) pill.classList.add('dot'); }, IDLE_MS);
}

function setOpen(open) {
  pill.classList.toggle('open', open);
  $('hint').hidden = !open || !state.shortcuts;
}

function el(tag, props, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function render() {
  pill.className = `pill hit ${['protected', 'drift', 'braked'].includes(state.status) ? state.status : ''}`;
  setOpen(overPill);
  document.body.classList.toggle('left', state.side === 'left');
  const label = state.label || 'Mewndo';
  $('protection').setAttribute('aria-label', label);
  $('protection').title = label;

  $('agents').replaceChildren(...(state.agents ?? []).map((a) => {
    const what = a.braked ? 'braked' : a.drift ? 'went outside its brief' : 'running';
    const b = el('button', { className: `agent ${a.braked ? 'braked' : a.drift ? 'drift' : ''}`, title: `${a.name}: ${what} · Tap: details · Hold: brake` });
    b.setAttribute('aria-label', `${a.name}, ${what}`);
    Object.assign(b.dataset, { action: 'lane', long: 'brake-agent', arg: a.name });
    return b;
  }));

  const t = state.ticker;
  $('ticker').hidden = !t;
  if (t) {
    $('ticker').dataset.arg = t.root;
    $('ticker').replaceChildren(el('span', { className: 'del' }, `−${t.deleted}`), ' ', el('span', { className: 'mod' }, `~${t.edited}`), ' ',
      el('span', { className: 'add' }, `+${t.created}`));
    $('ticker').setAttribute('aria-label', `Since the last save point in ${t.name}: ${t.deleted} deleted, ${t.edited} edited, ${t.created} created`);
  }
  $('brake').hidden = !(state.agents ?? []).some((a) => !a.braked);
  if (state.shortcuts) {
    $('hint').replaceChildren('Undo ', el('kbd', {}, state.shortcuts.undo), '  ·  Brief ', el('kbd', {}, state.shortcuts.brief));
  }
  wake();
}
window.bar.onState((s) => { state = s; render(); });

// Take the mouse only over .hit elements (the window gets mouse moves even while it lets clicks through).
document.addEventListener('mousemove', (e) => {
  const hit = !!e.target.closest?.('.hit');
  const onPill = !!e.target.closest?.('.pill, .hint');
  if (hit !== overHit && !press) { overHit = hit; window.bar.mouse(hit); }
  if (onPill !== overPill) { overPill = onPill; setOpen(onPill); wake(); }
});
document.addEventListener('mouseleave', () => {
  if (press) return;
  overHit = false;
  overPill = false;
  window.bar.mouse(false);
  setOpen(false);
  wake();
});

let press = null;
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.target.closest('.hit')) return;
  const target = e.target.closest('button');
  press = { x: e.screenX, y: e.screenY, dragging: false, long: false, target, onPill: !!e.target.closest('.pill') };
  if (target?.dataset.long) {
    press.timer = setTimeout(() => {
      if (!press || press.dragging) return;
      press.long = true;
      window.bar.action(target.dataset.long, target.dataset.arg);
    }, LONG_MS);
  }
  document.body.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!press || !press.onPill) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (!press.dragging && Math.hypot(dx, dy) > 4) {
    press.dragging = true;
    clearTimeout(press.timer);
    pill.classList.add('dragging');
    window.bar.drag({ phase: 'start' });
  }
  if (press.dragging) window.bar.drag({ phase: 'move', dx, dy });
});
document.addEventListener('pointerup', (e) => {
  if (!press) return;
  const { dragging, long, target, timer } = press;
  clearTimeout(timer);
  press = null;
  if (document.body.hasPointerCapture(e.pointerId)) document.body.releasePointerCapture(e.pointerId);
  pill.classList.remove('dragging');
  if (dragging) window.bar.drag({ phase: 'end' });
  else if (!long && target && !target.disabled && target.dataset.action) window.bar.action(target.dataset.action, target.dataset.arg);
  const hit = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('.hit');
  if (hit !== overHit) { overHit = hit; window.bar.mouse(hit); }
  wake();
});
// Keyboard and screen readers (the window never takes focus from a click, but assistive tech can reach buttons).
document.addEventListener('keydown', (e) => {
  const b = e.target.closest?.('button');
  if (b && !b.disabled && b.dataset.action && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    window.bar.action(b.dataset.action, b.dataset.arg);
  }
});
wake();
