// The Skills screen (spec §36.6 U9, Show Me). Loaded after app.js and uses its helpers (api, $, h, fill, guard,
// toast, ask). Everything comes from the main process (app/computer-main.js, app/skills.js).
//
//   Record a skill -> the main window steps aside and "Recording — Esc to stop" shows on top -> Esc, Stop or
//   10 minutes -> this screen shows the steps to review: name it, delete steps, correct typed text, Save.
//   A saved skill opens in the same editor: rename, edit steps, Delete (to the skills trash folder).
// What it can't do: add steps by hand, reorder steps, or show screenshots of them; replay clicks the recorded
// screen points.

let skEditing = null; // { mode: 'review' | 'edit', id?, steps }
let skView = null;

// The step in words (app/skills.js `says`, which the main process can't lend the window).
function skSays(step) {
  switch (step.kind) {
    case 'focus': return step.window ? `Switch to ${step.app} (${step.window})` : `Switch to ${step.app}`;
    case 'click': {
      const how = step.button === 'right' ? 'Right-click' : step.count === 2 ? 'Double-click' : 'Click';
      return step.element?.name ? `${how} "${step.element.name}" at ${step.x}, ${step.y}` : `${how} at ${step.x}, ${step.y}`;
    }
    case 'type': return step.secret ? 'Type something private (not recorded: you type it when it runs)' : 'Type';
    case 'key': return step.modifiers?.length ? `Press ${step.modifiers.join('+')}+${step.key}` : `Press ${step.key}`;
    default: return 'A step Mewndo does not know';
  }
}

function skRenderSteps() {
  fill($('sk-steps'), ...skEditing.steps.map((step, i) => {
    const remove = h('button', { 'aria-label': `Delete step ${i + 1}`, onclick: () => { skEditing.steps.splice(i, 1); skRenderSteps(); } }, 'Delete');
    if (step.kind === 'type' && !step.secret) {
      const input = h('input', { value: step.text, 'aria-label': `Text typed in step ${i + 1}`, maxlength: 10000 });
      input.addEventListener('input', () => { step.text = input.value; });
      return h('li', {}, h('div', { class: 'sk-step' }, h('span', {}, 'Type'), input, remove));
    }
    return h('li', {}, h('div', { class: 'sk-step' },
      h('span', { class: `sk-says${step.kind === 'type' ? ' sk-private' : ''}` }, skSays(step)), remove));
  }));
  if (!skEditing.steps.length) fill($('sk-steps'), h('li', { class: 'muted' }, 'No steps left.'));
}

function skOpenEditor(mode, { id = null, name = '', description = '', steps }) {
  skEditing = { mode, id, steps: steps.map((s) => ({ ...s })) };
  $('sk-editor-title').textContent = mode === 'review' ? `Review the recording (${plural(steps.length, 'step')})` : `Edit "${name}"`;
  $('sk-name').value = name;
  $('sk-desc').value = description;
  $('sk-editor-error').textContent = '';
  $('sk-save').textContent = mode === 'review' ? 'Save skill' : 'Save changes';
  $('sk-cancel').textContent = mode === 'review' ? 'Discard' : 'Close';
  $('sk-delete').hidden = mode !== 'edit';
  $('sk-editor').hidden = false;
  skRenderSteps();
  if (mode === 'review') $('sk-name').focus();
}

function skCloseEditor() {
  skEditing = null;
  $('sk-editor').hidden = true;
}

function skRender(v) {
  skView = v;
  const rec = v.recording;
  $('sk-off').hidden = v.on || rec.phase !== 'idle';
  $('sk-record').disabled = !v.on || rec.phase === 'starting' || rec.phase === 'recording';
  $('sk-record').title = v.on ? '' : 'Turn on computer use in Settings first';
  $('sk-recording').hidden = rec.phase !== 'recording' && rec.phase !== 'starting';
  $('sk-rec-count').textContent = rec.phase === 'starting' ? 'Starting…' : `${plural(rec.steps.filter(Boolean).length, 'step')} so far.`;
  $('sk-status').textContent = rec.phase === 'idle' && rec.reason ? `The recording stopped: ${rec.reason}.` : '';
  if (rec.phase === 'review' && skEditing?.mode !== 'review') skOpenEditor('review', { steps: rec.steps.filter(Boolean) });
  if (rec.phase !== 'review' && skEditing?.mode === 'review') skCloseEditor();
  fill($('sk-list'), ...v.skills.map((s) => h('li', {},
    h('div', { class: 'sk-meta' }, h('div', { class: 'sk-name' }, s.name),
      h('div', { class: 'muted small' }, [plural(s.steps, 'step'), s.description].filter(Boolean).join(' · '))),
    h('button', { onclick: guard(() => skEdit(s.id)) }, 'Edit…'))));
  $('sk-empty').hidden = v.skills.length > 0 || !$('sk-editor').hidden;
}

async function skEdit(id) {
  const s = await api.skillGet(id);
  skOpenEditor('edit', s);
}

// The empty state's picture: skills-empty.png when it is there, else the sitting cat.
(() => {
  const img = $('sk-empty-img');
  const show = () => { img.hidden = false; $('sk-empty-cat').hidden = true; };
  if (img.complete && img.naturalWidth > 0) show();
  else img.addEventListener('load', show, { once: true });
})();

const loadSkills = guard(async () => skRender(await api.skillsView()));

$('sk-record').onclick = guard(async () => {
  await api.skillRecord();
  await loadSkills();
});
$('sk-stop').onclick = guard(() => api.skillStop());
$('sk-open-settings').onclick = guard(() => api.skillOpenSettings());

$('sk-save').onclick = guard(async () => {
  $('sk-editor-error').textContent = '';
  const fields = { name: $('sk-name').value.trim(), description: $('sk-desc').value.trim(), steps: skEditing.steps };
  if (!fields.name) { $('sk-editor-error').textContent = 'Give the skill a name, so an agent can ask for it.'; return; }
  try {
    if (skEditing.mode === 'review') {
      const saved = await api.skillSaveRecording(fields);
      toast(`Saved "${saved.name}". Agents connected to Mewndo's computer tools can run it with run_skill.`);
    } else {
      await api.skillUpdate(skEditing.id, fields);
      toast('Saved.');
    }
  } catch (e) {
    $('sk-editor-error').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return;
  }
  skCloseEditor();
  await loadSkills();
});

$('sk-cancel').onclick = guard(async () => {
  if (skEditing?.mode === 'review') await api.skillDiscardRecording();
  skCloseEditor();
  await loadSkills();
});

$('sk-delete').onclick = guard(async () => {
  if ((await ask($('sk-delete-dialog'))) !== 'ok') return;
  await api.skillDelete(skEditing.id);
  toast('Deleted. The file is in the trash folder inside Mewndo\'s skills folder.');
  skCloseEditor();
  await loadSkills();
});

api.on('skills-changed', () => { if (screen === 'skills' || skView) loadSkills(); });
