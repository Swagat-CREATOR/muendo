// The lanes window (spec §33.7, §33.10 Part G): one xterm.js terminal per lane, tabs named after the agents, and
// the New lane picker. It draws what the main process sends and reports what the user does; lanes-model.js holds
// the state and the rules, so they are tested without a DOM.
//
// Bytes in:  lanes:data { laneId, data } straight into that lane's terminal.
// Bytes out: every keystroke (xterm onData) as `type`; the terminal's size as `resize`.
// A terminal first seen in lanes:state asks for the lane's replay (`attach`), so a lane started before this window
// shows its last 256 KB; one that starts while the window exists gets every byte live.
(function () {
  const M = window.MewLanes;
  const api = window.lanes;
  const $ = (id) => document.getElementById(id);
  const START_DEADLINE_MS = 30_000;

  let model = M.empty();
  const terms = new Map(); // laneId -> { term, fit, el }
  let startTimer = null;
  let closeArmed = null; // { laneId, timer } while "Close lane" waits for its second click

  // The float set's colours (design/tokens.css), with the 16 ANSI colours tuned to sit on it.
  const THEME = {
    background: '#121416', foreground: '#EEF1EC', cursor: '#34D6B6', cursorAccent: '#121416',
    selectionBackground: 'rgba(52, 214, 182, 0.28)',
    black: '#1C1F22', red: '#F27A70', green: '#34D6B6', yellow: '#F2B04A', blue: '#78A8FF', magenta: '#D69CF2', cyan: '#6FD3E0', white: '#DDE2DC',
    brightBlack: '#80867F', brightRed: '#FF9A90', brightGreen: '#6BE8CF', brightYellow: '#FFC870', brightBlue: '#9EC1FF', brightMagenta: '#E4B8F7',
    brightCyan: '#9BE6EF', brightWhite: '#F4F6F3',
  };

  const laneOf = (laneId) => model.lanes.find((l) => l.laneId === laneId) ?? null;
  const running = (laneId) => laneOf(laneId)?.running === true;

  // Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes; plain Ctrl+C goes to the agent, as in any terminal.
  function clipboardKeys(term) {
    return (e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      if (e.code === 'KeyV') {
        navigator.clipboard.readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
        return false;
      }
      return true;
    };
  }

  function termFor(laneId, { replay = false } = {}) {
    if (terms.has(laneId)) return terms.get(laneId);
    const el = document.createElement('div');
    // Hidden with visibility, not display: xterm measures its cells when it opens, and can't inside display: none.
    el.className = 'term off';
    el.setAttribute('role', 'tabpanel');
    $('views').insertBefore(el, $('picker'));
    const term = new window.Terminal({
      fontFamily: '"JetBrains Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
      theme: THEME,
      // Never follow a link: an OSC 8 hyperlink the agent prints does nothing when clicked.
      linkHandler: { activate() {} },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.onData((d) => { if (running(laneId)) api.action('type', laneId, d); });
    term.onBinary((d) => { if (running(laneId)) api.action('type', laneId, Uint8Array.from(d, (c) => c.charCodeAt(0) & 255)); });
    term.onResize((size) => { const m = M.resize(laneId, size); if (m) api.action(...m); });
    term.attachCustomKeyEventHandler(clipboardKeys(term));
    const t = { term, fit, el };
    terms.set(laneId, t);
    if (replay) api.action('attach', laneId);
    return t;
  }

  function dispose(laneId) {
    const t = terms.get(laneId);
    if (!t) return;
    t.term.dispose();
    t.el.remove();
    terms.delete(laneId);
  }

  // Fit the shown terminal to the window and tell the lane its size. Sent even when xterm's size didn't change,
  // because the lane starts at the core's 30 x 120, not xterm's 24 x 80; app/desk/lanes.js drops repeats.
  let fitQueued = false;
  function fitShown() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      const t = terms.get(model.selectedId);
      if (!t || t.el.classList.contains('off')) return;
      try { t.fit.fit(); } catch { return; }
      const m = M.resize(model.selectedId, { rows: t.term.rows, cols: t.term.cols });
      if (m) api.action(...m);
    });
  }

  // --- drawing ----------------------------------------------------------------------------------------------------

  function drawTabs() {
    const box = $('tabs');
    box.replaceChildren(...M.tabs(model).map((tab) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tab${tab.running ? '' : ' ended'}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(tab.selected && !model.picker.open));
      b.title = `${tab.title} in ${tab.cwd}: ${tab.status}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = tab.title;
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = tab.status;
      b.append(window.MewLogos.img(tab.title, 16), name, state);
      b.addEventListener('click', () => { model = M.select(model, tab.laneId); draw(); });
      return b;
    }));
  }

  function drawPicker() {
    const p = model.picker;
    $('picker').hidden = !p.open;
    if (!p.open) return;
    $('picks').replaceChildren(...M.PICKS.map((pick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(pick.program !== null && pick.program === p.program));
      if (!pick.program) b.setAttribute('aria-disabled', 'true');
      const top = document.createElement('span');
      top.className = 'top';
      top.append(window.MewLogos.img(pick.logo ?? pick.label, 20), document.createTextNode(pick.label));
      const sub = document.createElement('span');
      sub.className = pick.program ? 'cmd' : 'why';
      sub.textContent = pick.program ?? pick.why;
      b.append(top, sub);
      b.addEventListener('click', () => {
        if (!pick.program) return;
        model = { ...model, error: null, picker: { ...model.picker, program: pick.program, cwd: $('folder').value } };
        draw();
      });
      return b;
    }));
    const input = $('folder');
    if (document.activeElement !== input) input.value = p.cwd;
    $('folders').replaceChildren(...p.folders.map((f) => Object.assign(document.createElement('option'), { value: f })));
    $('cancel').hidden = !model.lanes.length;
    $('start').disabled = Boolean(model.waiting) || !model.connected;
    const note = $('pick-note');
    note.classList.toggle('error', Boolean(model.error));
    if (model.error) {
      note.textContent = `Couldn't start ${M.agentName(model.error.program)} in ${model.error.cwd}: ${model.error.message}`;
    } else if (model.waiting) {
      note.textContent = `Starting ${M.agentName(model.waiting.program)} in ${M.folderName(model.waiting.cwd)}…`;
    } else {
      note.textContent = '';
    }
  }

  function draw() {
    for (const t of terms.values()) t.el.classList.add('off');
    $('offline').hidden = model.connected;
    drawTabs();
    drawPicker();
    const lane = laneOf(model.selectedId);
    const shown = !model.picker.open && lane;
    $('tools').hidden = !shown;
    if (!shown) return;
    const t = termFor(lane.laneId, { replay: true });
    t.el.classList.remove('off');
    $('where').textContent = `${M.agentName(lane.program)} · ${lane.cwd} · ${M.statusText(lane)}`;
    $('brake').hidden = !lane.running;
    const armed = closeArmed?.laneId === lane.laneId;
    $('close').classList.toggle('armed', armed);
    $('close').textContent = armed ? `End ${M.agentName(lane.program)}? Click again` : 'Close lane';
    fitShown();
  }

  // --- what the main process sends --------------------------------------------------------------------------------

  api.onState((state) => {
    const before = model;
    model = M.withState(model, state);
    // A terminal for every lane the core reports, gone with the lane. One first seen here asks for the replay,
    // except the lane this window just started: every byte of that one came live.
    const ids = new Set(model.lanes.map((l) => l.laneId));
    for (const l of before.lanes) if (!ids.has(l.laneId)) dispose(l.laneId);
    if (before.waiting && !model.waiting && model.selectedId) {
      clearTimeout(startTimer);
      termFor(model.selectedId);
    }
    for (const id of ids) termFor(id, { replay: true });
    // An agent that ended while its terminal was open: say so in the terminal too, once.
    for (const lane of model.lanes) {
      const was = before.lanes.find((l) => l.laneId === lane.laneId);
      if (was?.running && !lane.running) terms.get(lane.laneId)?.term.write(M.exitLine(lane));
    }
    draw();
    if (model.picker.open !== before.picker.open && !model.picker.open) terms.get(model.selectedId)?.term.focus();
  });

  api.onData(({ laneId, data } = {}) => {
    if (!laneId || !data) return;
    termFor(String(laneId)).term.write(data instanceof Uint8Array ? data : new Uint8Array(data));
  });

  api.onOpen((laneId) => {
    model = M.select(model, String(laneId));
    draw();
    terms.get(model.selectedId)?.term.focus();
  });

  api.onPick((preset) => {
    model = M.openPicker(model, preset ?? {});
    draw();
    $('start').focus();
  });

  api.onError((error) => {
    clearTimeout(startTimer);
    model = M.withError(model, error);
    draw();
  });

  // --- what the user does -----------------------------------------------------------------------------------------

  function start() {
    const out = M.start(model, { program: model.picker.program, cwd: $('folder').value });
    model = out.model;
    if (out.why) {
      $('pick-note').textContent = out.why;
      $('pick-note').classList.add('error');
      return;
    }
    api.action(...out.send);
    clearTimeout(startTimer);
    const waited = model.waiting;
    startTimer = setTimeout(() => {
      if (model.waiting !== waited) return;
      model = M.withError(model, { ...waited, message: "Mewndo's core didn't answer in 30 seconds." });
      draw();
    }, START_DEADLINE_MS);
    draw();
  }

  $('new').addEventListener('click', () => { model = M.openPicker(model, {}); draw(); $('start').focus(); });
  $('start').addEventListener('click', start);
  $('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  $('cancel').addEventListener('click', () => { model = { ...model, error: null, picker: { ...model.picker, open: false } }; draw(); });
  $('picker').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && model.lanes.length) $('cancel').click();
  });
  $('brake').addEventListener('click', () => { if (model.selectedId) api.action('brake', model.selectedId); });
  $('close').addEventListener('click', () => {
    const id = model.selectedId;
    if (!id) return;
    // Closing a running lane stops its agent, so it takes a second click. An ended lane just goes.
    if (running(id) && closeArmed?.laneId !== id) {
      clearTimeout(closeArmed?.timer);
      closeArmed = { laneId: id, timer: setTimeout(() => { closeArmed = null; draw(); }, 3000) };
      draw();
      return;
    }
    clearTimeout(closeArmed?.timer);
    closeArmed = null;
    api.action('close', id);
  });

  new ResizeObserver(fitShown).observe($('views'));
  draw();
}());
