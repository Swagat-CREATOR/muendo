// The window. No Node access: everything goes through window.mewndo (see preload.js).
const api = window.mewndo;
const $ = (id) => document.getElementById(id);

// Build an element. Text is always set as text, never parsed as HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Replace an element's children, skipping null/false like h() does (replaceChildren would print "null").
const fill = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c != null && c !== false));

// Windows paths ignore case.
const samePath = (a, b) => (state?.windows ? a.toLowerCase() === b.toLowerCase() : a === b);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const when = (iso) => new Date(iso).toLocaleString();
function size(bytes) {
  if (bytes == null) return '…';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${i ? bytes.toFixed(1) : bytes} ${units[i]}`;
}
// "Claude Code", or "Claude Code (likely)" when Mewndo guessed it from the running agents.
const agentText = (sp) => (sp.agent ? `${sp.agent}${sp.agentLikely ? ' (likely)' : ''}` : '');

const TRIGGERS = {
  manual: 'Manual', brief: 'Brief', activity: 'Automatic', agent: 'Agent', hook: 'Hook', 'before-undo': 'Before undo',
};

let state = null;
let selected = null; // root of the selected folder
let selectedSp = null; // save point whose changes are shown
let diff = null;
let busy = false;
const progress = new Map();

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 7000);
}

// Run an async action, showing any error instead of failing silently.
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
};

// --- First run -------------------------------------------------------------------------------------------------

// { path, checked, error, already }. `already`: Mewndo is protecting it from an earlier, unfinished setup.
const setupFolders = [];

function renderSetup() {
  const list = $('setup-folders');
  list.replaceChildren(...setupFolders.map((f) => h('li', {},
    h('label', {}, h('input', { type: 'checkbox', checked: f.checked, onchange: (e) => { f.checked = e.target.checked; renderSetup(); } }), ` ${f.path}`),
    f.already && h('div', { class: 'muted' }, f.checked
      ? `Already being protected (${f.already}). Untick to stop protecting it.`
      : 'Mewndo will stop protecting this folder.'),
    f.error && h('div', { class: 'error' }, f.error))));
}

function showSetup() {
  // Folders already protected (from an earlier attempt) are shown first, so nothing runs out of sight.
  // The engine re-registers remembered folders a moment after launch, so a folder first listed as a
  // suggestion can turn out to be protected already: mark it then, keeping whatever the user ticked.
  let changed = false;
  for (const f of state.folders) {
    const known = setupFolders.find((x) => samePath(x.path, f.root));
    if (known) {
      if (known.already !== f.status) { known.already = f.status; changed = true; }
    } else {
      setupFolders.unshift({ path: f.root, checked: true, error: null, already: f.status });
      changed = true;
    }
  }
  if (!setupFolders.some((f) => !f.already)) {
    for (const p of state.suggestions) {
      if (!setupFolders.some((f) => samePath(f.path, p))) { setupFolders.push({ path: p, checked: true, error: null }); changed = true; }
    }
  }
  $('setup-login-wrap').hidden = !state.loginSupported;
  if (changed || !$('setup-folders').children.length) renderSetup();
}

$('setup-add').onclick = guard(async () => {
  for (const p of await api.chooseFolders()) {
    if (!setupFolders.some((f) => samePath(f.path, p))) setupFolders.push({ path: p, checked: true, error: null });
  }
  renderSetup();
});

$('setup-start').onclick = guard(async () => {
  const toProtect = setupFolders.filter((f) => f.checked && !f.already);
  const toStop = setupFolders.filter((f) => !f.checked && f.already);
  const kept = setupFolders.filter((f) => f.checked && f.already);
  if (!toProtect.length && !kept.length) {
    $('setup-error').textContent = 'Choose at least one folder to protect.';
    return;
  }
  $('setup-start').disabled = true;
  try {
    for (const f of toStop) {
      $('setup-error').textContent = `Stopping protection of ${f.path}…`;
      await api.unprotect(f.path, true);
      setupFolders.splice(setupFolders.indexOf(f), 1);
    }
    $('setup-error').textContent = toProtect.length ? 'Checking folders…' : '';
    const results = toProtect.length ? await api.protect(toProtect.map((f) => f.path)) : [];
    for (const r of results) {
      const f = setupFolders.find((x) => x.path === r.root);
      f.error = r.ok ? null : r.error;
      if (r.ok) f.checked = false; // done; don't protect twice
    }
    renderSetup();
    if (!kept.length && !results.some((r) => r.ok)) {
      $('setup-error').textContent = 'None of the chosen folders can be protected. Choose others.';
      return;
    }
    $('setup-error').textContent = '';
    await api.finishSetup($('setup-login').checked);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) toast(`Not protected: ${failed.map((r) => `${r.root} (${r.error})`).join('; ')}`);
    await refresh();
  } finally {
    $('setup-start').disabled = false;
  }
});

// --- Main window: folders --------------------------------------------------------------------------------------

function statusText(f) {
  const p = progress.get(f.root) ?? f.progress;
  if (f.status === 'scanning') {
    if (p?.phase === 'hashing') return `First scan: saving copies, ${p.hashed} of ${p.toHash}`;
    return `Scanning… ${p?.found ?? 0} files found`;
  }
  if (f.status === 'restoring') {
    if (p?.phase === 'restoring') return `Restoring… ${p.done} of ${p.total}`;
    return 'Restoring: verifying…';
  }
  if (f.status === 'paused') return 'Paused';
  if (f.status === 'unavailable') return "Unavailable: can't be found (unplugged drive?). Resumes when it's back.";
  return 'Protected';
}

function progressBar(f) {
  const p = progress.get(f.root) ?? f.progress;
  if (f.status === 'scanning' && p?.phase === 'hashing') return h('progress', { max: p.toHash || 1, value: p.hashed });
  if (f.status === 'restoring' && p?.phase === 'restoring') return h('progress', { max: p.total || 1, value: p.done });
  if (f.status === 'scanning' || f.status === 'restoring') return h('progress');
  return null;
}

function renderFolders() {
  $('folders').replaceChildren(...state.folders.map((f) => h('li', {
    class: f.root === selected ? 'selected' : '', tabindex: 0, title: f.root,
    onclick: () => selectFolder(f.root),
    onkeydown: (e) => { if (e.key === 'Enter') selectFolder(f.root); },
  },
  h('div', { class: 'name' }, f.name),
  h('div', { class: 'muted' }, `${f.files.toLocaleString()} file${f.files === 1 ? '' : 's'} protected · ${size(f.storageBytes)}`),
  h('div', { class: f.status === 'paused' || f.status === 'unavailable' ? 'error' : '' }, statusText(f)),
  progressBar(f))));
  if (!state.folders.length) $('folders').append(h('li', { class: 'muted' }, 'No folders yet.'));
  const s = state.usedBytes != null
    ? `History uses ${size(state.usedBytes)} of ${size(state.budgetBytes)}. Trash: ${size(state.trashBytes)}.`
    : '';
  $('storage-summary').textContent = s;
}

// mewndo-core, the version 1 service. It does no file work yet, so whatever its state, protection carries on.
const CORE_TEXT = {
  starting: 'Core: starting…', running: 'Core: running', 'not-responding': 'Core: not responding',
  restarting: 'Core: restarting…', failed: 'Core: stopped', missing: 'Core: not built', stopped: 'Core: stopped',
};
function renderCore(core) {
  $('core-status').hidden = !core;
  if (!core) return;
  $('core-status').textContent = CORE_TEXT[core.state] ?? `Core: ${core.state}`;
  $('core-status').className = core.state === 'failed' || core.state === 'not-responding' ? 'error' : 'muted';
  const what = core.state === 'running' ? `mewndo-core ${core.version} is running (process ${core.pid}).` : (core.message ?? '');
  $('core-status').title = `${what} The core does no file work yet: your folders are protected by the engine either way.`.trim();
}

function renderHeader() {
  const until = state.pausedUntil;
  $('pause-status').textContent = until ? `Protection paused until ${new Date(until).toLocaleTimeString()}` : '';
  $('pause').textContent = until ? 'Resume protection' : 'Pause protection for 1 hour';
  $('login-wrap').hidden = !state.loginSupported;
  // Warnings from Mewndo (storage, low disk, unavailable folders, watcher trouble) stay until resolved or dismissed.
  $('alerts').hidden = !state.alerts?.length;
  $('alerts').replaceChildren(...(state.alerts ?? []).map((a) => h('li', { class: 'error' }, a.message, ' ',
    h('button', { onclick: guard(() => api.dismissAlert(a.code, a.folder)), 'aria-label': 'Dismiss this warning' }, 'Dismiss'))));
  $('shortcut-problem').hidden = !state.shortcutProblem;
  $('shortcut-problem').textContent = state.shortcutProblem ?? '';
  $('hook-problem').hidden = !state.hookProblem;
  $('hook-problem').textContent = state.hookProblem ?? '';
  renderCore(state.core);
  const names = (state.agents ?? []).map((a) => a.name);
  $('agents').textContent = names.length ? `AI agents running: ${names.join(', ')}` : 'No AI agents running';
  $('agents').className = names.length ? 'running' : 'muted';
  $('login').checked = state.openAtLogin;
}

$('pause').onclick = guard(async () => { await api.togglePause(); await refresh(); });
$('open-settings').onclick = guard(() => api.openSettings());
$('open-limits').onclick = guard((e) => { e.preventDefault(); return api.openLimits(); });
$('login').onchange = guard(async (e) => api.setOpenAtLogin(e.target.checked));

$('add-folder').onclick = guard(async () => {
  const paths = await api.chooseFolders();
  if (!paths.length) return;
  toast(`Checking ${plural(paths.length, 'folder')}…`); // measuring size can take a moment
  const results = await api.protect(paths);
  $('toast').hidden = true;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) toast(failed.map((r) => `${r.root}: ${r.error}`).join('\n'));
  const ok = results.find((r) => r.ok);
  await refresh();
  if (ok) {
    const f = state.folders.find((x) => x.root === ok.root || x.root.toLowerCase() === ok.root.toLowerCase());
    if (f) selectFolder(f.root);
  }
});

// --- Main window: selected folder ------------------------------------------------------------------------------

async function selectFolder(root) {
  if (busy) return;
  selected = root;
  selectedSp = null;
  diff = null;
  renderFolders();
  const f = state.folders.find((x) => x.root === root);
  $('no-folder').hidden = true;
  $('folder-view').hidden = false;
  $('folder-title').textContent = f.name;
  $('folder-path').textContent = f.root;
  $('diff-view').hidden = true;
  $('result').hidden = true;
  await Promise.all([loadSavePoints(), loadRestores()]);
}

const loadSavePoints = guard(async () => {
  if (!selected) return;
  const root = selected;
  const sps = await api.savePoints(root);
  if (root !== selected) return;
  $('no-savepoints').hidden = sps.length > 0;
  $('savepoints').querySelector('tbody').replaceChildren(...sps.map((sp) => h('tr', {
    class: sp.id === selectedSp?.id ? 'selected' : '', tabindex: 0,
    onclick: () => showDiff(sp),
    onkeydown: (e) => { if (e.key === 'Enter') showDiff(sp); },
  },
  h('td', {}, when(sp.createdAt)), h('td', {}, sp.label || ''), h('td', {}, TRIGGERS[sp.trigger] ?? sp.trigger),
  h('td', {}, agentText(sp)))));
});

$('create-sp').onclick = guard(async () => {
  if (!selected) return;
  $('create-sp').disabled = true;
  try {
    await api.createSavePoint(selected, $('sp-label').value);
    $('sp-label').value = '';
    toast('Save point created.');
    await loadSavePoints();
  } finally { $('create-sp').disabled = false; }
});

$('stop-protecting').onclick = guard(async () => {
  const f = state.folders.find((x) => x.root === selected);
  $('unprotect-name').textContent = f.name;
  const answer = await ask($('unprotect'));
  if (answer !== 'ok') return;
  const keep = $('unprotect').querySelector('input[name=history]:checked').value === 'keep';
  toast(`Stopping protection of ${f.name}…`);
  await api.unprotect(selected, keep);
  toast(`${f.name} is no longer protected.`);
  selected = null;
  $('folder-view').hidden = true;
  $('no-folder').hidden = false;
  await refresh();
});

function ask(dialog) {
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

// --- What changed, and restoring -------------------------------------------------------------------------------

const MAX_LISTED = 2000; // per group; everything is still restored with All

const showDiff = guard(async (sp) => {
  if (busy) return;
  selectedSp = sp;
  await loadSavePoints();
  $('diff-view').hidden = false;
  $('result').hidden = true;
  $('restore-status').textContent = '';
  $('diff-when').textContent = when(sp.createdAt);
  $('diff-summary').textContent = 'Comparing…';
  $('diff-lists').replaceChildren();
  const root = selected;
  const d = await api.diff(root, sp.id);
  if (root !== selected || sp !== selectedSp) return;
  diff = d;
  $('diff-summary').textContent = d.summary;
  $('select-all').checked = true;
  const group = (title, items) => items.length && [
    h('h4', {}, `${title} (${items.length})`),
    h('ul', {}, ...items.slice(0, MAX_LISTED).map((it) => h('li', {}, h('label', {},
      h('input', { type: 'checkbox', checked: true, 'data-paths': JSON.stringify(it.paths), onchange: syncAll }), ` ${it.text}`))),
    items.length > MAX_LISTED && h('p', { class: 'muted' }, `…and ${items.length - MAX_LISTED} more, restored when All is ticked.`)),
  ];
  $('diff-lists').replaceChildren(...[
    group('Deleted', d.deleted.map((p) => ({ paths: [p], text: p }))),
    group('Edited', d.edited.map((p) => ({ paths: [p], text: p }))),
    group('Moved', d.moved.map((m) => ({ paths: [m.from, m.to], text: `${m.from} → ${m.to}` }))),
    group('Created', d.created.map((p) => ({ paths: [p], text: `${p} (goes to Mewndo's trash)` }))),
  ].filter(Boolean).flat());
  const nothing = !d.deleted.length && !d.edited.length && !d.moved.length && !d.created.length;
  $('undo-in-place').disabled = nothing;
  $('restore-separate').disabled = false;
});

const fileBoxes = () => [...$('diff-lists').querySelectorAll('input[type=checkbox]')];
function syncAll() {
  const boxes = fileBoxes();
  $('select-all').checked = boxes.every((b) => b.checked);
}
$('select-all').onchange = (e) => { for (const b of fileBoxes()) b.checked = e.target.checked; };

// null = All (the whole folder). Otherwise the ticked paths.
function chosenPaths() {
  if ($('select-all').checked) return null;
  return [...new Set(fileBoxes().filter((b) => b.checked).flatMap((b) => JSON.parse(b.dataset.paths)))];
}

function setBusy(on, message = '') {
  busy = on;
  for (const id of ['undo-in-place', 'restore-separate', 'create-sp', 'stop-protecting']) $(id).disabled = on;
  $('restore-status').textContent = message;
}

async function confirmPlan(title, okLabel, plan) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = plan.text;
  $('confirm-ok').textContent = okLabel;
  const replaced = plan.overwrites;
  fill($('confirm-list'), ...replaced.slice(0, 50).map((p) => h('li', {}, `${p} (edited after the save point)`)),
    replaced.length > 50 ? h('li', {}, `…and ${replaced.length - 50} more`) : null);
  return (await ask($('confirm'))) === 'ok';
}

$('undo-in-place').onclick = guard(async () => {
  const paths = chosenPaths();
  if (paths && !paths.length) return toast('Tick at least one file, or All.');
  const plan = await api.plan(selected, selectedSp.id, paths);
  if (!(await confirmPlan(`Undo in place to ${when(selectedSp.createdAt)}?`, 'Undo in place', plan))) return;
  await runRestore(() => api.restore(selected, selectedSp.id, paths, 'in-place'));
});

$('restore-separate').onclick = guard(async () => {
  const paths = chosenPaths();
  if (paths && !paths.length) return toast('Tick at least one file, or All.');
  await runRestore(() => api.restore(selected, selectedSp.id, paths, 'separate'));
});

async function runRestore(fn) {
  setBusy(true, 'Restoring…');
  try {
    const result = await fn();
    if (result) showResult(result);
  } finally {
    setBusy(false);
    await Promise.all([loadSavePoints(), loadRestores(), refresh()]);
  }
}

function showResult(r) {
  const box = $('result');
  box.hidden = false;
  fill(box,
    h('p', { class: r.verified ? 'good' : 'error' },
      h('strong', {}, r.verified ? 'Verified: true' : 'Verified: false'),
      r.verified ? ' Every restored file matches the save point exactly.' : ' Some files do not match the save point. See below.'),
    h('p', {}, `${plural(r.counts.written, 'file')} put back, ${plural(r.counts.linked, 'link')} recreated, `
      + `${plural(r.counts.trashed, 'new file')} moved to Mewndo's trash, ${plural(r.counts.foldersCreated, 'folder')} recreated, `
      + `${plural(r.counts.foldersRemoved, 'empty folder')} removed.`),
    r.retried.length ? h('p', {}, `${plural(r.retried.length, 'file')} were locked for a moment and succeeded on retry.`) : null,
    r.failures.length ? h('div', {}, h('p', { class: 'error' }, `${plural(r.failures.length, 'problem')}:`),
      h('ul', {}, ...r.failures.map((f) => h('li', {}, f.message)))) : null,
    r.mismatches.length ? h('p', { class: 'error' }, `Still different: ${r.mismatches.slice(0, 20).join(', ')}${r.mismatches.length > 20 ? '…' : ''}`) : null,
    h('div', { class: 'row' },
      r.beforeUndoId ? null : h('button', { onclick: guard(() => api.openPath(r.folder)) }, 'Open restored folder'),
      r.trashUsed ? h('button', { onclick: guard(() => api.openPath(r.trashFolder)) }, "Open Mewndo's trash for this restore") : null),
  );
}

api.on('retry', (r) => {
  if (r.root === selected) $('restore-status').textContent = `Waiting for a locked file: ${r.path} (attempt ${r.attempt})…`;
});

// --- Recent restores -------------------------------------------------------------------------------------------

const loadRestores = guard(async () => {
  if (!selected) return;
  const root = selected;
  const list = (await api.restores(root)).slice(0, 20);
  if (root !== selected) return;
  $('no-restores').hidden = list.length > 0;
  $('restores').replaceChildren(...list.map((r) => {
    const res = r.result;
    const status = r.status !== 'done' ? h('span', { class: 'error' }, 'Unfinished: it will finish next time Mewndo starts')
      : h('span', { class: res.verified ? 'good' : 'error' }, res.verified ? 'Verified' : 'Not verified');
    return h('li', {},
      h('span', {}, when(r.startedAt)),
      h('span', {}, r.inPlace ? 'In place' : 'To a separate folder'),
      r.paths ? h('span', { class: 'muted' }, plural(r.paths.length, 'chosen path')) : h('span', { class: 'muted' }, 'All files'),
      status,
      res ? h('span', { class: 'muted' }, `${plural(res.counts.written, 'file')} put back`) : null,
      r.inPlace && r.status === 'done' && r.beforeUndoId
        ? h('button', { onclick: guard(() => undoRestore(r)) }, 'Undo this restore') : null,
      !r.inPlace && r.status === 'done' ? h('button', { onclick: guard(() => api.openPath(r.base)) }, 'Open folder') : null);
  }));
});

async function undoRestore(r) {
  const plan = await api.plan(selected, r.beforeUndoId, null);
  if (!(await confirmPlan(`Undo the restore from ${when(r.startedAt)}?`, 'Undo this restore', plan))) return;
  await runRestore(() => api.undoRestore(selected, r.id));
}

// --- Claude Code hooks -----------------------------------------------------------------------------------------

async function loadHookStatus() {
  try {
    const plan = await api.claudeHooksPlan();
    $('claude-hooks-status').textContent = plan.installed ? 'Set up: Claude Code sessions make exact save points.' : 'Not set up yet.';
    $('claude-hooks').textContent = plan.installed ? 'Show Claude Code setup…' : 'Set up Claude Code save points…';
  } catch (e) {
    $('claude-hooks-status').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

// Show exactly what will be added to the agent's settings, then add it only if the user says so.
async function setupHooks(agent) {
  const name = AGENT_NAMES[agent];
  $('hooks-title').textContent = agent === 'claude' ? 'Add Mewndo to Claude Code?' : `Add Mewndo's Guard to ${name}?`;
  $('hooks-about-claude').hidden = agent !== 'claude';
  $('hooks-about-agent').hidden = agent === 'claude';
  for (const el of document.querySelectorAll('.agent-name')) el.textContent = name;
  $('hooks-error').textContent = '';
  let plan;
  try {
    plan = agent === 'claude' ? await api.claudeHooksPlan() : await api.agentHooksPlan(agent);
  } catch (e) {
    $('hooks-path').textContent = '';
    $('hooks-note').textContent = '';
    $('hooks-preview').textContent = '';
    $('hooks-error').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('hooks-ok').disabled = true;
    await ask($('hooks-dialog'));
    $('hooks-ok').disabled = false;
    return;
  }
  $('hooks-path').textContent = plan.settingsPath;
  $('hooks-note').textContent = plan.installed ? 'These hooks are already set up; nothing needs to change.'
    : plan.exists ? 'Everything already in this file stays as it is. A backup of the current file is saved next to it first.'
      : 'This file does not exist yet and will be created.';
  $('hooks-preview').textContent = plan.preview;
  $('hooks-ok').disabled = plan.installed;
  if ((await ask($('hooks-dialog'))) !== 'ok') return;
  const result = agent === 'claude' ? await api.claudeHooksInstall() : await api.agentHooksInstall(agent);
  const after = agent === 'claude' ? 'New Claude Code sessions make exact save points and ask Mewndo first.' : `New ${name} sessions ask Mewndo first.`;
  toast(result.backup ? `Added. The previous settings were saved to ${result.backup}. ${after}` : `Added. ${after}`);
  if (agent === 'claude') await loadHookStatus();
}
$('claude-hooks').onclick = guard(() => setupHooks('claude'));
$('codex-hooks').onclick = guard(() => setupHooks('codex'));
$('cursor-hooks').onclick = guard(() => setupHooks('cursor'));

// --- Brief safety rules ---------------------------------------------------------------------------------------

$('edit-rules').onclick = guard(async () => {
  const current = await api.safetyRules();
  $('rules-text').value = current.rules;
  const answer = await ask($('rules-dialog'));
  if (answer === 'ok') {
    await api.setSafetyRules($('rules-text').value);
    toast('Safety rules saved. New briefs use them.');
  } else if (answer === 'reset') {
    await api.setSafetyRules(null);
    toast('Safety rules reset to the defaults.');
  }
});

// --- Keeping up to date ----------------------------------------------------------------------------------------

let hookStatusLoaded = false;
async function refresh() {
  state = await api.state();
  if (state.setupDone && !hookStatusLoaded) { hookStatusLoaded = true; loadHookStatus(); }
  $('setup').hidden = state.setupDone;
  $('main').hidden = !state.setupDone;
  if (!state.setupDone) return showSetup();
  renderHeader();
  if (selected && !state.folders.some((f) => f.root === selected)) {
    selected = null;
    $('folder-view').hidden = true;
    $('no-folder').hidden = false;
  }
  renderFolders();
}

api.on('state-changed', guard(refresh));
api.on('progress', (p) => {
  if (p.phase === 'checking') { // measuring a folder before protecting it
    const text = `Checking ${p.root}: ${p.files.toLocaleString()} files so far…`;
    if (state && !state.setupDone) $('setup-error').textContent = text;
    else toast(text);
    return;
  }
  progress.set(p.root, p);
  if (state?.setupDone) renderFolders();
  if (p.phase === 'done') guard(refresh)();
});
api.on('savepoints-changed', (root) => { if (root === selected && !busy) loadSavePoints(); });
api.on('restores-changed', (root) => { if (root === selected) loadRestores(); });
api.on('toast', toast);
setInterval(() => { if (!document.hidden) guard(refresh)(); }, 3000); // nothing to show while hidden in the tray
document.addEventListener('visibilitychange', () => { if (!document.hidden) guard(refresh)(); });
guard(refresh)();
