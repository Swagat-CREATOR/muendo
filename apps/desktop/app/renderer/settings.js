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
  $('engine').value = s.engine;
  $('guard-fail-open').checked = s.guardFailOpen;
  $('data-dir').textContent = s.dataDir;
  if (s.notify) renderNotify(s.notify);
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
$('engine').onchange = async (e) => { render(await api.setEngine(e.target.value)); };
$('guard-fail-open').onchange = async (e) => { render(await api.setGuardFailOpen(e.target.checked)); };
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

// --- Habits: the rules Mewndo learned from your answers (app/habits-file.js reads and edits rules.toml) ------------

const LIST_WORDS = { allow: 'Always allow', deny: 'Always deny' };
const AGENT_WORDS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
let habitsSeen = null; // the last list drawn, to redraw only when the file changed

function renderHabits(result) {
  const key = JSON.stringify(result);
  if (key === habitsSeen) return;
  habitsSeen = key;
  $('habits-file').textContent = result.file ? `Rules file: ${result.file}` : '';
  if (result.problem) return putIn($('habits'), h('p', { class: 'error' }, result.problem));
  if (!result.rules.length) {
    return putIn($('habits'), h('div', { class: 'habit-empty' },
      h('p', {}, 'No learned rules yet.'),
      h('p', { class: 'muted' }, 'Answer a permission card the same way three times for the same command in a project, and Mewndo '
        + 'offers to remember it. Each rule you accept shows up here, with Remove.')));
  }
  putIn($('habits'), ...result.rules.map((r) => h('div', { class: 'habit-row' },
    h('span', { class: `habit-chip ${r.list}` }, LIST_WORDS[r.list]),
    h('div', { class: 'habit-what' },
      h('div', { class: 'mono habit-command' }, r.command),
      h('div', { class: 'muted' }, [
        r.agent ? (AGENT_WORDS[r.agent] ?? r.agent) : 'Agent not recorded',
        r.project ? `learned in ${r.project}` : 'project not recorded',
        `on ${new Date(`${r.date}T12:00:00`).toLocaleDateString()}`,
      ].join(' · '))),
    h('button', { onclick: () => removeHabit(r), 'aria-label': `Remove the rule for ${r.command}` }, 'Remove'))));
}

const putIn = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));

async function loadHabits() {
  try { renderHabits(await api.habits()); } catch (e) { say($('habits-status'), plain(e), false); }
}

async function removeHabit(rule) {
  const d = $('habit-dialog');
  $('habit-dialog-text').textContent = `${LIST_WORDS[rule.list]}: ${rule.command}`;
  d.returnValue = 'cancel';
  d.showModal();
  await new Promise((r) => d.addEventListener('close', r, { once: true }));
  if (d.returnValue !== 'ok') return;
  try {
    renderHabits(await api.removeHabit(rule));
    say($('habits-status'), 'Removed. It stops applying the next time Mewndo starts.');
  } catch (e) {
    say($('habits-status'), plain(e), false);
    await loadHabits();
  }
}

// The core writes the file when you accept a Habit card: while this page shows, look again every 2 seconds.
setInterval(() => { if (!document.hidden && !$('habits').closest('.set-page').hidden) loadHabits(); }, 2000);

// --- Notifications: Do not disturb and the card sound (app/quiet.js decides, main.js saves) -----------------------

const dndClock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function renderNotify(n) {
  for (const r of document.querySelectorAll('input[name=dnd]')) r.checked = r.value === n.dnd.mode;
  if (document.activeElement !== $('dnd-from')) $('dnd-from').value = n.dnd.from;
  if (document.activeElement !== $('dnd-to')) $('dnd-to').value = n.dnd.to;
  $('dnd-now').textContent = {
    off: 'Off. Cards pop up beside the dock as they arrive.',
    hour: `On until ${dndClock(n.dnd.until)}.`,
    tomorrow: `On until ${new Date(n.dnd.until).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}.`,
    hours: `Every day from ${n.dnd.from} to ${n.dnd.to}. ${n.quietNow ? 'On right now.' : 'Off right now.'}`,
  }[n.dnd.mode];
  $('dnd-now').className = n.quietNow ? 'dnd-now on' : 'dnd-now';
  $('sound-on').checked = n.sound.on;
  $('sound-volume').value = Math.round(n.sound.volume * 100);
  $('sound-volume-text').textContent = `${Math.round(n.sound.volume * 100)} %`;
  $('sound-volume').disabled = !n.sound.on;
}

async function saveNotify(patch, status) {
  try {
    render(await api.setNotify(patch));
    $(status).textContent = '';
  } catch (e) {
    if (current?.notify) renderNotify(current.notify); // back to what is saved
    say($(status), plain(e), false);
  }
}
const dndPatch = (mode) => ({ dnd: { mode, from: $('dnd-from').value, to: $('dnd-to').value } });
for (const r of document.querySelectorAll('input[name=dnd]')) r.addEventListener('change', () => saveNotify(dndPatch(r.value), 'dnd-status'));
for (const id of ['dnd-from', 'dnd-to']) {
  $(id).addEventListener('change', () => {
    if (current?.notify.dnd.mode === 'hours') saveNotify(dndPatch('hours'), 'dnd-status');
  });
}
$('sound-on').onchange = (e) => saveNotify({ sound: { on: e.target.checked } }, 'sound-status');
$('sound-volume').oninput = (e) => { $('sound-volume-text').textContent = `${e.target.value} %`; };
$('sound-volume').onchange = (e) => saveNotify({ sound: { volume: Number(e.target.value) / 100 } }, 'sound-status');
// Test plays the bundled sound here, at the slider's volume, whether or not the sound is on.
const testSound = new Audio('../assets/sounds/card.wav');
$('sound-test').onclick = () => {
  testSound.volume = Number($('sound-volume').value) / 100;
  testSound.currentTime = 0;
  testSound.play().then(() => say($('sound-status'), testSound.volume ? 'Playing the card sound.' : 'The volume is at 0 %, so it is silent.'),
    () => say($('sound-status'), "Mewndo couldn't play the sound. Check that this computer has a sound output.", false));
};
// A timed Do not disturb ends by itself: look again every minute while this page shows.
setInterval(() => {
  if (!document.hidden && !$('dnd-now').closest('.set-page').hidden) api.get().then(render, () => {});
}, 60_000);

// The section list (design spec §9): one page at a time, like Wispr's settings.
function showPage(name) {
  for (const p of document.querySelectorAll('.set-page')) p.hidden = p.dataset.page !== name;
  for (const b of document.querySelectorAll('.set-nav-item')) {
    if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  document.querySelector('.set-main').scrollTop = 0;
  if (name === 'habits') loadHabits();
}
for (const b of document.querySelectorAll('.set-nav-item')) b.addEventListener('click', () => showPage(b.dataset.page));
// A section asked for: in the address (#protection) when the window opens, or later from Mewndo.
const SETTINGS_PAGES = [...document.querySelectorAll('.set-page')].map((p) => p.dataset.page);
showPage(SETTINGS_PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'general');
api.onPage?.((page) => { if (SETTINGS_PAGES.includes(page)) showPage(page); });
api.version().then((v) => { $('version').textContent = `Mewndo ${v}`; }, () => {});

// --- Connections: where each Worker is (app/connectors). Addresses only; tokens never pass through this window. ----
async function loadConnections() {
  let s;
  try { s = await api.connectionsSettings(); } catch (e) { say($('cx-workers-status'), plain(e), false); return; }
  if (!s.credentials) say($('cx-workers-status'), s.credentialsWhy, false);
  $('cx-workers').replaceChildren(...s.workers.map((w) => {
    const box = h('input', { value: w.saved, placeholder: w.fromEnv ?? `https://mewndo-${w.id}.<you>.workers.dev`, 'aria-label': `${w.name} Worker address`, spellcheck: 'false' });
    const save = h('button', {
      onclick: async () => {
        try {
          await api.setConnectionUrl(w.id, box.value.trim());
          say($('cx-workers-status'), box.value.trim() ? `${w.name} Worker saved. Connect it in the main window.` : `${w.name} Worker address cleared.`);
        } catch (e) { say($('cx-workers-status'), plain(e), false); }
      },
    }, 'Save');
    return h('div', { class: 'set-row' },
      h('div', {}, h('h3', {}, w.name),
        h('p', { class: 'muted' }, w.fromEnv && !w.saved ? `From ${w.env}: ${w.fromEnv}` : `Deploy from ${w.folder}, or set ${w.env}.`)),
      h('div', { class: 'row' }, box, save));
  }));
  if (s.github.login) $('cx-github').textContent = `Connected as @${s.github.login}${s.github.repos.length ? `, journaling ${s.github.repos.join(', ')}` : ', no repos chosen yet'}. Change it in the main window's Connections screen.`;
}
loadConnections();
