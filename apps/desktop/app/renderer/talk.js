// The Talk box (spec §33.5, design spec §11.4): one line of text; the core's Router says where it goes. When it's
// unsure, the two best targets come back as chips on the target line, picked with 1 or 2.
// What it can't do: the target line appears only after Enter, when the Router answers; it doesn't update live.
const input = document.getElementById('text');
const target = document.getElementById('target');

window.talk.onOpen(() => {
  input.value = '';
  target.replaceChildren();
  target.hidden = true;
  input.focus();
});

window.talk.onChips(({ chips: labels = [] }) => {
  target.replaceChildren('↳ Which one?', ...labels.map((label, i) => {
    const b = document.createElement('button');
    const k = document.createElement('span');
    k.className = 'keycap';
    k.textContent = String(i + 1);
    b.append(k, label);
    b.addEventListener('click', () => window.talk.chip(i + 1));
    return b;
  }));
  target.hidden = !labels.length;
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.talk.submit(input.value);
  else if (e.key === 'Escape') window.talk.close();
  else if (target.querySelector('button') && (e.key === '1' || e.key === '2') && !input.value) {
    e.preventDefault();
    window.talk.chip(Number(e.key));
  }
});
