// The Agent Inbox card stack (spec §33.2, §33.10 Part E step 4; design spec §11.3). It draws what the main process
// sends and reports keys and clicks back; it holds no state of its own beyond the text box being typed in. The grace
// bar is a CSS animation whose end is reported as `graceEnd`: no JS timer on that path (§33.10 speed rules).
// What it can't do: the core sends no conversation snippet yet, so a card shows the agent's two lines but not your
// last message; there is no Brake key on a card yet (the dock's Brake still works), and Done cards offer Undo and
// Clear but not the Receipt's suggested replies.
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
    total > 1 ? el('span', 'nav', chip('‹', 'J', key('j')), chip('›', 'K', key('k'))) : null,
    chip('×', 'Esc', key('Escape'))));

  const [ring, words] = STATUS[card.kind] ?? STATUS.question;
  box.append(el('div', 'status', el('span', `ring ${ring}`), el('b', null, words), Object.assign(el('span', 'ago', `· ${ago(card.at)}`), { at: card.at })));

  const lines = card.lines.filter(Boolean);
  if (card.kind === 'permission') {
    box.append(el('div', 'ask', 'Run this command?'), el('div', 'command', card.title));
    const risk = Math.max(0, Math.min(5, card.risk ?? 0));
    if (lines.length || risk) box.append(el('div', `risk r${risk}`, el('div', null, lines.join(' ')), risk ? el('span', null, '●'.repeat(risk) + '○'.repeat(5 - risk)) : null));
  } else {
    if (lines.length) box.append(el('div', 'said', lines.join('\n')));
    if (card.title) box.append(el('div', 'ask', card.title));
  }

  // Options, numbered; the answered one is marked.
  if (card.options.length) {
    const options = el('div', 'options');
    card.options.slice(0, 9).forEach((label, i) => {
      const row = el('button', `option${card.chosen === i ? ' chosen' : ''}`, keycap(String(i + 1)), el('span', 'label', label),
        el('span', 'go', card.chosen === i ? '✓' : '›'));
      row.disabled = answered;
      row.addEventListener('click', (e) => { e.stopPropagation(); if (!answered) window.desk.click('answer', card.id, i); });
      options.append(row);
    });
    box.append(options);
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
    box.append(replyRow(card, s));
    const foot = el('div', 'foot');
    if (card.kind === 'done') foot.append(chip('Undo this turn', 'U', key('u')));
    if (card.kind === 'done' || card.kind === 'receipt') foot.append(chip(card.kind === 'done' ? 'Clear' : 'Ignore', 'E', key('e')));
    if (foot.childElementCount) box.append(foot);
  }
  return box;
}

// The reply row: a hint until Space (or V) opens the text box in it.
function replyRow(card, s) {
  if (!['question', 'permission', 'done'].includes(card.kind)) return null;
  const typing = s.textFor?.cardId === card.id;
  const row = el('div', 'reply');
  const send = el('button', 'send', '↑');
  send.setAttribute('aria-label', 'Send');
  if (typing) {
    const input = el('input');
    input.placeholder = s.textFor.hint || (s.textFor.via === 'voice' ? 'Hold your Wispr Flow key and speak' : 'Type your answer…');
    input.addEventListener('input', () => send.classList.toggle('ready', !!input.value.trim()));
    const go = () => { if (input.value.trim()) window.desk.text(card.id, input.value, s.textFor.via); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') window.desk.key('Escape', card.id);
    });
    send.addEventListener('click', (e) => { e.stopPropagation(); go(); });
    row.append(input, send);
    queueMicrotask(() => input.focus());
  } else {
    const hint = card.kind === 'permission' ? 'Add a reason…' : card.kind === 'done' ? `Reply to ${card.agent ?? 'the agent'}…` : 'Type your answer…';
    row.append(...[el('span', 'hint', hint), keycap('Space'), card.kind === 'permission' ? null : keycap('V'), send].filter(Boolean));
    row.addEventListener('click', (e) => { e.stopPropagation(); window.desk.key(' ', card.id); });
  }
  return row;
}

function draw(s) {
  state = s;
  stack.replaceChildren(...s.cards.map((card, i) => cardView(card, i, s)));
  if (s.more) stack.append(el('div', 'more', `+${s.more} more`));
}
setInterval(() => { for (const t of stack.querySelectorAll('.ago')) t.textContent = `· ${ago(t.at)}`; }, 30_000); // keep "2 min ago" true

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  window.desk.key(e.key, state.selectedId);
});

window.desk.onState(draw);
