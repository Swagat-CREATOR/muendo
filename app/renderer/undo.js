// One-key undo window: Enter undoes, Escape cancels, arrow keys switch folders. No Node access.
const api = window.undo;
const $ = (id) => document.getElementById(id);

let folders = [];
let current = 0;
let target = null; // what Enter would undo, for the folder shown
let busy = false;
let generation = 0; // ignores answers that arrive after the user moved on

function show(text) {
  $('details').replaceChildren(...text.map(([label, value, cls]) => {
    const p = document.createElement('p');
    if (cls) p.className = cls;
    if (label) {
      const b = document.createElement('strong');
      b.textContent = `${label}: `;
      p.append(b);
    }
    p.append(value);
    return p;
  }));
}

async function load() {
  const gen = ++generation;
  target = null;
  $('confirm').disabled = true;
  $('status').textContent = '';
  if (!folders.length) {
    $('folder').textContent = '';
    show([[null, 'No protected folders have anything to undo.']]);
    $('switch').textContent = '';
    return;
  }
  const f = folders[current];
  $('folder').textContent = f.name;
  $('switch').textContent = folders.length > 1 ? `← → other folders (${current + 1} of ${folders.length})` : '';
  show([[null, 'Checking what changed…', 'muted']]);
  const t = await api.target(f.root);
  if (gen !== generation) return;
  if (t.nothing) {
    show([[null, t.nothing]]);
    return;
  }
  target = t;
  const sp = t.savePoint;
  show([
    ['Save point', new Date(sp.createdAt).toLocaleString()],
    sp.label && ['Label', sp.label],
    sp.agent && ['Agent', sp.agent],
    [null, t.summary, 'summary'],
    t.note && [null, t.note, 'muted'],
  ].filter(Boolean));
  $('confirm').disabled = false;
}

async function open() {
  if (busy) return;
  folders = await api.folders();
  current = 0;
  await load();
  $('confirm').focus();
}

async function confirm() {
  if (busy || !target) return;
  busy = true;
  $('confirm').disabled = true;
  $('cancel').disabled = true;
  $('status').textContent = 'Undoing…';
  try {
    const r = await api.run(target.root, target.savePoint.id);
    $('status').className = r.verified ? 'good' : 'error';
    $('status').textContent = r.verified
      ? `Done and verified: ${r.written} file${r.written === 1 ? '' : 's'} put back, ${r.trashed} moved to Mewndo's trash.`
      : `Finished, but ${r.problems} file${r.problems === 1 ? '' : 's'} could not be restored. Open Mewndo to see which.`;
  } catch (e) {
    $('status').className = 'error';
    $('status').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  setTimeout(() => {
    busy = false;
    $('status').className = '';
    $('cancel').disabled = false;
    api.hide();
  }, 4000);
}

function cancel() {
  if (!busy) api.hide();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key) && folders.length > 1 && !busy) {
    e.preventDefault();
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    current = (current + step + folders.length) % folders.length;
    load();
  }
});
$('confirm').onclick = confirm;
$('cancel').onclick = cancel;
api.onOpen(open);
open();
