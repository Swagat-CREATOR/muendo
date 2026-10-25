// The Agent Inbox card stack (spec §33.2, §33.10 Part E step 4; design spec §11.3). It draws what the main process
// sends and reports keys and clicks back; it holds no state of its own beyond the text box being typed in. The grace
// bar is a CSS animation whose end is reported as `graceEnd`: no JS timer on that path (§33.10 speed rules).
// The window is not activated when a card appears; a click on a card enters answer mode (desk.js), and only then
// do the keys work: 1–3 an option or next step, Space reply, V the mic, X X stop the agent, E discard, Esc close.
// V records with Mewndo's own mic (recorder.js, the dock's recorder) when speech.js works; the words land in the
// reply box, and Enter sends them. Without it, V shows the Wispr Flow hint.
// What it can't do: the core sends no conversation snippet yet, so a card shows the agent's two lines but not your
// last message; "Stop agent" brakes the agent (Mewndo's brake), it does not end its process.
const stack = document.getElementById('stack');
let state = { cards: [], more: 0, selectedId: null, answerMode: false, textFor: null };
const seen = new Set(); // cards already drawn: only new ones slide in

const el = (tag, cls, ...children) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children.filter((c) => c != null));
  return e;
};
const keycap = (k) => el('span', 'keycap', k);
const chip = (label, key, onClick) => {
  const b = el('button', 'chip', label, key && keycap(key));
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
};

// The state in words and the ring that goes with it (§3.6: colour plus a shape).
const STATUS = {
  question: ['needs', 'Waiting for your answer'],
  permission: ['needs', 'Wants to run a command'],
  done: ['done', 'Finished'],
  drift: ['stopped', 'Went outside its brief'],
  receipt: ['stopped', "Says it's done; the evidence disagrees"],
};
function ago(at) {
  const min = Math.floor((Date.now() - (at ?? Date.now())) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

function cardView(card, index, s) {
  const answered = card.state !== 'open';
  const box = el('div', `card ${card.kind}${card.id === s.selectedId ? ' selected' : ''}${answered ? ' answered' : ''}${seen.has(card.id) ? '' : ' enter'}`);
  seen.add(card.id);
  box.setAttribute('role', 'listitem');
  box.addEventListener('mousedown', () => window.desk.click('select', card.id));
  const key = (k) => () => window.desk.key(k, card.id);

  // Header: who, which card this is, J/K, Esc.
  const total = s.cards.length + (s.more ?? 0);
  const dots = el('span', 'dots', ...Array.from({ length: Math.min(total, 6) }, (_, i) => el('i', i === index ? 'on' : '')));
  box.append(el('div', 'head',
    el('span', 'who', MewLogos.img(card.agent, 18), ' ', card.agent ?? 'Agent'),
    total > 1 ? dots : null,
    total > 1 ? el('span', 'nav', chip('‹', 'K', key('k')), chip('›', 'J', key('j'))) : null, // J next, K previous (desk/cards.js)
    chip('×', 'Esc', key('Escape'))));

  const [ring, words] = STATUS[card.kind] ?? STATUS.question;
  box.append(el('div', 'status', el('span', `ring ${ring}`), el('b', null, words), Object.assign(el('span', 'ago', `· ${ago(card.at)}`), { at: card.at })));

  const lines = card.lines.filter(Boolean);
  if (card.kind === 'permission') {
    // The core's title is "Run <command>?" (agents/claude.rs card_for); under "Run this command?" only the command
    // itself is shown, so the card doesn't say it twice.
    box.append(el('div', 'ask', 'Run this command?'), el('div', 'command', String(card.title).replace(/^Run\s+/, '').replace(/\?$/, '')));
    const risk = Math.max(0, Math.min(5, card.risk ?? 0));
    if (lines.length || risk) box.append(el('div', `risk r${risk}`, el('div', null, lines.join(' ')), risk ? el('span', null, '●'.repeat(risk) + '○'.repeat(5 - risk)) : null));
  } else {
    if (lines.length) box.append(el('div', 'said', lines.join('\n')));
    // A Done card's title is "Finished", which the status line above already says.
    if (card.title && !(card.kind === 'done' && card.title === 'Finished')) box.append(el('div', 'ask', card.title));
  }

  // Options, numbered; the answered one is marked.
  if (card.options.length) {
    const options = el('div', 'options');
    card.options.slice(0, 9).forEach((label, i) => {
      // A Done card's last two options are Undo turn and Clear; the "Undo this turn U" and "Discard E" buttons are
      // those two, so they aren't listed again. Their number keys still work.
      if (card.kind === 'done' && (label === 'Undo turn' || label === 'Clear')) return;
      const row = el('button', `option${card.chosen === i ? ' chosen' : ''}`, keycap(String(i + 1)), el('span', 'label', label),
        el('span', 'go', card.chosen === i ? '✓' : '›'));
      row.disabled = answered;
      row.addEventListener('click', (e) => { e.stopPropagation(); if (!answered) window.desk.click('answer', card.id, i); });
      options.append(row);
    });
    box.append(options);
  }

  // A Done card's next steps (reference 14): the core's options, with Stop agent and Discard beside the heading.
  if (card.kind === 'done' && !answered) {
    const armed = brakeArmed?.cardId === card.id && Date.now() - brakeArmed.at < 2000;
    const stop = chip(armed ? 'Press X again' : 'Stop agent', 'X', () => armBrake(card));
    stop.classList.add('danger');
    const head = el('div', 'steps', el('span', 'label', card.options.length ? 'Next steps' : ''), stop, chip('Discard', 'E', key('e')));
    const options = box.querySelector('.options');
    box.insertBefore(replyRow(card, s), options);
    box.insertBefore(head, options);
  }

  if (card.state === 'answering') {
    const bar = el('div', 'grace');
    bar.style.animationDuration = `${card.graceMs}ms`;
    bar.addEventListener('animationend', () => window.desk.graceEnd(card.id), { once: true });
    box.append(el('div', 'foot', el('span', 'sent', 'Answer sent'), keycap('Esc'), 'to take back'), bar);
  } else if (answered) {
    box.append(el('div', 'foot', el('span', 'sent', 'Sent · Undo after this'),
      card.kind === 'done' || card.kind === 'receipt' ? chip('Undo this turn', 'U', key('u')) : null));
  } else {
    const reply = card.kind === 'done' ? null : replyRow(card, s); // a Done card's is above its next steps
    if (reply) box.append(reply);
    const foot = el('div', 'foot');
    if (card.kind === 'done') foot.append(chip('Undo this turn', 'U', key('u')));
    if (card.kind === 'receipt') foot.append(chip('Ignore', 'E', key('e')));
    if (foot.childElementCount) box.append(foot);
  }
  return box;
}

// The reply row: a hint until Space (or V) opens the text box in it. With Mewndo's mic (s.mic), a mic button too;
// while it listens the box says so and V stops it; the words then wait in the box for Enter.
let typed = null; // { cardId, draft, value }: what is in the box, so a redraw doesn't lose it
const MIC_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5"/></svg>';
function micButton(card, s) {
  if (!s.mic || card.kind === 'permission') return null;
  const listening = s.textFor?.cardId === card.id && s.textFor.mic === 'listening';
  const b = el('button', `mic${listening ? ' on' : ''}`);
  b.innerHTML = MIC_SVG; // our own markup, no user text
  b.setAttribute('aria-label', listening ? 'Stop listening' : 'Reply by voice');
  b.addEventListener('click', (e) => { e.stopPropagation(); window.desk.key('v', card.id); });
  return b;
}
function replyRow(card, s) {
  if (!['question', 'permission', 'done'].includes(card.kind)) return null;
  const typing = s.textFor?.cardId === card.id;
  const row = el('div', 'reply');
  const send = el('button', 'send', '↑');
  send.setAttribute('aria-label', 'Send');
  if (typing) {
    const t = s.textFor;
    const input = el('input');
    const listening = t.mic === 'listening' || t.mic === 'working';
    if (typed?.cardId !== card.id || (t.draft != null && typed.draft !== t.draft)) typed = { cardId: card.id, draft: t.draft ?? null, value: t.draft ?? '' };
    input.value = typed.value;
    input.readOnly = listening;
    input.placeholder = t.hint || (t.via === 'voice' ? 'Hold your Wispr Flow key and speak' : 'Type your answer…');
    send.classList.toggle('ready', !!input.value.trim());
    input.addEventListener('input', () => { typed.value = input.value; send.classList.toggle('ready', !!input.value.trim()); });
    input.addEventListener('focus', () => window.desk.hold(card.id));
    const go = () => { if (input.value.trim() && !listening) { typed = null; window.desk.text(card.id, input.value, t.via); } };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (listening && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); window.desk.key('v', card.id); return; }
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') window.desk.key('Escape', card.id);
    });
    send.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    row.append(...[input, micButton(card, s), send].filter(Boolean));
    queueMicrotask(() => input.focus());
  } else {
    const hint = card.kind === 'permission' ? 'Add a reason…' : card.kind === 'done' ? `Reply to ${card.agent ?? 'the agent'}…` : 'Type your answer…';
    row.append(...[el('span', 'hint', hint), keycap('Space'), micButton(card, s), card.kind === 'permission' ? null : keycap('V'), send].filter(Boolean));
    row.addEventListener('click', (e) => { e.stopPropagation(); window.desk.key(' ', card.id); });
  }
  return row;
}

// The card mic follows the state the main process sends: listening starts the recorder, anything else stops it.
// The recording goes back only when the user stopped it on purpose ('working'); Esc or J/K throw it away.
const recorder = MewRecorder();
let recordingFor = null;
async function syncMic(s) {
  const want = s.textFor?.mic === 'listening' ? s.textFor.cardId : null;
  if (want && recordingFor !== want) {
    if (recordingFor) recorder.stop();
    recordingFor = want;
    const ok = await recorder.start({ maxMs: 30_000, onMax: () => window.desk.key('v', want) });
    if (!ok && recordingFor === want) { recordingFor = null; window.desk.dictate(want, null); }
  } else if (!want && recordingFor) {
    const id = recordingFor;
    recordingFor = null;
    const wav = recorder.stop();
    if (s.textFor?.cardId === id && s.textFor.mic === 'working') window.desk.dictate(id, wav);
  }
}

// The empty Inbox (reference): shown when the dock's Inbox is clicked with nothing to answer.
function emptyView() {
  const close = el('button', 'chip', '×');
  close.addEventListener('click', () => window.desk.click('close-empty'));
  const face = window.MewCat ? MewCat.create({ pose: 'face', size: 48 }).el : null;
  return el('div', 'card empty-inbox',
    el('div', 'head', el('span', 'who', 'Inbox'), close),
    el('div', 'empty-body', face,
      el('div', null, el('b', null, 'All clear.'),
        el('p', null, 'When an agent asks something or finishes its work, it shows up here.'))));
}

function draw(s) {
  state = s;
  if (!s.textFor) typed = null;
  if (s.empty && !s.cards.length) { stack.replaceChildren(emptyView()); syncMic(s); return; }
  stack.replaceChildren(...s.cards.map((card, i) => cardView(card, i, s)));
  if (s.more) stack.append(el('div', 'more', `+${s.more} more`));
  syncMic(s);
}
setInterval(() => { for (const t of stack.querySelectorAll('.ago')) t.textContent = `· ${ago(t.at)}`; }, 30_000); // keep "2 min ago" true

// X then X brakes the selected card's agent (the second press within 2 s confirms, so one stray key never stops an
// agent); ? shows the key list over the stack (design spec §11.11). Everything else goes to the main process.
let brakeArmed = null; // { cardId, at } after the first X (or Stop agent click); a second within 2 s brakes
function armBrake(card) {
  if (!card) return;
  if (brakeArmed?.cardId === card.id && Date.now() - brakeArmed.at < 2000) {
    brakeArmed = null;
    window.desk.click('brake', card.id);
    return;
  }
  brakeArmed = { cardId: card.id, at: Date.now() };
  stack.querySelector('.card.selected .foot.armed')?.remove();
  const foot = el('div', 'foot armed', el('span', 'label', `Press X again to stop ${card.agent ?? 'this agent'}`));
  stack.querySelector('.card.selected')?.append(foot);
  setTimeout(() => foot.remove(), 2000);
}
const KEY_LIST = [['1–9', 'Pick an option or next step'], ['Space', 'Reply'], ['V', 'Reply by voice'], ['Enter', 'Send'],
  ['J / K', 'Next / previous card'], ['Esc', 'Take back, or close'], ['E', 'Discard'], ['U', 'Undo this turn'], ['X, X', 'Stop this agent'], ['?', 'This list']];
function showKeys(on) {
  document.querySelector('.keylist')?.remove();
  if (!on) return;
  stack.prepend(el('div', 'card keylist', el('div', 'ask', 'Keys'),
    ...KEY_LIST.map(([k, what]) => el('div', 'keyrow', keycap(k), el('span', null, what)))));
}
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  if (e.key === '?') return showKeys(!document.querySelector('.keylist'));
  showKeys(false);
  if (e.key.toLowerCase() === 'x' && state.selectedId) return armBrake(state.cards.find((c) => c.id === state.selectedId));
  window.desk.key(e.key, state.selectedId);
});

window.desk.onState(draw);
