// The Connections screen (design spec §8.5, spec §23.8): Gmail, Google Drive, Notion and GitHub. Loaded after
// app.js and uses its helpers (api, $, h, fill, guard, toast, ask, screen). Everything it shows comes from the main
// process (app/connectors); a token or secret typed here goes straight to it and the box is cleared.
// What it can't do: show changes from before an account was connected, or anything while its Worker isn't set up;
// the card then says exactly what to deploy.

const cxOpen = new Set(); // cards whose "What it can't do" is open, kept across redraws
let cxView = null;

const CX_SURE = { exact: '', likely: ' (likely)', unknown: '' };
function cxWho(c) {
  if (c.confidence === 'unknown') return h('span', { class: 'cx-who unknown', title: c.why }, '?');
  return h('span', { class: `cx-who ${c.confidence}`, title: `${c.agent}${CX_SURE[c.confidence]} · ${c.why}` }, `${c.agent}${CX_SURE[c.confidence]}`);
}
const cxAgo = (m) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`);

async function cxUndo(card, keys) {
  const r = await api.connectionsUndo(card.id, keys);
  toast(r.message, { cat: 'reach' });
}

function cxChange(card, c) {
  const busy = !!card.busy;
  return h('li', { class: 'cx-change' },
    h('div', { class: 'cx-what' },
      c.title ? h('strong', {}, c.title) : null,
      h('span', {}, c.what),
      h('span', { class: 'muted' }, cxAgo(c.ago)),
      cxWho(c),
      c.note ? h('span', { class: 'muted cx-note' }, c.note) : null),
    c.undo.can
      ? h('button', { disabled: busy, onclick: guard(() => cxUndo(card, [c.key])) }, 'Undo')
      : h('span', { class: 'muted cx-cant', title: c.undo.why }, c.undo.why));
}

function cxGroups(card) {
  if (!card.groups.length) return h('p', { class: 'muted' }, card.id === 'github' && !card.repos?.length ? '' : 'No changes since Mewndo started journaling.');
  return h('div', { class: 'cx-changes' }, ...card.groups.map((g) => h('section', { class: 'cx-burst' },
    g.label ? h('div', { class: 'cx-burst-head' },
      h('span', {}, `${g.label} · ${g.who}`),
      g.undoKeys.length ? h('button', { class: 'primary', disabled: !!card.busy, onclick: guard(() => cxUndo(card, g.undoKeys)) }, `Undo all ${g.undoKeys.length}`) : null) : null,
    h('ul', { class: 'plain' }, ...g.changes.map((c) => cxChange(card, c))))));
}

function cxButtons(card) {
  const b = [];
  if (card.state === 'signing-in') {
    b.push(h('button', { onclick: guard(() => api.connectionsCancel(card.id)) }, 'Cancel'));
  } else if (card.state === 'not-connected' || card.state === 'signed-out') {
    const label = card.state === 'signed-out' ? 'Connect again' : card.id === 'github' ? 'Add token…' : 'Connect';
    b.push(h('button', { class: 'primary', onclick: guard(() => cxConnect(card)) }, label));
  }
  if (card.state === 'connected' || card.state === 'signed-out') {
    if (card.id === 'github') b.push(h('button', { onclick: guard(() => cxRepos()) }, 'Choose repos…'));
    b.push(h('button', { disabled: !!card.busy, onclick: guard(async () => { await api.connectionsCheck(card.id); }) }, 'Check now'));
    b.push(h('button', { onclick: guard(() => cxDisconnect(card)) }, 'Disconnect'));
  }
  if (card.state === 'not-configured') b.push(h('button', { onclick: guard(() => api.openSettings()) }, 'Settings…'));
  return b.length ? h('div', { class: 'row cx-buttons' }, ...b) : null;
}

function cxCard(card) {
  const limits = h('details', { class: 'cx-limits', open: cxOpen.has(card.id) },
    h('summary', {}, 'What it can’t do'), h('ul', {}, ...card.limits.map((l) => h('li', {}, l))));
  limits.addEventListener('toggle', () => { if (limits.open) cxOpen.add(card.id); else cxOpen.delete(card.id); });
  return h('div', { class: 'cx-card', 'data-id': card.id },
    h('div', { class: 'cx-head' }, MewLogos.img(card.name, 32),
      h('span', { class: 'cx-name' }, card.name, card.account ? h('span', { class: 'muted cx-account' }, card.account) : null),
      h('span', { class: `chip${card.protection === 'protected' ? ' on' : ''}` }, card.stateLabel)),
    h('p', {}, card.what),
    card.setup ? h('p', { class: 'cx-setup' }, card.setup) : null,
    card.busy ? h('p', { class: 'cx-busy', role: 'status' }, card.busy.text) : null,
    card.error ? h('p', { class: 'error' }, card.error) : null,
    ...card.notices.map((n) => h('p', { class: 'muted cx-notice' }, n)),
    card.repos?.length ? h('p', { class: 'muted' }, `Journaling ${card.repos.map((r) => r.name).join(', ')}`) : null,
    ...(card.repos ?? []).filter((r) => r.error).map((r) => h('p', { class: 'error' }, `${r.name}: ${r.error}`)),
    cxButtons(card),
    card.state === 'connected' ? cxGroups(card) : null,
    card.lastChecked ? h('p', { class: 'muted cx-checked' }, `Checked ${new Date(card.lastChecked).toLocaleTimeString()}`) : null,
    limits);
}

function cxDraw() {
  if (!cxView) return;
  fill($('cx-grid'), ...cxView.cards.map(cxCard));
}

const renderConnections = guard(async () => {
  cxView = await api.connectionsView();
  cxDraw();
});
api.on('connections-changed', () => { if (screen === 'connections') renderConnections(); });

// The secret box: the GitHub token or the Notion integration secret. Cleared as soon as it has been handed over.
async function cxSecret({ title, text, placeholder }) {
  $('cx-secret-title').textContent = title;
  $('cx-secret-text').textContent = text;
  $('cx-secret').value = '';
  $('cx-secret').placeholder = placeholder;
  const answer = await ask($('cx-secret-dialog'));
  const value = $('cx-secret').value.trim();
  $('cx-secret').value = '';
  return answer === 'ok' && value ? value : null;
}

async function cxConnect(card) {
  if (card.id === 'gmail' || card.id === 'drive') {
    await api.connectionsConnect(card.id);
    toast('Your browser opened Google’s sign-in. Mewndo waits for you to finish there.');
    return;
  }
  if (card.id === 'notion') {
    const secret = await cxSecret({
      title: 'Connect Notion',
      text: 'In Notion: notion.so/profile/integrations → New integration (Internal) → copy its secret. Then, on each page Mewndo should protect: ••• → Connections → add the integration. Paste the secret here: Mewndo hands it to your Notion Worker once and doesn’t keep it.',
      placeholder: 'ntn_…',
    });
    if (!secret) return;
    await api.connectionsNotionSecret(secret);
    toast('Notion is connected. Changes show up here about a minute after they happen.');
    return;
  }
  const token = await cxSecret({
    title: 'Connect GitHub',
    text: 'On github.com: Settings → Developer settings → Fine-grained tokens → Generate. Repository access: the repos to protect. Permissions: Contents read and write, Issues read and write, Pull requests read and write (Metadata read is added for you). Paste it here: it goes to Windows Credential Manager, never to a file.',
    placeholder: 'github_pat_…',
  });
  if (!token) return;
  await api.connectionsGithubToken(token);
  await cxRepos();
}

async function cxRepos() {
  const repos = await api.connectionsGithubRepos();
  fill($('cx-repos'), ...(repos.length ? repos.map((r) => h('label', {},
    h('input', { type: 'checkbox', value: r.name, checked: r.chosen }), ` ${r.name}${r.private ? ' (private)' : ''}${r.push ? '' : ' — read only: Mewndo can’t undo here'}`))
    : [h('p', { class: 'muted' }, 'This token can’t see any repositories. Give it access to some on github.com.')]));
  if ((await ask($('cx-repos-dialog'))) !== 'ok') return;
  const chosen = [...$('cx-repos').querySelectorAll('input:checked')].map((i) => i.value);
  await api.connectionsGithubSetRepos(chosen);
  toast(chosen.length ? `Journaling ${chosen.length} repo${chosen.length === 1 ? '' : 's'}. Changes from now on can be undone.` : 'No repos are journaled.');
}

async function cxDisconnect(card) {
  $('confirm-title').textContent = `Disconnect ${card.name}?`;
  $('confirm-text').textContent = card.id === 'github'
    ? 'Mewndo removes the token from Credential Manager and forgets its GitHub journal. Nothing on GitHub changes.'
    : `Mewndo removes its sign-in from Credential Manager and asks your ${card.name} Worker to forget this account and its journal. Nothing in ${card.name} changes.`;
  fill($('confirm-list'));
  $('confirm-ok').textContent = 'Disconnect';
  if ((await ask($('confirm'))) !== 'ok') return;
  const r = await api.connectionsDisconnect(card.id);
  toast(r.message);
}
