// The Talk box (spec §33.5): one line of text; the core's Router says where it goes. Below the confidence line the
// two best targets come back as chips, picked with 1 or 2.
const input = document.getElementById('text');
const chips = document.getElementById('chips');

window.talk.onOpen(() => {
  input.value = '';
  chips.replaceChildren();
  input.focus();
});

window.talk.onChips(({ chips: labels = [] }) => {
  chips.replaceChildren(...labels.map((label, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1} ${label}`;
    b.addEventListener('click', () => window.talk.chip(i + 1));
    return b;
  }));
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.talk.submit(input.value);
  else if (e.key === 'Escape') window.talk.close();
  else if (chips.childElementCount && (e.key === '1' || e.key === '2') && !input.value) {
    e.preventDefault();
    window.talk.chip(Number(e.key));
  }
});
