// Settings: the Computer use section. Its own file and its own scope, so it shares nothing with settings.js but the
// page. Everything goes through window.settings (settings-preload.js, app/computer-main.js).
//
// The switch never downloads anything by itself: turning it on without cua-driver opens a dialog with the size,
// the source, the pinned SHA-256 and the folder, and only Download starts it.
(() => {
  const api = window.settings;
  const byId = (id) => document.getElementById(id);
  const plain = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'disabled') e.disabled = v;
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  function ask(dialog) {
    dialog.returnValue = 'cancel';
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  }
  const say = (id, text, ok = true) => { const p = byId(id); p.className = ok ? 'good' : 'error'; p.textContent = text; };

  let view = null;
  let busy = false;

  function render(v) {
    if (!v) return;
    view = v;
    byId('cu-on').checked = v.on;
    byId('cu-on').disabled = busy || !!v.downloading;
    byId('cu-on-label').textContent = v.on ? 'On' : 'Off';
    byId('cu-status').textContent = v.supported ? v.status : `${v.status} Computer use works on Windows only.`;
    byId('cu-resume-row').hidden = !(v.on && v.paused);

    const d = v.driver;
    byId('cu-driver-text').textContent = `Computer use runs through cua-driver ${d.version} by Cua (open source, MIT licence). `
      + `Mewndo downloads one pinned release (${d.size ? mb(d.size) : 'size unknown'}, about ${d.unpacked ? mb(d.unpacked) : '?'} unpacked) `
      + `into ${d.folder ?? 'your local app data'} and checks every file's SHA-256 before anything runs.`;
    const dl = byId('cu-download');
    dl.hidden = d.verified || !d.size;
    dl.disabled = busy || !!v.downloading;
    dl.textContent = d.problem && !d.missing ? `Download again (${mb(d.size)})…` : `Download (${d.size ? mb(d.size) : '?'})…`;
    const progress = byId('cu-progress');
    progress.hidden = !v.downloading;
    if (v.downloading) {
      progress.max = v.downloading.total || 1;
      progress.value = v.downloading.received;
      say('cu-driver-status', `Downloading: ${mb(v.downloading.received)} of ${mb(v.downloading.total)}`);
    } else if (d.verified) say('cu-driver-status', `cua-driver ${d.version} is downloaded and checked.`);
    else if (d.problem) say('cu-driver-status', d.problem, false);
    else say('cu-driver-status', 'Not downloaded.', true);

    byId('cu-command').textContent = v.command;
    byId('cu-agents').replaceChildren(...v.agents.map((a) => el('div', { class: 'cu-agent' },
      el('span', { class: 'cu-name' }, a.name),
      el('span', { class: 'muted' }, a.error ? a.error : a.installed ? `Added (${a.file})` : 'Not added'),
      el('button', { disabled: !!a.error, onclick: () => setupAgent(a.agent).catch((e) => say('cu-status', plain(e), false)) },
        a.installed ? 'Remove…' : 'Add…'))));
    byId('cu-limits').replaceChildren(...v.limits.map((t) => el('li', {}, t)));
  }

  async function download() {
    const d = view.driver;
    byId('cu-dl-size').textContent = `${mb(d.size)} to download, about ${mb(d.unpacked)} once unpacked`;
    byId('cu-dl-url').textContent = d.url;
    byId('cu-dl-sha').textContent = d.sha256;
    byId('cu-dl-dir').textContent = d.folder;
    if ((await ask(byId('cu-download-dialog'))) !== 'ok') return false;
    busy = true;
    try {
      render(await api.computerDownload());
      return true;
    } catch (e) {
      say('cu-driver-status', plain(e), false);
      return false;
    } finally {
      busy = false;
      render(await api.computerView());
    }
  }

  byId('cu-on').onchange = async (e) => {
    const want = e.target.checked;
    busy = true;
    try {
      let v = await api.computerSet(want);
      if (v.needsDownload) {
        busy = false;
        render(v);
        if (!(await download())) return render(await api.computerView());
        busy = true;
        v = await api.computerSet(true);
      }
      busy = false;
      render(v);
    } catch (err) {
      busy = false;
      say('cu-status', plain(err), false);
      render(await api.computerView().catch(() => view));
    }
  };
  byId('cu-download').onclick = () => download();
  byId('cu-resume').onclick = async () => {
    try { render(await api.computerResume()); } catch (e) { say('cu-status', plain(e), false); }
  };

  // The same confirm as connecting an agent's hooks: the file, what is added, then Add or Remove.
  async function setupAgent(agent) {
    byId('cu-mcp-error').textContent = '';
    const okButton = byId('cu-mcp-ok');
    let plan;
    try {
      plan = await api.computerMcpPlan(agent);
    } catch (e) {
      byId('cu-mcp-title').textContent = 'This agent can\'t be connected';
      byId('cu-mcp-about').textContent = '';
      byId('cu-mcp-file').textContent = '';
      byId('cu-mcp-note').textContent = '';
      byId('cu-mcp-preview').textContent = '';
      byId('cu-mcp-error').textContent = plain(e);
      okButton.disabled = true;
      await ask(byId('cu-mcp-dialog'));
      okButton.disabled = false;
      return;
    }
    byId('cu-mcp-title').textContent = plan.installed ? `Remove Mewndo's computer tools from ${plan.name}?` : `Add Mewndo's computer tools to ${plan.name}?`;
    byId('cu-mcp-about').textContent = `${plan.about} A running ${plan.name} picks it up when it restarts.`;
    byId('cu-mcp-file').textContent = plan.file;
    byId('cu-mcp-note').textContent = plan.note;
    byId('cu-mcp-preview').textContent = plan.preview;
    okButton.textContent = plan.installed ? 'Remove' : 'Add';
    if ((await ask(byId('cu-mcp-dialog'))) !== 'ok') return;
    if (plan.installed) {
      const r = await api.computerMcpRemove(agent);
      render(r.view);
      say('cu-status', `Removed from ${plan.name}.${r.backup ? ` The previous settings were saved to ${r.backup}.` : ''}`);
    } else {
      const r = await api.computerMcpInstall(agent);
      render(r.view);
      say('cu-status', `Added to ${plan.name}.${r.backup ? ` The previous settings were saved to ${r.backup}.` : ''} Restart ${plan.name} to use it.`);
    }
  }

  api.onComputer((v) => render(v));
  api.computerView().then(render, (e) => say('cu-status', plain(e), false));
})();
