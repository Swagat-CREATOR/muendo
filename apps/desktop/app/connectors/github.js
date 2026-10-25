// GitHub, locally: no Worker. The user pastes a fine-grained personal access token (kept in Credential Manager as
// Mewndo/github-token); Mewndo journals, for the repos the user picks, each branch's head and the default branch's
// protection, and open/closed issues and pull requests, polling api.github.com with ETags (304s don't count against
// the rate limit). Undo: recreate a deleted branch at its journaled SHA, move a force-pushed branch back, reopen
// an issue or pull request. Plain Node; fetch is injected so tests run without a network.
//
// What it can't do (shown in the app): only changes after Mewndo started journaling a repo; a deleted repository
// can't come back; moving a force-pushed branch back rewrites its history again; a merged pull request can't be
// reopened; turning branch protection back on needs a permission Mewndo doesn't ask for.

const { requestJson } = require('./http');

const API = 'https://api.github.com';
const DEADLINE_MS = 15_000;
const MAX_EVENTS = 300;
const ISSUE_PAGES = 5; // 500 issue updates between two polls is the most Mewndo will notice
const BRANCH_PAGES = 3; // 300 branches per repo

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TOKEN_RE = /^(github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{30,255})$/;

const short = (sha) => String(sha ?? '').slice(0, 7);
// A branch name as path segments, each encoded ("feature/x" stays two segments).
const refPath = (branch) => String(branch).split('/').map(encodeURIComponent).join('/');

const LIMITS = [
  'Only changes after Mewndo started journaling a repo can be undone.',
  'A deleted repository can’t come back.',
  'Moving a force-pushed branch back rewrites its history again; anyone who pulled since must reset.',
  'A merged pull request can’t be reopened; revert it on GitHub instead.',
  'Mewndo checks every 5 minutes, so who did it is a guess by time unless GitHub names the account.',
];

// The REST client. getToken() reads Credential Manager; the token never reaches a message or the log.
function githubClient({ getToken, fetch = globalThis.fetch, deadlineMs = DEADLINE_MS }) {
  const etags = new Map(); // url -> { etag, data }: in memory only
  let rate = { remaining: null, reset: null };
  async function request(method, path, { body, cache = false } = {}) {
    const token = getToken();
    if (!token) throw Object.assign(new Error('GitHub isn’t connected: add a token first.'), { code: 'NO_TOKEN' });
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    const cached = cache ? etags.get(url) : null;
    const r = await requestJson(fetch, url, {
      method, body, deadlineMs, what: 'GitHub', secrets: [token],
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'Mewndo', ...(cached ? { 'if-none-match': cached.etag } : {}),
      },
    });
    const remaining = r.headers?.get?.('x-ratelimit-remaining');
    if (remaining != null) rate = { remaining: Number(remaining), reset: Number(r.headers.get('x-ratelimit-reset')) * 1000 };
    if (r.status === 304 && cached) return { status: 200, data: cached.data, notModified: true, headers: r.headers };
    if (r.status === 401) throw Object.assign(new Error('GitHub no longer accepts the saved token (expired or revoked). Add a new one.'), { code: 'SIGNED_OUT' });
    if (cache && r.ok && r.headers?.get?.('etag')) etags.set(url, { etag: r.headers.get('etag'), data: r.data });
    return { status: r.status, data: r.data, headers: r.headers };
  }
  return {
    request,
    rate: () => rate,
    async get(path, opts) {
      const r = await request('GET', path, { cache: true, ...opts });
      if (r.status === 404) return { ...r, missing: true };
      if (r.status >= 400) throw apiError(r);
      return r;
    },
  };
}

function apiError(r) {
  const msg = r.data?.message ? `GitHub said: ${r.data.message}` : `GitHub answered ${r.status}.`;
  return Object.assign(new Error(r.status === 403 && /rate limit/i.test(r.data?.message ?? '') ? 'GitHub’s rate limit is used up; Mewndo will try again after it resets.' : msg), { status: r.status });
}

const nextLink = (headers) => /<([^>]+)>;\s*rel="next"/.exec(headers?.get?.('link') ?? '')?.[1] ?? null;

// The repo's state now: default branch, every branch's head and protection, and issues/PRs updated recently.
// prev: the journal's last snapshot (for the issues window), or null on the first look.
async function snapshotRepo(client, repo, prev) {
  if (!REPO_RE.test(repo)) throw new Error(`not a repository name: ${repo}`);
  const meta = await client.get(`/repos/${repo}`);
  if (meta.missing) return { missing: true };
  const branches = {};
  let url = `/repos/${repo}/branches?per_page=100`;
  for (let page = 0; url && page < BRANCH_PAGES; page++) {
    const r = await client.get(url);
    for (const b of r.data ?? []) branches[b.name] = { sha: b.commit?.sha, protected: !!b.protected };
    url = nextLink(r.headers);
  }
  // Issues and PRs: every open one on the first look; after that, those updated since the last look.
  const items = {};
  const since = prev?.at ? prev.at - 120_000 : null;
  url = since ? `/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100` : `/repos/${repo}/issues?state=open&per_page=100`;
  for (let page = 0; url && page < ISSUE_PAGES; page++) {
    const r = await client.get(url);
    let older = false;
    for (const it of r.data ?? []) {
      const updated = Date.parse(it.updated_at);
      if (since && updated < since) { older = true; break; }
      items[it.number] = {
        kind: it.pull_request ? 'pr' : 'issue', title: String(it.title ?? '').slice(0, 200), state: it.state,
        merged: !!it.pull_request?.merged_at, closedAt: it.closed_at ? Date.parse(it.closed_at) : null, updatedAt: updated,
      };
    }
    url = older ? null : nextLink(r.headers);
  }
  return { at: Date.now(), defaultBranch: meta.data.default_branch, branches, items };
}

// How a branch moved: 'ahead' is a normal push; 'diverged' or 'behind' rewrote history; 'unknown' when GitHub
// can't compare (the old commit is gone).
async function relation(client, repo, from, to) {
  const r = await client.get(`/repos/${repo}/compare/${from}...${to}`).catch(() => ({ missing: true }));
  return r.missing ? 'unknown' : r.data?.status ?? 'unknown';
}

// What changed between two snapshots, as journal events. relations: { [branch]: 'ahead'|'diverged'|... }.
// Pure: tests call it directly.
function diffSnapshots(repo, prev, next, { relations = {}, now = Date.now() } = {}) {
  if (!prev || !next || next.missing) return [];
  const events = [];
  const add = (e) => events.push({ repo, at: now, from: prev.at ?? null, ...e, key: `${repo}#${e.kind}#${e.branch ?? e.number}#${now}` });
  for (const [name, b] of Object.entries(prev.branches ?? {})) {
    const cur = next.branches?.[name];
    if (!cur) add({ kind: 'branch-deleted', branch: name, sha: b.sha });
    else if (cur.sha !== b.sha) {
      const rel = relations[name] ?? 'unknown';
      if (rel === 'ahead') add({ kind: 'push', branch: name, fromSha: b.sha, toSha: cur.sha });
      else add({ kind: 'force-push', branch: name, fromSha: b.sha, toSha: cur.sha, relation: rel });
    }
  }
  for (const [name, b] of Object.entries(next.branches ?? {})) {
    if (!prev.branches?.[name]) add({ kind: 'branch-created', branch: name, sha: b.sha });
  }
  const def = next.defaultBranch;
  if (def && prev.branches?.[def]?.protected && next.branches?.[def] && !next.branches[def].protected) {
    add({ kind: 'protection-off', branch: def });
  }
  for (const [num, it] of Object.entries(next.items ?? {})) {
    const was = prev.items?.[num];
    if (!was || was.state !== 'open' || it.state !== 'closed') continue;
    const e = { kind: it.kind === 'pr' ? (it.merged ? 'pr-merged' : 'pr-closed') : 'issue-closed', number: Number(num), title: it.title };
    if (it.closedAt) { e.changedAt = it.closedAt; }
    add(e);
  }
  return events;
}

// The journal's snapshot after a poll: branches as they are now; items merged (a poll only sees recent ones).
function mergeSnapshot(prev, next) {
  if (!next || next.missing) return prev;
  return { at: next.at, defaultBranch: next.defaultBranch, branches: next.branches, items: { ...(prev?.items ?? {}), ...next.items } };
}

// Words for an event, and whether it can be undone at all.
function describe(e) {
  switch (e.kind) {
    case 'branch-deleted': return { what: `Branch “${e.branch}” deleted (was at ${short(e.sha)})`, undoable: true };
    case 'force-push': return { what: `Branch “${e.branch}” force-pushed: ${short(e.fromSha)} → ${short(e.toSha)}`, undoable: true };
    case 'push': return { what: `New commits on “${e.branch}”: ${short(e.fromSha)} → ${short(e.toSha)}`, undoable: false, why: 'A normal push. Undo it with git revert, so history isn’t rewritten.' };
    case 'branch-created': return { what: `Branch “${e.branch}” created at ${short(e.sha)}`, undoable: false, why: 'Mewndo doesn’t delete branches.' };
    case 'protection-off': return { what: `Protection turned off on “${e.branch}”`, undoable: false, why: 'Turning it back on needs the Administration permission, which Mewndo’s token doesn’t ask for. Do it in the repo’s Settings → Branches.' };
    case 'issue-closed': return { what: `Issue #${e.number} closed: ${e.title}`, undoable: true };
    case 'pr-closed': return { what: `Pull request #${e.number} closed: ${e.title}`, undoable: true };
    case 'pr-merged': return { what: `Pull request #${e.number} merged: ${e.title}`, undoable: false, why: 'A merged pull request can’t be reopened. Revert it on GitHub instead.' };
    default: return { what: e.kind, undoable: false, why: 'Mewndo can’t undo this.' };
  }
}

// The plan for undoing one event, from the repo's state now. confirmations: texts the user must say yes to, in
// order (the main process asks with its own dialogs, so the window can't skip them). Never guesses: if the branch
// moved again, or the issue is already open, it says so and does nothing.
//   current: { branches: { [name]: { sha, protected } } | null (unknown), items: { [n]: { state, merged } } }
function planUndo(e, current, { defaultBranch } = {}) {
  const d = describe(e);
  if (!d.undoable) return { can: false, why: d.why };
  if (e.undone) return { can: false, why: 'Already undone.' };
  const repo = e.repo;
  if (e.kind === 'branch-deleted') {
    if (!SHA_RE.test(e.sha ?? '')) return { can: false, why: 'Mewndo has no commit for this branch.' };
    const now = current?.branches?.[e.branch];
    if (now) return { can: false, why: `A branch called “${e.branch}” exists again (at ${short(now.sha)}); Mewndo won’t overwrite it.` };
    return {
      can: true, kind: e.kind,
      steps: [{ method: 'POST', path: `/repos/${repo}/git/refs`, body: { ref: `refs/heads/${e.branch}`, sha: e.sha } }],
      confirmations: [`Recreate branch “${e.branch}” in ${repo} at ${short(e.sha)}?`],
      done: `Branch “${e.branch}” is back at ${short(e.sha)}.`,
      expect: { branch: e.branch, sha: e.sha },
    };
  }
  if (e.kind === 'force-push') {
    if (!SHA_RE.test(e.fromSha ?? '') || !SHA_RE.test(e.toSha ?? '')) return { can: false, why: 'Mewndo has no commit for this branch.' };
    const now = current?.branches?.[e.branch];
    if (!now) return { can: false, why: `“${e.branch}” no longer exists. Undo its deletion first.` };
    if (now.sha !== e.toSha) return { can: false, why: `“${e.branch}” moved again since (now at ${short(now.sha)}). Undo the newest change first.` };
    const confirmations = [
      `Move branch “${e.branch}” in ${repo} back from ${short(e.toSha)} to ${short(e.fromSha)}?\n\n`
      + `This rewrites the branch’s history again: commits after ${short(e.fromSha)} leave the branch (GitHub keeps them reachable by SHA for a while). `
      + `Anyone who pulled ${short(e.toSha)} will need to reset.${now.protected ? '\n\nThe branch is protected: GitHub refuses this if its rules block force pushes.' : ''}`,
    ];
    if (e.branch === defaultBranch) {
      confirmations.push(`“${e.branch}” is ${repo}’s default branch. Move it from ${short(e.toSha)} back to ${short(e.fromSha)} anyway?`);
    }
    return {
      can: true, kind: e.kind,
      steps: [{ method: 'PATCH', path: `/repos/${repo}/git/refs/heads/${refPath(e.branch)}`, body: { sha: e.fromSha, force: true } }],
      confirmations,
      done: `“${e.branch}” is back at ${short(e.fromSha)}.`,
      expect: { branch: e.branch, sha: e.fromSha },
    };
  }
  // Issues and pull requests.
  const now = current?.items?.[e.number];
  if (now?.state === 'open') return { can: false, why: `#${e.number} is open again already.` };
  if (now?.merged) return { can: false, why: 'It has been merged since; a merged pull request can’t be reopened.' };
  const isPr = e.kind === 'pr-closed';
  return {
    can: true, kind: e.kind,
    steps: [{ method: 'PATCH', path: `/repos/${repo}/${isPr ? 'pulls' : 'issues'}/${e.number}`, body: { state: 'open' } }],
    confirmations: [],
    done: `${isPr ? 'Pull request' : 'Issue'} #${e.number} is open again.`,
    expect: { number: e.number },
  };
}

// Several plans as one: one confirmation listing everything, and the default-branch one if any needs it.
// Branches come back first, then branch moves, then reopens (a pull request needs its branch).
function planBurst(plans) {
  const ok = plans.filter((p) => p.can);
  const order = { 'branch-deleted': 0, 'force-push': 1, 'pr-closed': 2, 'issue-closed': 3 };
  ok.sort((a, b) => order[a.kind] - order[b.kind]);
  if (!ok.length) return { can: false, why: plans[0]?.why ?? 'Nothing here can be undone.' };
  const needsSecond = ok.filter((p) => p.confirmations.length > 1);
  const lines = ok.map((p) => `• ${p.confirmations[0]?.split('\n')[0] ?? p.done.replace(/ is open again\.$/, ': reopen')}`);
  const confirmations = ok.some((p) => p.confirmations.length)
    ? [`Undo ${ok.length} change${ok.length === 1 ? '' : 's'}?\n\n${lines.join('\n')}`] : [];
  if (needsSecond.length) confirmations.push(needsSecond.map((p) => p.confirmations[1]).join('\n\n'));
  return { can: true, plans: ok, skipped: plans.length - ok.length, confirmations };
}

// Ask every confirmation (main process dialogs), then run the steps. Returns { ok, done[], failed[] }.
async function executeUndo(client, plans, { confirmations = [], confirm }) {
  for (const text of confirmations) {
    if (!(await confirm(text))) return { ok: false, cancelled: true, done: [], failed: [] };
  }
  const done = [];
  const failed = [];
  for (const p of plans) {
    try {
      for (const step of p.steps) {
        const r = await client.request(step.method, step.path, { body: step.body });
        if (r.status >= 400) {
          const why = r.status === 422 && p.kind === 'pr-closed'
            ? 'GitHub refused to reopen it (if its branch was deleted or force-pushed, undo that first).'
            : r.status === 422 && p.kind === 'branch-deleted'
              ? 'GitHub refused: the commit may be gone, or a branch with that name exists.'
              : apiError(r).message;
          throw new Error(why);
        }
      }
      done.push(p);
    } catch (e) {
      failed.push({ plan: p, why: e.message });
    }
  }
  return { ok: failed.length === 0, done, failed };
}

module.exports = {
  githubClient, snapshotRepo, relation, diffSnapshots, mergeSnapshot, describe, planUndo, planBurst, executeUndo,
  LIMITS, REPO_RE, TOKEN_RE, short,
};
