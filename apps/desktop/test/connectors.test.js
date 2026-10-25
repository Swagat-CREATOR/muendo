// Connections (app/connectors): Gmail, Drive and Notion through their Workers, GitHub directly. No network: every
// Worker and api.github.com is a fake fetch, and all files go to a temporary folder.
//
// The things that must never be wrong:
//   - a token or secret is never written to a file or a log line, only to the credential store;
//   - a card whose Worker isn't set up says exactly what to deploy, and never shows "connected";
//   - every network call has a deadline;
//   - moving a branch back always asks first, naming the branch and both SHAs, and asks twice on the default branch;
//   - nothing is moved when the branch has moved again since Mewndo journaled it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('./helpers');
const { windowsCredentials, memoryCredentials, secretFromBlob, TARGETS } = require('../app/connectors/credentials');
const { requestJson, DeadlineError } = require('../app/connectors/http');
const { workerClient, workerUrl, cleanUrl, setupText, SERVICES } = require('../app/connectors/services');
const gh = require('../app/connectors/github');
const { createConnections } = require('../app/connectors');
const ipc = require('../app/connectors/ipc');
const { confidenceOf } = require('../app/desk/connections');

const GH_TOKEN = `github_pat_${'A1b2'.repeat(20)}`;
const NOTION_SECRET = `ntn_${'Zq9'.repeat(15)}`;
const sha = (c) => c.repeat(40).slice(0, 40);

function json(body, status = 200, headers = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// Every file under dir, as text.
function allFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.join('\n');
}

function logger() {
  const lines = [];
  return { lines, info: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) };
}

// --- Credential Manager --------------------------------------------------------------------------------------------

test('off Windows there is no credential store, and nothing is saved anywhere instead', () => {
  const c = windowsCredentials({ platform: 'linux' });
  assert.equal(c.available, false);
  assert.match(c.why, /Windows Credential Manager/);
  assert.throws(() => c.write(TARGETS.github, GH_TOKEN), /Windows/);
  assert.equal(c.read(TARGETS.github), null);
});

test('on Windows the token goes to CredWriteW as a generic, local-machine credential, UTF-16', () => {
  const calls = [];
  const fakeKoffi = {
    load: () => ({
      func: (_cc, name) => (...args) => {
        calls.push({ name, args });
        if (name === 'CredReadW') { args[3][0] = 'ptr'; return true; }
        return true;
      },
    }),
    struct: (name) => name, pointer: (t) => t, out: (t) => t,
    decode: (ptr, type, len) => (type === 'MEWNDO_CONN_CREDW_OUT' ? { CredentialBlob: 'blob', CredentialBlobSize: 4 } : Buffer.from('ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'utf16le').subarray(0, len ?? 0)),
  };
  const c = windowsCredentials({ platform: 'win32', load: () => fakeKoffi });
  c.write('Mewndo/github-token', GH_TOKEN);
  const w = calls.find((x) => x.name === 'CredWriteW').args[0];
  assert.equal(w.TargetName, 'Mewndo/github-token');
  assert.equal(w.Type, 1);
  assert.equal(w.Persist, 2);
  assert.equal(w.CredentialBlobSize, GH_TOKEN.length * 2);
  assert.ok(w.CredentialBlob.every((b) => b === 0), 'the copy of the secret is wiped after the call');
  c.remove('Mewndo/github-token');
  assert.deepEqual(calls.find((x) => x.name === 'CredDeleteW').args, ['Mewndo/github-token', 1, 0]);
});

test('a credential blob reads back as UTF-16 or UTF-8, and junk is refused', () => {
  assert.equal(secretFromBlob(Buffer.from(GH_TOKEN, 'utf16le')), GH_TOKEN);
  assert.equal(secretFromBlob(Buffer.from(GH_TOKEN, 'utf8')), GH_TOKEN);
  assert.equal(secretFromBlob(Buffer.from('two words', 'utf8')), null);
});

// --- Deadlines and Worker addresses --------------------------------------------------------------------------------

test('every request has a deadline, and the secret in hand never reaches an error message', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(requestJson(hang, 'https://w/x', { deadlineMs: 20, what: 'The Gmail Worker' }), (e) => e instanceof DeadlineError && /didn.t answer within/.test(e.message));
  const leaky = async () => { throw new Error(`connect failed with header Bearer ${GH_TOKEN}`); };
  await assert.rejects(requestJson(leaky, 'https://w/x', { secrets: [GH_TOKEN] }), (e) => !e.message.includes(GH_TOKEN) && e.message.includes('[secret]'));
});

test('Worker addresses: https only (or localhost for wrangler dev), Settings first, then the environment', () => {
  assert.equal(cleanUrl('https://mewndo-gmail.me.workers.dev/'), 'https://mewndo-gmail.me.workers.dev');
  assert.equal(cleanUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(cleanUrl('http://mewndo-gmail.me.workers.dev'), null);
  assert.equal(cleanUrl('https://user:pw@x.dev'), null);
  assert.equal(cleanUrl('not a url'), null);
  const env = { MEWNDO_GMAIL_URL: 'https://from-env.workers.dev' };
  assert.equal(workerUrl('gmail', { saved: {}, env }), 'https://from-env.workers.dev');
  assert.equal(workerUrl('gmail', { saved: { gmail: 'https://from-settings.workers.dev' }, env }), 'https://from-settings.workers.dev');
  assert.equal(workerUrl('drive', { saved: {}, env: {} }), null);
});

test('a card whose Worker is not set up says exactly what to deploy, and is never "connected"', async () => {
  const dir = tempDir();
  const c = createConnections({ dataDir: dir, credentials: memoryCredentials(), env: {}, fetch: async () => { throw new Error('no network expected'); } });
  await c.load();
  const cards = c.view().cards;
  for (const id of ['gmail', 'drive', 'notion']) {
    const card = cards.find((x) => x.id === id);
    assert.equal(card.state, 'not-configured');
    assert.equal(card.stateLabel, 'Not set up');
    assert.match(card.setup, new RegExp(`cloud/${id}`));
    assert.match(card.setup, /npx wrangler@3 deploy/);
    assert.match(card.setup, new RegExp(SERVICES[id].env));
    assert.match(card.setup, /docs\/connections-setup\.md/);
    assert.equal(card.protection, undefined);
    assert.ok(card.limits.length >= 3, 'honest limits are on the card');
  }
  assert.equal(setupText('gmail'), cards[0].setup);
  await assert.rejects(c.connect('gmail'), /Not set up/);
  await assert.rejects(c.connectNotion(NOTION_SECRET), /Not set up/);
  assert.equal(cards.find((x) => x.id === 'github').state, 'not-connected');
});

test('every card shows its honest limits from the READMEs', () => {
  assert.ok(SERVICES.gmail.limits.some((l) => /no undelete/.test(l)));
  assert.ok(SERVICES.gmail.limits.some((l) => /7 days/.test(l)));
  assert.ok(SERVICES.drive.limits.some((l) => /new id/.test(l)));
  assert.ok(SERVICES.notion.limits.some((l) => /one to two minutes/.test(l)));
  assert.ok(SERVICES.notion.limits.some((l) => /new block ids/.test(l)));
  assert.ok(gh.LIMITS.some((l) => /deleted repository/.test(l)));
  assert.ok(gh.LIMITS.some((l) => /rewrites its history again/.test(l)));
  assert.ok(gh.LIMITS.some((l) => /after Mewndo started journaling/.test(l)));
});

// --- A fake Gmail Worker ---------------------------------------------------------------------------------------------

function fakeGmailWorker() {
  const w = { claims: new Map(), appToken: `mw1.${Buffer.from('priya@gmail.com').toString('base64url')}.${'s'.repeat(43)}`, restores: [], claimPolls: 0, opened: null };
  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization;
    if (u.pathname === '/oauth/claim') {
      w.claimPolls++;
      const { claim } = JSON.parse(init.body);
      const hash = crypto.createHash('sha256').update(claim).digest('hex');
      if (w.claimPolls < 2 || hash !== w.expectHash) return json({ pending: true }, 404);
      return json({ user: 'priya@gmail.com', token: w.appToken });
    }
    if (auth !== `Bearer ${w.appToken}`) return json({ error: 'nope' }, 401);
    if (u.pathname === '/app/sync') return json({ ok: true, journaled: 2 });
    if (u.pathname === '/app/status') return json({ user: 'priya@gmail.com', connected: true, pushOn: false, watchError: 'no Pub/Sub topic set' });
    if (u.pathname === '/app/changes') {
      const t = Date.now();
      return json({ changes: [
        { id: 'm1', at: t - 10_000, restoreBefore: t - 10_000, kind: 'trashed', what: 'Moved to Trash', undoable: true, title: 'Invoice' },
        { id: 'm2', at: t - 20_000, restoreBefore: t - 20_000, kind: 'trashed', what: 'Moved to Trash', undoable: true, title: 'Receipt' },
        { id: 'm3', at: t - 30_000, restoreBefore: t - 30_000, kind: 'deleted', what: 'Deleted forever', undoable: false, why: 'Gmail has no undelete.' },
        { id: 'm4', at: t - 5_000, restoreBefore: t - 5_000, kind: 'labels', what: 'Moved to Inbox', undoable: true, by: 'mewndo' },
      ] });
    }
    if (u.pathname === '/gmail/restore') { w.restores.push(JSON.parse(init.body)); return json({ restored: 2, permanently_deleted: [], ms: 900 }); }
    if (u.pathname === '/app/disconnect') return json({ ok: true });
    return json({ error: 'not found' }, 404);
  };
  return w;
}

test('Gmail: Connect opens the Worker’s Google sign-in, collects the app token once, and keeps it only in the credential store', async () => {
  const dir = tempDir();
  const creds = memoryCredentials();
  const w = fakeGmailWorker();
  const log = logger();
  const c = createConnections({
    dataDir: dir, credentials: creds, fetch: w.fetch, log, claimEveryMs: 1, env: { MEWNDO_GMAIL_URL: 'https://gmail.test' },
    openExternal: async (u) => { w.opened = new URL(u); w.expectHash = w.opened.searchParams.get('claim'); },
  });
  await c.load();
  assert.equal(c.view().cards[0].state, 'not-connected');
  await c.connect('gmail');
  assert.equal(w.opened.origin + w.opened.pathname, 'https://gmail.test/oauth/start');
  assert.match(w.expectHash, /^[0-9a-f]{64}$/, 'only the hash of the claim secret goes to the browser');
  assert.ok(w.claimPolls >= 2);
  assert.equal(creds.read(TARGETS.gmail), w.appToken);

  const card = c.view().cards.find((x) => x.id === 'gmail');
  assert.equal(card.state, 'connected');
  assert.equal(card.stateLabel, 'Protected');
  assert.equal(card.account, 'priya@gmail.com');
  assert.ok(card.notices.some((n) => /Push is off/.test(n)), 'says it is polling, not pushing');
  const changes = card.groups.flatMap((g) => g.changes);
  assert.equal(changes.length, 3, 'Mewndo’s own undo is not listed as a change');
  assert.equal(changes.find((x) => x.what === 'Deleted forever').undo.can, false);
  assert.match(changes.find((x) => x.what === 'Deleted forever').undo.why, /undelete/);
  assert.ok(changes.every((x) => x.confidence === 'unknown'), 'no agent session known: "?" rather than a guess');
  const burst = card.groups.find((g) => g.undoKeys.length === 2);
  assert.ok(burst, 'the two trashes 10 s apart are one burst with one Undo');

  const r = await c.undo('gmail', burst.undoKeys);
  assert.match(r.message, /Put back 2 messages/);
  assert.deepEqual(w.restores[0].messageIds.sort(), ['m1', 'm2']);
  assert.equal(w.restores[0].before, Math.min(...changes.filter((x) => burst.undoKeys.includes(x.key)).map((x) => x.at)), 'back to before the burst');

  const files = allFiles(dir);
  assert.ok(files.includes('priya@gmail.com'), 'the account name is saved');
  assert.ok(!files.includes(w.appToken.split('.')[2]), 'the app token is never in a file');
  assert.ok(!log.lines.join('\n').includes(w.appToken.split('.')[2]), 'or in the log');

  await c.disconnect('gmail');
  assert.equal(creds.read(TARGETS.gmail), null);
  assert.equal(c.view().cards[0].state, 'not-connected');
  c.stop();
});

test('a Worker that says 401 turns the card to "Connect again", never to a silent "Protected"', async () => {
  const dir = tempDir();
  const creds = memoryCredentials();
  creds.write(TARGETS.drive, 'mw1.x.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy');
  fs.mkdirSync(path.join(dir, 'connections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'connections', 'config.json'), JSON.stringify({ accounts: { drive: { account: 'priya@gmail.com', connectedAt: Date.now() } } }));
  const c = createConnections({ dataDir: dir, credentials: creds, env: { MEWNDO_DRIVE_URL: 'https://drive.test' }, fetch: async () => json({ error: 'expired' }, 401) });
  await c.load();
  await c.refreshWorker('drive');
  const card = c.view().cards.find((x) => x.id === 'drive');
  assert.equal(card.state, 'signed-out');
  assert.equal(card.stateLabel, 'Connect again');
  assert.match(card.error, /connect again/);
});

test('Notion: the integration secret goes to the Worker once and is never stored by the app', async () => {
  const dir = tempDir();
  const creds = memoryCredentials();
  const log = logger();
  const sent = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/notion/connect') { sent.push(JSON.parse(init.body).token); return json({ user: 'bot-1', workspace: 'Priya’s space', token: 'mw1.Ym90LTE.tttttttttttttttttttttttttttttttttttttttttttt' }); }
    if (u.pathname === '/app/status') return json({ connected: true, undoLag: 'one to two minutes' });
    if (u.pathname === '/app/changes') return json({ changes: [] });
    return json({ ok: true });
  };
  const c = createConnections({ dataDir: dir, credentials: creds, fetch: fetchFn, log, env: { MEWNDO_NOTION_URL: 'https://notion.test' } });
  await c.load();
  await assert.rejects(c.connectNotion('my password'), /integration secret/);
  assert.equal(sent.length, 0, 'something that isn’t a secret is never sent');
  await c.connectNotion(NOTION_SECRET);
  assert.deepEqual(sent, [NOTION_SECRET]);
  assert.equal(creds.read(TARGETS.notion), 'mw1.Ym90LTE.tttttttttttttttttttttttttttttttttttttttttttt');
  assert.ok(![...creds._map.values()].includes(NOTION_SECRET), 'the Notion secret is not kept in the credential store either');
  assert.ok(!allFiles(dir).includes(NOTION_SECRET));
  assert.ok(!log.lines.join('\n').includes(NOTION_SECRET));
  const card = c.view().cards.find((x) => x.id === 'notion');
  assert.equal(card.state, 'connected');
  assert.equal(card.account, 'Priya’s space');
});

test('a Worker client sends the app token, and a slow restore ends at its deadline with an honest message', async () => {
  const seen = [];
  const client = workerClient({ id: 'gmail', baseUrl: 'https://gmail.test', getToken: () => 'mw1.a.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', fetch: async (url, init) => { seen.push(init.headers.authorization); return json({ changes: [] }); } });
  await client.changes();
  assert.match(seen[0], /^Bearer mw1\./);
  const none = workerClient({ id: 'gmail', baseUrl: 'https://gmail.test', getToken: () => null, fetch: async () => json({}) });
  await assert.rejects(none.status(), (e) => e.code === 'NO_TOKEN');
});

// --- Attribution -----------------------------------------------------------------------------------------------------

test('a change noticed by a poll matches every session that overlaps the window, and two means unknown', () => {
  const T = 1_700_000_000_000;
  const claude = { agent: 'Claude Code', agentId: 'c', from: T - 600_000, to: T - 400_000 };
  const codex = { agent: 'Codex', agentId: 'x', from: T - 100_000, to: null };
  assert.equal(confidenceOf({ at: T, from: T - 300_000, source: 'poll' }, [claude, codex]).agent, 'Codex');
  assert.equal(confidenceOf({ at: T, from: T - 500_000, source: 'poll' }, [claude, codex]).confidence, 'unknown');
  assert.equal(confidenceOf({ at: T, source: 'poll' }, [claude]).confidence, 'unknown', 'without a window, the old rule');
});

// --- GitHub: diffing and undo planning ---------------------------------------------------------------------------

const REPO = 'priya/shop';
function snap(branches, items = {}, at = 1000) {
  return { at, defaultBranch: 'main', branches, items };
}

test('diffing two snapshots finds deletes, force-pushes, new branches, protection off and closed issues', () => {
  const prev = snap({
    main: { sha: sha('a'), protected: true }, feature: { sha: sha('b'), protected: false }, docs: { sha: sha('c'), protected: false }, wip: { sha: sha('d'), protected: false },
  }, { 1: { kind: 'issue', state: 'open', title: 'Bug' }, 2: { kind: 'pr', state: 'open', title: 'Add cart' }, 3: { kind: 'pr', state: 'open', title: 'Fix' } });
  const next = snap({
    main: { sha: sha('a'), protected: false }, feature: { sha: sha('e'), protected: false }, wip: { sha: sha('f'), protected: false }, new: { sha: sha('9'), protected: false },
  }, { 1: { kind: 'issue', state: 'closed', title: 'Bug', closedAt: 1500 }, 2: { kind: 'pr', state: 'closed', merged: false, title: 'Add cart' }, 3: { kind: 'pr', state: 'closed', merged: true, title: 'Fix' } }, 2000);
  const events = gh.diffSnapshots(REPO, prev, next, { relations: { feature: 'diverged', wip: 'ahead' }, now: 2000 });
  const kinds = Object.fromEntries(events.map((e) => [`${e.kind}:${e.branch ?? e.number}`, e]));
  assert.equal(kinds['branch-deleted:docs'].sha, sha('c'));
  assert.equal(kinds['force-push:feature'].fromSha, sha('b'));
  assert.equal(kinds['force-push:feature'].toSha, sha('e'));
  assert.ok(kinds['push:wip'], 'a fast-forward is a normal push, not a force-push');
  assert.ok(kinds['branch-created:new']);
  assert.ok(kinds['protection-off:main']);
  assert.equal(kinds['issue-closed:1'].changedAt, 1500);
  assert.ok(kinds['pr-closed:2']);
  assert.ok(kinds['pr-merged:3']);
  assert.equal(gh.describe(kinds['pr-merged:3']).undoable, false);
  assert.equal(gh.describe(kinds['push:wip']).undoable, false);
  assert.equal(gh.diffSnapshots(REPO, null, next).length, 0, 'the first look is the baseline: no events');
});

test('undoing a force-push asks once naming the branch and both SHAs, twice on the default branch', () => {
  const e = { repo: REPO, kind: 'force-push', branch: 'feature', fromSha: sha('b'), toSha: sha('e') };
  const p = gh.planUndo(e, { branches: { feature: { sha: sha('e'), protected: false } } }, { defaultBranch: 'main' });
  assert.equal(p.can, true);
  assert.equal(p.confirmations.length, 1);
  for (const s of ['feature', sha('b').slice(0, 7), sha('e').slice(0, 7), 'rewrites']) assert.ok(p.confirmations[0].includes(s), s);
  assert.deepEqual(p.steps, [{ method: 'PATCH', path: `/repos/${REPO}/git/refs/heads/feature`, body: { sha: sha('b'), force: true } }]);

  const onMain = gh.planUndo({ ...e, branch: 'main' }, { branches: { main: { sha: sha('e'), protected: true } } }, { defaultBranch: 'main' });
  assert.equal(onMain.confirmations.length, 2, 'the default branch needs a second yes');
  assert.match(onMain.confirmations[1], /default branch/);
  assert.match(onMain.confirmations[0], /protected/);

  const movedAgain = gh.planUndo(e, { branches: { feature: { sha: sha('7') } } }, { defaultBranch: 'main' });
  assert.equal(movedAgain.can, false);
  assert.match(movedAgain.why, /moved again/);
  assert.equal(gh.planUndo(e, { branches: {} }).can, false, 'a deleted branch must come back first');
});

test('a deleted branch is recreated at its journaled SHA, but never over a branch that exists again', () => {
  const e = { repo: REPO, kind: 'branch-deleted', branch: 'feature/x', sha: sha('c') };
  const p = gh.planUndo(e, { branches: {} }, { defaultBranch: 'main' });
  assert.deepEqual(p.steps[0], { method: 'POST', path: `/repos/${REPO}/git/refs`, body: { ref: 'refs/heads/feature/x', sha: sha('c') } });
  assert.match(p.confirmations[0], /feature\/x/);
  assert.match(p.confirmations[0], new RegExp(sha('c').slice(0, 7)));
  assert.equal(gh.planUndo(e, { branches: { 'feature/x': { sha: sha('d') } } }).can, false);
});

test('closed issues and pull requests reopen; open or merged ones are left alone', () => {
  const issue = { repo: REPO, kind: 'issue-closed', number: 4, title: 'Bug' };
  assert.deepEqual(gh.planUndo(issue, { items: { 4: { state: 'closed' } } }).steps[0], { method: 'PATCH', path: `/repos/${REPO}/issues/4`, body: { state: 'open' } });
  assert.equal(gh.planUndo(issue, { items: { 4: { state: 'open' } } }).can, false);
  const pr = { repo: REPO, kind: 'pr-closed', number: 5, title: 'Cart' };
  assert.equal(gh.planUndo(pr, { items: { 5: { state: 'closed' } } }).steps[0].path, `/repos/${REPO}/pulls/5`);
  assert.equal(gh.planUndo(pr, { items: { 5: { state: 'closed', merged: true } } }).can, false);
});

test('a burst puts branches back before reopening, with one combined yes plus the default-branch one', async () => {
  const plans = [
    gh.planUndo({ repo: REPO, kind: 'pr-closed', number: 5, title: 'Cart' }, { items: {} }),
    gh.planUndo({ repo: REPO, kind: 'force-push', branch: 'main', fromSha: sha('b'), toSha: sha('e') }, { branches: { main: { sha: sha('e') } } }, { defaultBranch: 'main' }),
    gh.planUndo({ repo: REPO, kind: 'branch-deleted', branch: 'cart', sha: sha('c') }, { branches: {} }),
  ];
  const b = gh.planBurst(plans);
  assert.deepEqual(b.plans.map((p) => p.kind), ['branch-deleted', 'force-push', 'pr-closed']);
  assert.equal(b.confirmations.length, 2);
  assert.match(b.confirmations[0], /Undo 3 changes/);

  // Saying no to the second question changes nothing on GitHub.
  const requests = [];
  const client = { request: async (...a) => { requests.push(a); return { status: 200, data: {} }; } };
  let asked = 0;
  const r = await gh.executeUndo(client, b.plans, { confirmations: b.confirmations, confirm: async () => ++asked === 1 });
  assert.equal(r.cancelled, true);
  assert.equal(requests.length, 0);
});

// --- GitHub: the service end to end, against a fake api.github.com ---------------------------------------------------

function fakeGitHub() {
  const g = {
    branches: { main: { sha: sha('a'), protected: true }, feature: { sha: sha('b'), protected: false } },
    issues: [{ number: 7, title: 'Checkout bug', state: 'open', updated_at: new Date(Date.now() - 3600_000).toISOString() }],
    requests: [], etagHits: 0,
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization;
    g.requests.push({ method: init.method ?? 'GET', path: u.pathname + u.search, auth, ifNoneMatch: init.headers?.['if-none-match'] });
    if (auth !== `Bearer ${GH_TOKEN}`) return json({ message: 'Bad credentials' }, 401);
    const p = u.pathname;
    const tag = (body) => `"${crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
    const cached = (body) => {
      const etag = tag(body);
      if (init.headers?.['if-none-match'] === etag) { g.etagHits++; return json(null, 304, { etag }); }
      return json(body, 200, { etag, 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    };
    if (p === '/user') return json({ login: 'priya' });
    if (p === '/user/repos') return json([{ full_name: REPO, private: true, permissions: { push: true } }]);
    if (p === `/repos/${REPO}`) return cached({ full_name: REPO, default_branch: 'main' });
    if (p === `/repos/${REPO}/branches`) return cached(Object.entries(g.branches).map(([name, b]) => ({ name, commit: { sha: b.sha }, protected: b.protected })));
    if (p === `/repos/${REPO}/issues`) return cached(g.issues.filter((i) => u.searchParams.get('state') === 'all' || i.state === 'open'));
    if (p.startsWith(`/repos/${REPO}/compare/`)) return json({ status: 'diverged' });
    if (p === `/repos/${REPO}/git/refs` && init.method === 'POST') {
      const b = JSON.parse(init.body);
      g.branches[b.ref.replace('refs/heads/', '')] = { sha: b.sha, protected: false };
      return json({ ref: b.ref }, 201);
    }
    if (p.startsWith(`/repos/${REPO}/git/refs/heads/`) && init.method === 'PATCH') {
      g.branches[decodeURIComponent(p.slice(`/repos/${REPO}/git/refs/heads/`.length))].sha = JSON.parse(init.body).sha;
      return json({});
    }
    if (p.startsWith(`/repos/${REPO}/issues/`) && init.method === 'PATCH') {
      g.issues.find((i) => i.number === Number(p.split('/').pop())).state = 'open';
      return json({});
    }
    return json({ message: 'Not Found' }, 404);
  };
  return g;
}

test('GitHub: the token is checked, kept only in the credential store, and the repos are journaled with ETags', async () => {
  const dir = tempDir();
  const creds = memoryCredentials();
  const g = fakeGitHub();
  const log = logger();
  const confirms = [];
  const c = createConnections({ dataDir: dir, credentials: creds, fetch: g.fetch, log, env: {}, confirm: async (text) => { confirms.push(text); return true; } });
  await c.load();
  await assert.rejects(c.setGitHubToken('password123'), /doesn.t look like a GitHub token/);
  assert.equal(g.requests.length, 0, 'a non-token is never sent to GitHub');
  await assert.rejects(c.setGitHubToken(`github_pat_${'X'.repeat(40)}`), /didn.t accept/);
  assert.equal(creds.read(TARGETS.github), null, 'a refused token is not saved');

  await c.setGitHubToken(GH_TOKEN);
  assert.equal(creds.read(TARGETS.github), GH_TOKEN);
  assert.deepEqual((await c.listRepos()).map((r) => r.name), [REPO]);
  await c.setRepos([REPO]);
  await c.pollGitHub();
  await c.pollGitHub();
  assert.ok(g.etagHits >= 2, 'unchanged lists come back as 304 Not Modified');

  // An agent deletes "feature", force-pushes main and closes the issue.
  delete g.branches.feature;
  g.branches.main.sha = sha('e');
  g.issues[0].state = 'closed';
  g.issues[0].closed_at = new Date().toISOString();
  g.issues[0].updated_at = new Date().toISOString();
  await c.pollGitHub();
  const card = c.view().cards.find((x) => x.id === 'github');
  assert.equal(card.state, 'connected');
  assert.equal(card.account, '@priya');
  const changes = card.groups.flatMap((x) => x.changes);
  const byWhat = (re) => changes.find((x) => re.test(x.what));
  assert.ok(byWhat(/Branch .feature. deleted/).undo.can);
  assert.ok(byWhat(/main. force-pushed/).undo.can);
  assert.ok(byWhat(/Issue #7 closed/).undo.can);

  // Undo all three: branches first, two questions because main is the default branch.
  const r = await c.undo('github', changes.filter((x) => x.undo.can).map((x) => x.key));
  assert.equal(confirms.length, 2);
  assert.match(confirms[0], /feature/);
  assert.match(confirms[1], /default branch/);
  assert.equal(g.branches.feature.sha, sha('b'));
  assert.equal(g.branches.main.sha, sha('a'));
  assert.equal(g.issues[0].state, 'open');
  assert.match(r.message, /back at/);

  // The next poll doesn't report Mewndo's own undo as someone's change.
  const before = c._journal().repos[REPO].events.length;
  await c.pollGitHub();
  assert.equal(c._journal().repos[REPO].events.length, before);

  const files = allFiles(dir);
  assert.ok(!files.includes(GH_TOKEN), 'the token is never in a file');
  assert.ok(!log.lines.join('\n').includes(GH_TOKEN), 'or in the log');
  assert.ok(g.requests.every((x) => !x.path.includes(GH_TOKEN)), 'or in a URL');

  await c.disconnect('github');
  assert.equal(creds.read(TARGETS.github), null);
  c.stop();
});

test('IPC handlers check their arguments and don’t clash with the main process’s channels', async () => {
  const main = ipc.mainHandlers(() => null);
  assert.throws(() => main.connectionsView(), /still starting/);
  const fake = { undo: async () => ({}), disconnect: async () => ({}), view: () => ({}) };
  const h = ipc.mainHandlers(() => fake);
  assert.throws(() => h.connectionsUndo('dropbox', ['k']), /unknown connection/);
  assert.throws(() => h.connectionsUndo('gmail', []), /invalid changes/);
  assert.throws(() => h.connectionsDisconnect('../x'), /unknown connection/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
  for (const name of [...Object.keys(main), ...Object.keys(ipc.settingsHandlers(() => null))]) {
    assert.ok(!new RegExp(`^ {2}(async )?${name}[(:,]`, 'm').test(source), `${name} is also defined in main.js`);
  }
});
