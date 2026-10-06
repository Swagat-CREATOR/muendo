// The Mewndo bar's pill (app/bar.js). Mouse input reaches this window only while the pointer is over the pill;
// everywhere else clicks go through to the app below. Shrinks to a dot after 5 s idle; an alert or hover brings it
// back. Dragged by hand: a press that moves more than 4 px is a drag, otherwise a click.
const pill = document.getElementById('pill');
const IDLE_MS = 5000;
let state = {};
let idle = null;
let pointerOver = false;

function wake() {
  pill.classList.remove('dot');
  clearTimeout(idle);
  idle = setTimeout(() => { if (!pointerOver && !state.alert) pill.classList.add('dot'); }, IDLE_MS);
}

function render() {
  pill.className = `pill ${['protected', 'drift', 'braked'].includes(state.status) ? state.status : ''}`;
  document.body.classList.toggle('left', state.side === 'left');
  const label = state.label || 'Mewndo';
  document.getElementById('protection').setAttribute('aria-label', label);
  pill.title = label;
  const agents = document.getElementById('agents');
  agents.replaceChildren(...(state.agents ?? []).map((a) => {
    const dot = document.createElement('i');
    if (a.braked) dot.className = 'braked';
    dot.title = a.braked ? `${a.name}: braked` : `${a.name} is running`;
    return dot;
  }));
  agents.setAttribute('aria-label', (state.agents ?? []).map((a) => a.name).join(', ') || 'No agents running');
  wake();
}
window.bar.onState((s) => { state = s; render(); });

pill.addEventListener('mouseenter', () => { pointerOver = true; window.bar.mouse(true); wake(); });
pill.addEventListener('mouseleave', () => { pointerOver = false; if (!press) window.bar.mouse(false); wake(); });

let press = null;
pill.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, dragging: false, target: e.target.closest('button') };
  pill.setPointerCapture(e.pointerId);
});
pill.addEventListener('pointermove', (e) => {
  if (!press) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (!press.dragging && Math.hypot(dx, dy) > 4) {
    press.dragging = true;
    pill.classList.add('dragging');
    window.bar.drag({ phase: 'start' });
  }
  if (press.dragging) window.bar.drag({ phase: 'move', dx, dy });
});
pill.addEventListener('pointerup', (e) => {
  if (!press) return;
  const { dragging, target } = press;
  press = null;
  pill.releasePointerCapture(e.pointerId);
  pill.classList.remove('dragging');
  if (dragging) window.bar.drag({ phase: 'end' });
  else if (target && !target.disabled) window.bar.action(target.id);
  if (!pointerOver) window.bar.mouse(false);
});
// Keyboard users (the window never takes focus from a click, but screen readers can still reach the buttons).
pill.addEventListener('keydown', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); window.bar.action(b.id); }
});
wake();
