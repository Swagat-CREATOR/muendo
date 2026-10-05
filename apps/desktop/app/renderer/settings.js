// Settings window. No Node access: everything goes through window.settings (see settings-preload.js).
const api = window.settings;
const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'readOnly') el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const plain = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const pretty = (accel) => accel.replace('Control', 'Ctrl').replace('Super', 'Win');
function say(el, text, ok = true) {
  el.className = ok ? 'good' : 'error';
  el.textContent = text;
}
function size(bytes) {
  if (bytes == null) return '…';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
}
const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);

// "Control+Alt+U" from a key press, or null while only modifiers are held.
function accelerator(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  return [...mods, key].join('+');
}

let current = null;

function render(s) {
  current = s;

  const names = { undo: 'Undo (opens one-key undo)', brief: 'Brief (opens the brief helper)' };
  $('shortcuts').replaceChildren(...Object.entries(s.shortcuts).map(([which, sc]) => {
    let chosen = sc.accel;
    const box = h('input', { class: 'shortcut', readOnly: true, value: pretty(sc.accel), 'aria-label': names[which] });
    const status = h('span', { role: 'status', class: sc.working ? 'muted' : 'error' }, sc.working ? '' : 'Not working: another app has it.');
    box.addEventListener('focus', () => { api.suspendShortcuts(); box.value = 'Press the keys…'; });
    box.addEventListener('blur', () => { api.resumeShortcuts(); box.value = pretty(chosen); });
    box.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { box.blur(); return; }
      const accel = accelerator(e);
      if (!accel) return;
      chosen = accel;
      box.value = pretty(accel);
      box.blur();
    });
    const save = h('button', {
      onclick: async () => {
        try {
          render(await api.setShortcut(which, chosen));
        } catch (e) { say(status, plain(e), false); }
      },
    }, 'Save');
    const test = h('button', {
      onclick: async () => {
        say(status, `Press ${pretty(chosen)} now…`);
        try {
          const r = await api.testShortcut(chosen);
          if (r.ok) say(status, `It works: Mewndo received ${pretty(chosen)}.`);
          else if (r.reason === 'taken') say(status, `${pretty(chosen)} is already used by another app.`, false);
          else say(status, `Mewndo didn't receive ${pretty(chosen)} within 10 seconds. Another program probably catches it first; choose another.`, false);
        } catch (e) { say(status, plain(e), false); }
      },
    }, 'Test');
    return h('div', { class: 'row' }, h('span', { class: 'label' }, names[which]), box, save, test, status);
  }));

  $('max-deleted').value = s.burst.maxDeleted;
  $('max-changed').value = s.burst.maxChanged;
  $('budget').value = s.budgetGB;
  $('usage').textContent = s.usage
    ? `History uses ${size(s.usage.usedBytes)} of ${s.budgetGB} GB. Trash: ${size(s.usage.trashBytes)} (not counted in the budget). Free on disk: ${size(s.usage.freeDiskBytes)}.`
    : 'Usage is being measured…';

  $('folders').replaceChildren(...(s.folders.length ? s.folders.map((f) => {
    const retention = h('input', { type: 'number', min: 1, max: 3650, step: 1, value: f.retentionDays });
    const maxSize = h('input', { type: 'number', min: 1, max: 10240, step: 1, value: f.maxFileSizeMB });
    const ignore = h('textarea', { rows: 3, placeholder: 'One per line, e.g. *.log or temp', value: f.extraIgnore.join('\n') });
    const status = h('p', { role: 'status' });
    const save = h('button', {
      onclick: async () => {
        say(status, 'Saving and rescanning…');
        try {
          render(await api.setFolder(f.root, {
            retentionDays: Number(retention.value), maxFileSizeMB: Number(maxSize.value),
            extraIgnore: ignore.value.split('\n').map((x) => x.trim()).filter(Boolean),
          }));
          // The card was redrawn; confirm in the new one.
          const card = [...document.querySelectorAll('.folder-card')].find((c) => c.dataset.root === f.root);
          if (card) say(card.querySelector('[role=status]'), 'Saved. The folder was rescanned with these settings.');
        } catch (e) { say(status, plain(e), false); }
      },
    }, 'Save');
    return h('div', { class: 'folder-card', 'data-root': f.root },
      h('h3', {}, f.name), h('p', { class: 'muted mono' }, f.root),
      h('div', { class: 'row' },
        h('label', { class: 'inline' }, 'Keep history for ', retention, ' days'),
        h('label', { class: 'inline' }, 'Skip files over ', maxSize, ' MB')),
      h('label', {}, 'Also ignore these files and folders (names; * matches anything):'), ignore,
      h('div', { class: 'row' }, save), status);
  }) : [h('p', { class: 'muted' }, 'No folders are protected yet.')]));

  $('agents').querySelector('tbody').replaceChildren(...s.agents.map(agentRow));

  $('rules').value = s.safetyRules;
  $('login-wrap').hidden = !s.loginSupported;
  $('login').checked = s.openAtLogin;
  $('data-dir').textContent = s.dataDir;
}

function agentRow(a = { name: '', names: [], commandLine: [], notCommandLine: [] }) {
  const cell = (value, label) => h('td', {}, h('input', { value, 'aria-label': label }));
  const row = h('tr', {},
    cell(a.name, 'Name'), cell(a.names.join(', '), 'Process names'),
    cell(a.commandLine.join(', '), 'Command line contains'), cell(a.notCommandLine.join(', '), 'But not'),
    h('td', {}, h('button', { onclick: () => row.remove(), 'aria-label': `Remove ${a.name || 'this agent'}` }, 'Remove')));
  return row;
}

$('add-agent').onclick = () => {
  const row = agentRow();
  $('agents').querySelector('tbody').append(row);
  row.querySelector('input').focus();
};

$('save-agents').onclick = async () => {
  const agents = [...$('agents').querySelectorAll('tbody tr')].map((tr) => {
    const [name, names, commandLine, notCommandLine] = [...tr.querySelectorAll('input')].map((i) => i.value);
    return { name: name.trim(), names: list(names), commandLine: list(commandLine), notCommandLine: list(notCommandLine) };
  });
  if (agents.some((a) => !a.name)) return say($('agents-status'), 'Every agent needs a name.', false);
  try {
    render(await api.setAgents(agents));
    say($('agents-status'), 'Saved. Mewndo uses the new list within a few seconds.');
  } catch (e) { say($('agents-status'), plain(e), false); }
};

$('save-burst').onclick = async () => {
  try {
    render(await api.setBurst({ maxDeleted: Number($('max-deleted').value), maxChanged: Number($('max-changed').value) }));
    say($('burst-status'), 'Saved.');
  } catch (e) { say($('burst-status'), plain(e), false); }
};

$('save-budget').onclick = async () => {
  try {
    render(await api.setBudget(Number($('budget').value)));
    say($('budget-status'), 'Saved. It applies at the next daily cleanup.');
  } catch (e) { say($('budget-status'), plain(e), false); }
};

$('save-rules').onclick = async () => {
  try {
    render(await api.setRules($('rules').value));
    say($('rules-status'), $('rules').value.trim() ? 'Saved. New briefs use these rules.' : 'Empty, so briefs use the default rules.');
  } catch (e) { say($('rules-status'), plain(e), false); }
};

$('login').onchange = async (e) => { render(await api.setOpenAtLogin(e.target.checked)); };
$('open-data').onclick = () => api.openDataFolder().catch(() => {});
$('open-log').onclick = () => api.openLog().catch(() => {});
$('open-limits').onclick = () => api.openLimits().catch(() => {});

$('reset').onclick = async () => {
  const d = $('reset-dialog');
  d.returnValue = 'cancel';
  d.showModal();
  await new Promise((r) => d.addEventListener('close', r, { once: true }));
  if (d.returnValue !== 'ok') return;
  say($('reset-status'), 'Resetting…');
  try {
    render(await api.resetAll());
    say($('reset-status'), 'All settings are back to the defaults.');
  } catch (e) { say($('reset-status'), plain(e), false); }
};

api.get().then(render);
