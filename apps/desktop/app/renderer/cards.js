// The Agent Inbox card stack (spec §33.2, §33.10 Part E step 4). It draws what the main process sends and reports
// keys and clicks back; it holds no state of its own beyond the text box being typed in. The grace bar is a CSS
// animation whose end is reported as `graceEnd`: no JS timer on that path (§33.10 speed rules).
const stack = document.getElementById('stack');
let state = { cards: [], more: 0, selectedId: null, answerMode: false, textFor: null };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function draw(s) {
  state = s;
  stack.replaceChildren();
  for (const card of s.cards) {
    const box = el('div', `card ${card.state}${card.id === s.selectedId ? ' selected' : ''}`);
    box.setAttribute('role', 'listitem');
    box.addEventListener('mousedown', () => window.desk.click('select', card.id));
    const head = el('div', 'head');
    head.append(el('span', 'kind', card.kind), el('span', `risk r${card.risk}`, card.risk ? `risk ${card.risk}` : ''));
    box.append(head, el('div', 'title', card.title));
    for (const line of card.lines) if (line) box.append(el('div', 'line', line));
    if (card.state === 'open' && card.options.length) {
      const options = el('div', 'options');
      card.options.forEach((label, i) => {
        const b = el('button', null, `${i + 1} ${label}`);
        b.addEventListener('click', (e) => { e.stopPropagation(); window.desk.click('answer', card.id, i); });
        options.append(b);
      });
      box.append(options);
    }
    if (card.state === 'answering') {
      const bar = el('div', 'grace');
      bar.style.animationDuration = `${card.graceMs}ms`;
      bar.addEventListener('animationend', () => window.desk.graceEnd(card.id), { once: true });
      box.append(bar, el('div', 'hints', 'Esc takes it back'));
    } else if (card.state === 'sent' || card.state === 'released') {
      box.append(el('div', 'state', 'Sent to the agent'));
    } else if (card.hints) {
      box.append(el('div', 'hints', card.hints.join(' · ')));
    }
    if (s.textFor?.cardId === card.id) {
      const input = el('input');
      input.placeholder = s.textFor.hint || (s.textFor.via === 'voice' ? 'Hold your Wispr Flow key and speak' : 'Type a reply');
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && input.value.trim()) window.desk.text(card.id, input.value, s.textFor.via);
        if (e.key === 'Escape') window.desk.key('Escape', card.id);
      });
      box.append(input);
      queueMicrotask(() => input.focus());
    }
    stack.append(box);
  }
  if (s.more) stack.append(el('div', 'more', `+${s.more} more`));
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  e.preventDefault();
  window.desk.key(e.key, state.selectedId);
});

window.desk.onState(draw);
