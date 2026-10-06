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
let closeTimer = null;

function wake() {
  pill.classList.remove('dot');
  clearTimeout(idle);
  idle = setTimeout(() => { if (!overHit && !state.alert && !state.card && !state.ask && !state.holds?.length && !press && !talking) pill.classList.add('dot'); }, IDLE_MS);
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
  renderCard();
  renderAsk();
  renderChips();
  renderPanel();
  $('mic').disabled = !state.voice;
  $('mic').setAttribute('aria-label', state.voice ? 'Hold to talk' : 'Voice commands need Windows');
  if (state.shortcuts) {
    const keys = (k) => el('b', {}, k.replace(/\+/g, ' + '));
    $('keys').replaceChildren('Undo ', keys(state.shortcuts.undo), ' →', el('span', { className: 'sep' }, '·'), 'Brief ', keys(state.shortcuts.brief), ' →');
  }
  wake();
}
window.bar.onState((s) => { state = s; render(); });

// The up-arrow panel. Open: the window may take focus once clicked (bar.js), so Escape and clicking elsewhere close
// it. What it can't do: a click outside before you've clicked inside it can't be seen; press the up-arrow again.
let panelOpen = false;
let tab = 'agents';
const initial = (name) => (name ?? '?').trim()[0]?.toUpperCase() ?? '?';
function setPanel(open) {
  if (open === panelOpen) return;
  panelOpen = open;
  $('panel').setAttribute('aria-expanded', String(open));
  $('box').hidden = !open;
  window.bar.action(open ? 'panel-open' : 'panel-close');
  if (open) renderPanel();
}
function renderPanel() {
  if (!panelOpen) return;
  $('tab-agents').setAttribute('aria-selected', String(tab === 'agents'));
  $('tab-connections').setAttribute('aria-selected', String(tab === 'connections'));
  const p = state.panel;
  if (!p) { $('list').replaceChildren(el('p', { className: 'empty' }, 'Loading…')); return; }
  const rows = tab === 'agents' ? p.agents.map((a) => {
    const row = el('button', { className: 'row-item', title: `${a.name} · ${a.connection}${a.monitoring ? ` · ${a.monitoring}` : ''}` },
      el('span', { className: 'badge' }, initial(a.name)), el('span', {}, a.name), el('span', { className: `state ${a.status}` }, a.status),
      el('span', { className: 'sub' }, [a.connection, a.monitoring, a.now].filter(Boolean).join(' · ')));
    Object.assign(row.dataset, { action: 'lane', arg: a.name });
    return row;
  }) : p.connections.map((c) => {
    const bubbles = el('span', { className: 'bubbles' }, ...c.bubbles.map((b) => {
      const sure = b.confidence === 'exact' ? '' : b.confidence === 'likely' ? ' (likely)' : '';
      const span = el('span', { className: `bubble ${b.confidence} ${b.ago < 1 ? 'active' : ''}`,
        title: b.confidence === 'unknown' ? `Changed ${b.ago} min ago by an unknown app` : `${b.agent}${sure} · ${b.ago} min ago` },
      b.confidence === 'unknown' ? '?' : initial(b.agent));
      return span;
    }));
    const row = el('button', { className: 'row-item', title: c.root }, el('span', { className: 'badge' }, '📁'), el('span', {}, c.name), bubbles,
      el('span', { className: 'sub' }, `${c.protection} · local folder`));
    Object.assign(row.dataset, { action: 'connection', arg: c.root });
    return row;
  });
  $('list').replaceChildren(...(rows.length ? rows : [el('p', { className: 'empty' }, tab === 'agents' ? 'No agents yet.' : 'No folders protected yet.')]));
}
// Buttons handled here, not by the main process (the pointer handlers below call them).
const LOCAL = {
  panel: () => setPanel(!panelOpen),
  'tab-agents': () => { tab = 'agents'; renderPanel(); },
  'tab-connections': () => { tab = 'connections'; renderPanel(); },
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPanel(false); });
window.addEventListener('blur', () => setPanel(false));

// Voice: hold the mic to talk. Records 16 kHz mono and hands a WAV to the main process (speech.js) on release.
const MAX_TALK_MS = 30_000;
let rec = null; // { stream, ctx, chunks } while recording
let talking = false;
async function startTalking() {
  talking = true;
  pill.classList.add('listening');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    ctx.createMediaStreamSource(stream).connect(node);
    node.connect(ctx.destination);
    rec = { stream, ctx, chunks, timer: setTimeout(stopTalking, MAX_TALK_MS) };
    if (!talking) stopTalking(); // let go before the mic was ready
  } catch {
    talking = false;
    pill.classList.remove('listening');
    $('mic').title = 'No microphone: check Windows Settings, Privacy, Microphone.';
  }
}
function wavOf(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (const x of c) { v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true); o += 2; }
  return new Uint8Array(buf);
}
function stopTalking() {
  talking = false;
  pill.classList.remove('listening');
  if (!rec) return;
  const { stream, ctx, chunks, timer } = rec;
  rec = null;
  clearTimeout(timer);
  for (const t of stream.getTracks()) t.stop();
  const rate = ctx.sampleRate;
  ctx.close();
  const samples = chunks.reduce((a, c) => a + c.length, 0);
  if (samples > rate * 0.3) window.bar.voice(wavOf(chunks, rate)); // shorter than 0.3 s: a tap, not speech
}

function renderAsk() {
  const a = state.ask;
  $('ask').hidden = !a;
  if (!a) return;
  $('ask-heard').textContent = a.heard ? `You said “${a.heard}”` : '';
  $('ask-text').textContent = a.text;
  $('ask-choices').replaceChildren(...a.choices.map((label, i) => {
    const b = el('button', { className: `text ${i === 0 && a.choices.length > 1 ? 'primary' : ''}` }, label);
    Object.assign(b.dataset, { action: 'ask-choose', arg: `${a.id}:${i}` });
    return b;
  }));
}

function renderCard() {
  const c = state.card;
  $('card').hidden = !c;
  if (!c) return;
  $('card-tried').textContent = c.tried;
  $('card-did').textContent = c.did;
  for (const b of $('card').querySelectorAll('button')) b.dataset.arg = c.id;
}

// Hold chips: "Delete 3 files · Codex · 0:42", approve or cancel; hold one to cancel them all.
const clock = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function renderChips() {
  $('chips').replaceChildren(...(state.holds ?? []).map((h) => {
    const chip = el('div', { className: 'chip hit' }, el('span', {}, `${h.what} · ${h.agent}`), ' ', el('span', { className: 'time' }, clock(h.expiresAt - Date.now())));
    const ok = el('button', { className: 'ok', title: 'Approve' }, '✓');
    const no = el('button', { className: 'no', title: 'Cancel · Hold: cancel all' }, '✕');
    ok.setAttribute('aria-label', `Approve: ${h.what}`);
    no.setAttribute('aria-label', `Cancel: ${h.what}`);
    Object.assign(ok.dataset, { action: 'hold-approve', arg: h.id });
    Object.assign(no.dataset, { action: 'hold-cancel', long: 'hold-cancel-all', arg: h.id });
    chip.append(ok, no);
    return chip;
  }));
}
setInterval(() => { if (state.holds?.length) renderChips(); }, 1000);

// Take the mouse only over .hit elements (the window gets mouse moves even while it lets clicks through).
document.addEventListener('mousemove', (e) => {
  const hit = !!e.target.closest?.('.hit');
  const onPill = !!e.target.closest?.('.pill, .hint');
  if (hit !== overHit && !press) { overHit = hit; window.bar.mouse(hit); }
  // Closing waits a moment, so the pointer can cross the gap between the pill and its hint.
  clearTimeout(closeTimer);
  if (onPill && !overPill) { overPill = true; setOpen(true); wake(); }
  else if (!onPill && overPill) closeTimer = setTimeout(() => { overPill = false; setOpen(false); wake(); }, 250);
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
  const mic = target?.id === 'mic' && !target.disabled;
  press = { x: e.screenX, y: e.screenY, dragging: false, long: false, target, onPill: !mic && !!e.target.closest('.pill'), mic };
  if (mic) startTalking();
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
  const { dragging, long, target, timer, mic } = press;
  clearTimeout(timer);
  press = null;
  if (document.body.hasPointerCapture(e.pointerId)) document.body.releasePointerCapture(e.pointerId);
  pill.classList.remove('dragging');
  if (mic) stopTalking();
  else if (dragging) window.bar.drag({ phase: 'end' });
  else if (!long && target && !target.disabled && LOCAL[target.id]) LOCAL[target.id]();
  else if (!long && target && !target.disabled && target.dataset.action) window.bar.action(target.dataset.action, target.dataset.arg);
  const hit = !!document.elementFromPoint(e.clientX, e.clientY)?.closest('.hit');
  if (hit !== overHit) { overHit = hit; window.bar.mouse(hit); }
  wake();
});
// Keyboard and screen readers (the window never takes focus from a click, but assistive tech can reach buttons).
document.addEventListener('keydown', (e) => {
  const b = e.target.closest?.('button');
  if (b && !b.disabled && (LOCAL[b.id] || b.dataset.action) && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    if (LOCAL[b.id]) LOCAL[b.id]();
    else window.bar.action(b.dataset.action, b.dataset.arg);
  }
});
wake();
