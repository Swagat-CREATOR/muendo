// The Talk box (spec §33.5, design spec §11.4; references 10 and 11): one line of text; the core's Router says where
// it goes. When it's unsure, the two best targets come back as chips on the target line, picked with 1 or 2 (or a
// click). Words said to the dock's mic appear here as they were heard, a few words at a time, then the status line
// says what happened: "Sent to Claude.", "Queued: ..." or why not. Then the box closes itself.
// What it can't do: the text appears after speech recognition has finished, not while you speak; the target line
// appears only once the Router answers; a box shown for spoken words has no keyboard focus, so pick a chip with a
// click.
// A typing offer (an agent idle at its prompt, docs/decisions.md): the box shows why, the exact text in quotes, and
// "1 Type it" / "2 Cancel". Nothing is typed unless Type it is picked; Esc, Cancel or a minute's wait close it.
const input = document.getElementById('text');
const target = document.getElementById('target');
const status = document.getElementById('status');
const quote = document.getElementById('quote');
const box = document.querySelector('.box');
const CLOSE_AFTER_MS = { sent: 2_500, queued: 4_000, failed: 8_000, confirm: 60_000 }; // confirm: the offer's minute
// The offer takes the keyboard from whatever the user was typing in, so a key already on its way (or held down)
// must not answer it: 1 and 2 count only after this long. A click always counts.
const CONFIRM_ARM_MS = 500;
let armedAt = 0;
let streaming = null; // the timer revealing dictated words
let later = null; // a status that arrived while the words were still appearing
let closing = null;

function reset() {
  clearInterval(streaming);
  clearTimeout(closing);
  streaming = null;
  later = null;
  status.hidden = true;
  status.textContent = '';
  target.replaceChildren();
  target.hidden = true;
  quote.textContent = '';
  quote.hidden = true;
  box.classList.remove('confirm');
  input.readOnly = false;
}

// Numbered buttons on the target line, picked with 1 and 2 or a click.
function chipButtons(labels) {
  return labels.map((label, i) => {
    const b = document.createElement('button');
    const k = document.createElement('span');
    k.className = 'keycap';
    k.textContent = String(i + 1);
    b.append(k, label);
    b.addEventListener('click', () => window.talk.chip(i + 1));
    return b;
  });
}

function showStatus(s) {
  if (streaming) { later = s; return; }
  status.textContent = s.text ?? '';
  status.className = `status ${s.tone ?? ''}`;
  status.hidden = !s.text;
  input.readOnly = true;
  clearTimeout(closing);
  const after = CLOSE_AFTER_MS[s.tone];
  if (after) closing = setTimeout(() => window.talk.close(), after);
}

// to: the agent this box is aimed at (opened from its row in the agent list), shown on the target line.
window.talk.onOpen(({ to = null } = {}) => {
  reset();
  input.value = '';
  input.placeholder = to ? `Message ${to}, or hold the dock's mic and speak` : "Type, or hold the dock's mic and speak";
  if (to) { target.textContent = `To ${to}`; target.hidden = false; }
  input.focus();
});

// Spoken words: revealed a few at a time over about half a second, the way reference 10 shows them arriving.
window.talk.onDictated(({ text = '' } = {}) => {
  reset();
  input.value = '';
  input.readOnly = true;
  const words = String(text).split(/(\s+)/);
  const step = Math.max(1, Math.ceil(words.length / 16));
  let i = 0;
  streaming = setInterval(() => {
    i = Math.min(words.length, i + step);
    input.value = words.slice(0, i).join('');
    if (i < words.length) return;
    clearInterval(streaming);
    streaming = null;
    showStatus(later ?? { tone: 'sending', text: 'Finding the right agent…' });
  }, 30);
});

window.talk.onStatus(showStatus);

window.talk.onChips(({ chips: labels = [] }) => {
  target.replaceChildren('↳ Which one?', ...chipButtons(labels));
  target.hidden = !labels.length;
  // The text is sent once a chip is picked, so the line stops taking typing and 1 and 2 pick.
  if (labels.length) { status.hidden = true; clearTimeout(closing); input.readOnly = true; }
});

window.talk.onConfirm(({ text = '', preview = '', options = [] } = {}) => {
  reset();
  box.classList.add('confirm');
  input.value = '';
  input.readOnly = true; // 1 and 2 pick; nothing typed here goes anywhere
  status.textContent = text;
  status.className = 'status confirm';
  status.hidden = !text;
  quote.textContent = `"${preview}"`; // exactly what would be typed: textContent, never parsed as HTML
  quote.hidden = false;
  target.replaceChildren(...chipButtons(options));
  target.hidden = !options.length;
  closing = setTimeout(() => window.talk.close(), CLOSE_AFTER_MS.confirm);
  armedAt = Date.now() + CONFIRM_ARM_MS;
});

// On the document, not the input: the input is hidden while a typing offer is up, and 1, 2 and Esc still work.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.talk.close();
  else if (target.querySelector('button') && (e.key === '1' || e.key === '2') && (!input.value || input.readOnly)) {
    e.preventDefault();
    if (box.classList.contains('confirm') && (e.repeat || Date.now() < armedAt)) return;
    window.talk.chip(Number(e.key));
  } else if (e.key === 'Enter' && !input.readOnly) window.talk.submit(input.value);
});
