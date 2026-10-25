// Connections (spec §23.8, §25.3, design spec §8.5): Gmail, Google Drive and Notion through their Workers, and
// GitHub directly. Owns what the Connections screen shows, the sign-in flows, polling, and Undo.
// No Electron here: openExternal, confirm, activity, fetch and the credential store are injected, so tests run it
// with plain Node in a temporary folder.
//
// What is stored where (CLAUDE.md rule 4):
//   Credential Manager: the GitHub token, and each Worker's app token (credentials.js).
//   <data>/connections/config.json: Worker addresses, account names, the GitHub login and chosen repos. No secrets.
//   <data>/connections/github.json: the GitHub journal (branch heads, issue states, events). No secrets.
//   The Workers keep the Google refresh tokens and the Notion secret; the app never has them on disk.

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { TARGETS } = require('./credentials');
const { SERVICES, WORKER_IDS, workerClient, workerUrl, cleanUrl, setupText, newClaim, restoreSummary } = require('./services');
const gh = require('./github');
const { confidenceOf, accountRows } = require('../desk/connections');

const BURST_GAP_MS = 2 * 60_000;
const SEVEN_DAYS = 7 * 24 * 3600_000;
const MAX_REPOS = 10;

function createConnections({
  dataDir, credentials, fetch = globalThis.fetch, openExternal = async () => {}, confirm = async () => false,
  activity = async () => ({ agents: [], activeMs: 0 }), log = null, onChange = () => {}, env = process.env,
  now = Date.now, syncEveryMs = 3 * 60_000, githubEveryMs = 5 * 60_000, claimEveryMs = 2000, claimForMs = 5 * 60_000,
  activityEveryMs = 30_000,
} = {}) {
  const dir = path.join(dataDir, 'connections');
  let config = { urls: {}, accounts: {}, github: { login: null, repos: [] } };
  let journal = { repos: {} }; // GitHub: repo -> { startedAt, snapshot, events }
  const live = Object.fromEntries([...WORKER_IDS, 'github'].map((id) => [id, { status: null, changes: [], busy: null, error: null, lastChecked: null }]));
  const running = new Map(); // id -> promise of the refresh in flight
  const signIns = new Map(); // id -> { cancelled }
  const timers = [];
  const sessions = []; // [{ agent, from, to }] from local agent activity, for "likely" attribution
  const openSessions = new Map();
  let ghClient = null;

  const info = (msg) => log?.info?.(msg);
  const changed = () => { try { onChange(); } catch { /* the window may be gone */ } };

  // --- Files (temp file, then rename) ---------------------------------------------------------------------------
  async function readJson(name, fallback) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')); } catch { return fallback; }
  }
  async function writeJson(name, value) {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    const tmp = `${file}.${crypto.randomUUID()}.mewndo-tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value), { flush: true });
    await fsp.rename(tmp, file);
  }
  const saveConfig = () => writeJson('config.json', config);
  const saveJournal = () => writeJson('github.json', journal);

  async function load() {
    const c = await readJson('config.json', {});
    config = { urls: c.urls ?? {}, accounts: c.accounts ?? {}, github: { login: c.github?.login ?? null, repos: (c.github?.repos ?? []).filter((r) => gh.REPO_RE.test(r)) } };
    journal = await readJson('github.json', { repos: {} });
    journal.repos ??= {};
  }

  // --- Workers --------------------------------------------------------------------------------------------------
  const urlOf = (id) => workerUrl(id, { saved: config.urls, env });
  const tokenOf = (id) => credentials.read(TARGETS[id]);
  const client = (id) => workerClient({ id, baseUrl: urlOf(id), getToken: () => tokenOf(id), fetch });
  const isConnected = (id) => !!config.accounts[id] && credentials.available;

  async function refreshWorker(id) {
    if (!urlOf(id) || !isConnected(id)) return;
    if (running.has(id)) return running.get(id);
    const job = (async () => {
      const l = live[id];
      try {
        const c = client(id);
        await c.sync().catch((e) => { if (e.code === 'SIGNED_OUT' || e.code === 'NO_TOKEN') throw e; l.error = e.message; });
        l.status = await c.status();
        l.changes = await c.changes();
        l.error = l.status?.signInError ?? null;
      } catch (e) {
        l.error = e.code === 'SIGNED_OUT' || e.code === 'NO_TOKEN' ? `${SERVICES[id].name} needs you to connect again.` : e.message;
        if (e.code === 'SIGNED_OUT' || e.code === 'NO_TOKEN') l.status = { ...(l.status ?? {}), signInError: l.error };
        info(`Connections: ${SERVICES[id].name} check failed: ${l.error}`);
      } finally {
        l.lastChecked = now();
        running.delete(id);
        changed();
      }
    })();
    running.set(id, job);
    return job;
  }

  // Google: open the Worker's sign-in in the browser, then collect the app token with the claim secret.
  async function connectGoogle(id) {
    const base = urlOf(id);
    if (!base) throw new Error(setupText(id));
    if (!credentials.available) throw new Error(credentials.why);
    if (signIns.has(id)) signIns.get(id).cancelled = true;
    const claim = newClaim();
    const me = { cancelled: false };
    signIns.set(id, me);
    const l = live[id];
    l.busy = { kind: 'signing-in', text: 'Finish signing in with Google in your browser…' };
    l.error = null;
    changed();
    try {
      await openExternal(client(id).startUrl(claim.hash));
      const until = now() + claimForMs;
      while (!me.cancelled && now() < until) {
        const got = await client(id).claim(claim.secret).catch((e) => { l.error = e.message; return null; });
        if (got?.token && got.user) {
          credentials.write(TARGETS[id], got.token);
          config.accounts[id] = { account: String(got.user).slice(0, 200), connectedAt: now() };
          await saveConfig();
          info(`Connections: ${SERVICES[id].name} connected`);
          l.error = null;
          l.busy = null;
          await refreshWorker(id);
          return;
        }
        await new Promise((r) => { timers.push(setTimeout(r, claimEveryMs)); });
      }
      if (!me.cancelled) l.error = 'Sign-in wasn’t finished within 5 minutes. Press Connect to try again.';
    } catch (e) {
      l.error = e.message;
      info(`Connections: ${SERVICES[id].name} sign-in failed: ${e.message}`);
    } finally {
      if (signIns.get(id) === me) signIns.delete(id);
      l.busy = null;
      changed();
    }
  }

  // Notion: the integration secret goes to the Worker once; only the app token it returns is kept.
  async function connectNotion(secret) {
    const base = urlOf('notion');
    if (!base) throw new Error(setupText('notion'));
    if (!credentials.available) throw new Error(credentials.why);
    const s = String(secret ?? '').trim();
    if (!/^(ntn_|secret_)[A-Za-z0-9]{20,200}$/.test(s)) throw new Error('That doesn’t look like a Notion integration secret. It starts with ntn_ (or secret_).');
    const l = live.notion;
    l.busy = { kind: 'signing-in', text: 'Checking the secret with Notion…' };
    changed();
    try {
      const got = await client('notion').connectNotion(s);
      if (!got?.token) throw new Error('The Notion Worker gave no app token.');
      credentials.write(TARGETS.notion, got.token);
      config.accounts.notion = { account: String(got.workspace ?? 'Notion').slice(0, 200), connectedAt: now() };
      await saveConfig();
      info('Connections: Notion connected');
      l.error = null;
    } finally {
      l.busy = null;
      changed();
    }
    await refreshWorker('notion');
  }

  async function disconnectWorker(id) {
    let note = null;
    if (urlOf(id) && tokenOf(id)) {
      await client(id).disconnect().catch((e) => { note = `The Worker couldn’t be told (${e.message}); it forgets the account when you remove it there.`; });
    }
    credentials.remove(TARGETS[id]);
    delete config.accounts[id];
    await saveConfig();
    live[id] = { status: null, changes: [], busy: null, error: null, lastChecked: null };
    info(`Connections: ${SERVICES[id].name} disconnected`);
    changed();
    return { message: [`${SERVICES[id].name} disconnected.`, id === 'notion' ? 'Remove the integration in Notion too (notion.so/profile/integrations).' : '', note].filter(Boolean).join(' ') };
  }

  async function undoWorker(id, keys) {
    const l = live[id];
    const picked = l.changes.filter((c) => keys.includes(keyOf(c)) && c.undoable);
    if (!picked.length) throw new Error('Nothing here can be undone.');
    if (l.busy) throw new Error(`${SERVICES[id].name} is busy; try again in a moment.`);
    const ids = [...new Set(picked.map((c) => c.id))];
    const before = Math.min(...picked.map((c) => c.restoreBefore ?? c.at));
    const noun = SERVICES[id].noun[ids.length === 1 ? 0 : 1];
    l.busy = { kind: 'undoing', text: `Putting back ${ids.length} ${noun}…${id === 'notion' ? ' (about 3 per second)' : ''}`, keys };
    changed();
    try {
      const r = await client(id).restore(ids, before);
      const message = restoreSummary(id, r);
      info(`Connections: ${SERVICES[id].name} undo: ${message}`);
      return { message };
    } catch (e) {
      const message = e.code === 'DEADLINE'
        ? `Mewndo stopped waiting after 2 minutes. The ${SERVICES[id].name} Worker may still be finishing: check again in a minute.`
        : e.message;
      info(`Connections: ${SERVICES[id].name} undo failed: ${message}`);
      throw new Error(message);
    } finally {
      l.busy = null;
      changed();
      refreshWorker(id).catch(() => {});
    }
  }

  // --- GitHub ---------------------------------------------------------------------------------------------------
  const github = () => (ghClient ??= gh.githubClient({ getToken: () => credentials.read(TARGETS.github), fetch }));
  const ghConnected = () => credentials.available && !!config.github.login;

  async function setGitHubToken(token) {
    if (!credentials.available) throw new Error(credentials.why);
    const t = String(token ?? '').trim();
    if (!gh.TOKEN_RE.test(t)) throw new Error('That doesn’t look like a GitHub token. A fine-grained one starts with github_pat_.');
    const probe = gh.githubClient({ getToken: () => t, fetch });
    const me = await probe.request('GET', '/user').catch((e) => { if (e.code === 'SIGNED_OUT') return { status: 401 }; throw e; });
    if (me.status >= 400 || !me.data?.login) throw new Error(me.status === 401 ? 'GitHub didn’t accept this token.' : `GitHub answered ${me.status}.`);
    credentials.write(TARGETS.github, t);
    ghClient = null;
    config.github.login = String(me.data.login).slice(0, 100);
    await saveConfig();
    info('Connections: GitHub token saved to Credential Manager');
    changed();
    return { login: config.github.login };
  }

  async function listRepos() {
    const r = await github().get('/user/repos?per_page=100&sort=pushed');
    return (r.data ?? []).map((x) => ({ name: x.full_name, private: !!x.private, push: x.permissions?.push !== false, chosen: config.github.repos.includes(x.full_name) }));
  }

  async function setRepos(list) {
    if (!Array.isArray(list) || list.length > MAX_REPOS || !list.every((r) => typeof r === 'string' && gh.REPO_RE.test(r))) {
      throw new Error(`Choose up to ${MAX_REPOS} repositories.`);
    }
    config.github.repos = [...new Set(list)];
    for (const repo of Object.keys(journal.repos)) if (!config.github.repos.includes(repo)) delete journal.repos[repo];
    await saveConfig();
    await saveJournal();
    changed();
    pollGitHub().catch(() => {});
  }

  async function pollGitHub() {
    if (!ghConnected() || running.has('github')) return running.get('github');
    const job = (async () => {
      const l = live.github;
      const errors = {};
      try {
        const c = github();
        for (const repo of config.github.repos) {
          const rate = c.rate();
          if (rate.remaining != null && rate.remaining < 100 && rate.reset > now()) {
            l.error = `GitHub’s rate limit is nearly used up; Mewndo waits until ${new Date(rate.reset).toLocaleTimeString()}.`;
            break;
          }
          try {
            const j = journal.repos[repo] ?? { startedAt: now(), snapshot: null, events: [] };
            const next = await gh.snapshotRepo(c, repo, j.snapshot);
            if (next.missing) { errors[repo] = 'Not found: deleted, renamed, or the token lost access. Mewndo can’t bring back a deleted repository.'; continue; }
            const relations = {};
            const moved = Object.entries(j.snapshot?.branches ?? {}).filter(([n, b]) => next.branches[n] && next.branches[n].sha !== b.sha).slice(0, 10);
            for (const [n, b] of moved) relations[n] = await gh.relation(c, repo, b.sha, next.branches[n].sha);
            const events = gh.diffSnapshots(repo, j.snapshot, next, { relations, now: now() });
            j.snapshot = gh.mergeSnapshot(j.snapshot, next);
            j.events = [...events, ...j.events].slice(0, 300);
            journal.repos[repo] = j;
            if (events.length) info(`Connections: GitHub ${repo}: ${events.length} change(s) journaled`);
          } catch (e) {
            if (e.code === 'SIGNED_OUT' || e.code === 'NO_TOKEN') throw e;
            errors[repo] = e.message;
          }
        }
        await saveJournal();
        if (!l.error?.startsWith('GitHub’s rate limit')) l.error = null;
      } catch (e) {
        l.error = e.message;
      } finally {
        l.repoErrors = errors;
        l.lastChecked = now();
        running.delete('github');
        changed();
      }
    })();
    running.set('github', job);
    return job;
  }

  async function undoGitHub(keys) {
    const events = Object.values(journal.repos).flatMap((j) => j.events).filter((e) => keys.includes(e.key));
    if (!events.length) throw new Error('Nothing here can be undone.');
    if (live.github.busy) throw new Error('GitHub is busy; try again in a moment.');
    live.github.busy = { kind: 'undoing', text: 'Checking GitHub before undoing…', keys };
    changed();
    try {
      const c = github();
      const current = {};
      for (const repo of new Set(events.map((e) => e.repo))) {
        // The state right now, not the last poll's: never move a branch that moved again since.
        const snap = await gh.snapshotRepo(c, repo, journal.repos[repo]?.snapshot);
        if (snap.missing) throw new Error(`${repo} can’t be found: Mewndo can’t bring back a deleted repository.`);
        current[repo] = { branches: snap.branches, items: { ...(journal.repos[repo]?.snapshot?.items ?? {}), ...snap.items }, defaultBranch: snap.defaultBranch };
      }
      const plans = events.map((e) => ({ e, plan: gh.planUndo(e, current[e.repo], { defaultBranch: current[e.repo].defaultBranch }) }));
      for (const p of plans) p.plan.event = p.e;
      const burst = plans.length === 1 ? (plans[0].plan.can ? { can: true, plans: [plans[0].plan], confirmations: plans[0].plan.confirmations } : plans[0].plan) : gh.planBurst(plans.map((p) => p.plan));
      if (!burst.can) throw new Error(burst.why);
      live.github.busy = { kind: 'undoing', text: 'Waiting for you to confirm…', keys };
      changed();
      const result = await gh.executeUndo(c, burst.plans, { confirmations: burst.confirmations, confirm });
      if (result.cancelled) return { message: 'Nothing was changed.' };
      // Journal what Mewndo did, so the next poll doesn't report it as someone else's change.
      for (const p of result.done) {
        const e = p.event;
        e.undone = now();
        const snap = journal.repos[e.repo]?.snapshot;
        if (snap && p.expect.branch) snap.branches[p.expect.branch] = { ...(snap.branches[p.expect.branch] ?? { protected: false }), sha: p.expect.sha };
        if (snap && p.expect.number != null && snap.items[p.expect.number]) snap.items[p.expect.number].state = 'open';
      }
      await saveJournal();
      const message = [...result.done.map((p) => p.done), ...result.failed.map((f) => `Couldn’t undo: ${f.why}`),
        burst.skipped ? `${burst.skipped} change(s) skipped (they can’t be undone now).` : ''].filter(Boolean).join(' ');
      info(`Connections: GitHub undo: ${message}`);
      return { message };
    } finally {
      live.github.busy = null;
      changed();
    }
  }

  async function disconnectGitHub() {
    credentials.remove(TARGETS.github);
    ghClient = null;
    config.github = { login: null, repos: [] };
    journal = { repos: {} };
    await saveConfig();
    await saveJournal();
    live.github = { status: null, changes: [], busy: null, error: null, lastChecked: null };
    info('Connections: GitHub token removed from Credential Manager');
    changed();
    return { message: 'GitHub disconnected and its journal removed. Delete the token on github.com too (Settings → Developer settings).' };
  }

  // --- Who did it: local agent sessions over time (for "likely") ------------------------------------------------
  async function tickActivity() {
    const a = await activity().catch(() => null);
    if (!a) return;
    const t = now();
    const working = new Set((a.agents ?? []).filter((x) => x.running || x.last || (x.hookedAt && t - x.hookedAt < (a.activeMs ?? 0))).map((x) => x.name));
    for (const name of working) if (!openSessions.has(name)) openSessions.set(name, { agent: name, agentId: name, from: t, to: null });
    for (const [name, s] of openSessions) {
      if (!working.has(name)) { s.to = t; sessions.push(s); openSessions.delete(name); }
    }
    while (sessions.length > 500) sessions.shift();
  }
  const allSessions = () => [...sessions, ...openSessions.values()];

  // --- The view -------------------------------------------------------------------------------------------------
  const keyOf = (c) => c.key ?? `${c.id}@${c.at}`;
  const minutes = (ms) => Math.max(0, Math.round(ms / 60_000));

  // A change as the list shows it, with who did it and how sure Mewndo is (desk/connections.js).
  function shape(id, c, ses) {
    const t = now();
    const status = live[id]?.status;
    let at = c.at;
    let from = null;
    if (id === 'notion' && c.changedAt) { from = c.changedAt; at = c.changedAt + 60_000; } // Notion times are to the minute
    else if (id === 'github') { at = c.changedAt ?? c.at; from = c.changedAt ? null : c.from; }
    else from = c.at - (status?.pushOn ? 30_000 : syncEveryMs + 60_000);
    const who = confidenceOf({ at, from, source: 'poll' }, ses);
    const d = id === 'github' ? gh.describe(c) : c;
    const undoable = id === 'github' ? d.undoable && !c.undone : c.undoable;
    return {
      key: keyOf(c), at, ago: minutes(t - at), title: id === 'github' ? c.repo : c.title ?? null, what: d.what,
      confidence: who.confidence, agent: who.agent, why: who.why, note: c.note ?? null, inferred: !!c.inferred,
      undo: c.undone ? { can: false, why: 'Undone by Mewndo.' } : undoable ? { can: true } : { can: false, why: d.why ?? 'Mewndo can’t undo this.' },
    };
  }

  // Changes close together in time are one burst, with one Undo for all of it.
  function bursts(list) {
    const out = [];
    for (const c of list) {
      const last = out[out.length - 1];
      if (last && last.oldest - c.at <= BURST_GAP_MS && (last.repo ?? null) === (c.repo ?? null)) { last.changes.push(c); last.oldest = c.at; } else out.push({ changes: [c], oldest: c.at, repo: c.repo ?? null });
    }
    return out.map((b) => {
      const undoKeys = b.changes.filter((c) => c.undo.can).map((c) => c.key);
      const agents = [...new Set(b.changes.map((c) => (c.confidence === 'unknown' ? null : `${c.agent}${c.confidence === 'likely' ? ' (likely)' : ''}`)).filter(Boolean))];
      return {
        label: b.changes.length > 1 ? `${b.changes.length} changes within ${Math.max(1, minutes(b.changes[0].at - b.oldest))} min` : null,
        who: agents.length ? agents.join(', ') : 'Unknown app or person',
        undoKeys: b.changes.length > 1 && undoKeys.length > 1 ? undoKeys : [],
        changes: b.changes,
      };
    });
  }

  function workerCard(id, ses) {
    const s = SERVICES[id];
    const l = live[id];
    const url = urlOf(id);
    const acct = config.accounts[id];
    const card = { id, name: s.name, what: s.what, limits: s.limits, account: acct?.account ?? null, busy: l.busy, error: l.error, lastChecked: l.lastChecked, notices: [], groups: [] };
    if (!credentials.available) return { ...card, state: 'unavailable', stateLabel: 'Needs Windows', setup: credentials.why };
    if (!url) return { ...card, state: 'not-configured', stateLabel: 'Not set up', setup: setupText(id), env: s.env, folder: s.folder };
    if (l.busy?.kind === 'signing-in') return { ...card, state: 'signing-in', stateLabel: 'Signing in…', worker: url };
    if (!acct) return { ...card, state: 'not-connected', stateLabel: 'Not connected', worker: url, connect: s.signIn };
    const signedOut = !!l.status?.signInError;
    const list = l.changes.filter((c) => c.by !== 'mewndo').map((c) => shape(id, c, ses)).sort((a, b) => b.at - a.at);
    if (s.signIn === 'google') {
      const age = now() - (acct.connectedAt ?? 0);
      if (!signedOut && age > SEVEN_DAYS - 12 * 3600_000) card.notices.push('Google ends Testing-mode sign-ins after 7 days. Yours ends soon: press Connect again.');
      if (l.status && !l.status.pushOn) card.notices.push(`Push is off${l.status.watchError ? ` (${l.status.watchError})` : ''}. Mewndo checks every ${minutes(syncEveryMs)} minutes instead.`);
    }
    if (l.status?.gapAt) card.notices.push(`Mewndo missed changes before ${new Date(l.status.gapAt).toLocaleString()} (Gmail keeps about a week of history).`);
    if (l.status?.r2Warning) card.notices.push(l.status.r2Warning);
    if (id === 'drive' && l.status && !l.status.copies) card.notices.push('No copies are kept (no R2 bucket), so files deleted forever can’t come back.');
    return {
      ...card,
      state: signedOut ? 'signed-out' : 'connected', stateLabel: signedOut ? 'Connect again' : 'Protected',
      protection: signedOut ? 'watch' : 'protected', worker: url, connect: s.signIn,
      groups: bursts(list.slice(0, 60)),
      rows: accountRows({ accounts: [{ id, app: s.name, account: acct.account, protection: 'protected' }], changes: list.map((c) => ({ accountId: id, at: c.at, source: 'poll' })), sessions: ses, now: now() })[0],
    };
  }

  function githubCard(ses) {
    const l = live.github;
    const card = { id: 'github', name: 'GitHub', what: 'Undo branch deletes, force-pushes and closed issues or pull requests in the repos you choose.', limits: gh.LIMITS, busy: l.busy, error: l.error, lastChecked: l.lastChecked, notices: [], groups: [] };
    if (!credentials.available) return { ...card, state: 'unavailable', stateLabel: 'Needs Windows', setup: credentials.why };
    if (!ghConnected()) return { ...card, state: 'not-connected', stateLabel: 'Not connected', connect: 'github-token' };
    const repos = config.github.repos.map((r) => ({ name: r, since: journal.repos[r]?.startedAt ?? null, error: l.repoErrors?.[r] ?? null }));
    const events = Object.values(journal.repos).flatMap((j) => j.events);
    const list = events.map((e) => ({ ...shape('github', e, ses), repo: e.repo })).sort((a, b) => b.at - a.at);
    if (!repos.length) card.notices.push('Choose the repositories Mewndo should journal.');
    return {
      ...card, state: 'connected', stateLabel: repos.length ? 'Protected' : 'Choose repos', protection: repos.length ? 'protected' : 'watch',
      account: `@${config.github.login}`, repos, connect: 'github-token', groups: bursts(list.slice(0, 60)),
    };
  }

  function view() {
    const ses = allSessions();
    return { cards: [...WORKER_IDS.map((id) => workerCard(id, ses)), githubCard(ses)], credentials: credentials.available };
  }

  // --- Settings -------------------------------------------------------------------------------------------------
  function settingsView() {
    return {
      workers: WORKER_IDS.map((id) => ({ id, name: SERVICES[id].name, saved: config.urls[id] ?? '', env: SERVICES[id].env, fromEnv: cleanUrl(env[SERVICES[id].env]) ?? null, folder: SERVICES[id].folder })),
      github: { login: config.github.login, repos: config.github.repos },
      credentials: credentials.available, credentialsWhy: credentials.why,
    };
  }
  async function setUrl(id, text) {
    if (!WORKER_IDS.includes(id)) throw new Error('unknown service');
    if (text === '' || text == null) delete config.urls[id];
    else {
      const u = cleanUrl(text);
      if (!u) throw new Error('Use the Worker’s https:// address, for example https://mewndo-gmail.you.workers.dev');
      config.urls[id] = u;
    }
    await saveConfig();
    changed();
    return settingsView();
  }

  // --- Lifecycle ------------------------------------------------------------------------------------------------
  async function checkAll() {
    await Promise.allSettled([...WORKER_IDS.map(refreshWorker), pollGitHub()]);
  }
  async function start() {
    await load();
    await tickActivity();
    timers.push(setInterval(() => tickActivity().catch(() => {}), activityEveryMs));
    timers.push(setInterval(() => WORKER_IDS.forEach((id) => refreshWorker(id).catch(() => {})), syncEveryMs));
    timers.push(setInterval(() => pollGitHub().catch(() => {}), githubEveryMs));
    setTimeout(() => checkAll().catch(() => {}), 1000);
  }
  function stop() {
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    for (const s of signIns.values()) s.cancelled = true;
  }

  return {
    load, start, stop, view, settingsView, setUrl, checkAll, tickActivity,
    connect: (id) => connectGoogle(id),
    cancelSignIn(id) { const s = signIns.get(id); if (s) s.cancelled = true; },
    connectNotion, setGitHubToken, listRepos, setRepos, pollGitHub, refreshWorker,
    disconnect: (id) => (id === 'github' ? disconnectGitHub() : disconnectWorker(id)),
    check: (id) => (id === 'github' ? pollGitHub() : refreshWorker(id)),
    undo: (id, keys) => (id === 'github' ? undoGitHub(keys) : undoWorker(id, keys)),
    _journal: () => journal, _config: () => config,
  };
}

module.exports = { createConnections, BURST_GAP_MS };
