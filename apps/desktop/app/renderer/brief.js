// Brief window: Ctrl+Enter makes a save point and copies the brief, Escape closes. No Node access.
const api = window.brief;
const $ = (id) => document.getElementById(id);
let busy = false;

async function open() {
  if (busy) return;
  $('status').textContent = '';
  $('status').className = '';
  const folders = await api.folders(); // most recent activity first
  $('folder').replaceChildren(...folders.map((f) => {
    const o = document.createElement('option');
    o.value = f.root;
    o.textContent = `${f.name}  (${f.root})`;
    return o;
  }));
  $('go').disabled = !folders.length;
  if (!folders.length) $('status').textContent = 'No folders are protected yet. Add one in the Mewndo window first.';
  const said = await api.prefill(); // a task said to the bar's mic: shown for checking, never sent unseen
  if (said) $('task').value = said;
  $('task').focus(); // ready for typing or dictation
}

async function go() {
  if (busy) return;
  const task = $('task').value.trim();
  if (!task) { $('status').textContent = 'Type the task first.'; $('task').focus(); return; }
  if (!$('folder').value) return;
  busy = true;
  $('go').disabled = true;
  $('status').className = '';
  $('status').textContent = 'Making a save point…';
  try {
    await api.create($('folder').value, task); // copies the brief and hides this window
    $('task').value = '';
    $('status').textContent = '';
  } catch (e) {
    $('status').className = 'error';
    $('status').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy = false;
    $('go').disabled = false;
  }
}

// Escape closes without doing anything; what was typed stays for next time.
function close() { if (!busy) api.hide(); }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
});
$('go').onclick = go;
$('close').onclick = close;
api.onOpen(open);
open();
