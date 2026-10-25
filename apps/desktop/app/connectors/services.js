// Gmail, Google Drive and Notion: what each one is, its honest limits (spec §25.3, §28.10, the Workers' READMEs),
// where its Worker is, and a small client for the Worker's app routes (cloud/*/src/index.js).
// Plain Node: fetch is injected, so tests run without a network.

const crypto = require('node:crypto');
const { requestJson } = require('./http');

const SERVICES = {
  gmail: {
    id: 'gmail', name: 'Gmail', env: 'MEWNDO_GMAIL_URL', folder: 'cloud/gmail', signIn: 'google',
    what: 'Undo trash and label changes an agent makes in your mail.',
    restorePath: '/gmail/restore', idsField: 'messageIds', noun: ['message', 'messages'],
    limits: [
      'Gmail has no undelete: mail deleted forever can’t come back (Mewndo keeps no copy of your mail).',
      'Sent mail can’t be unsent.',
      'Only changes after you connect are journaled.',
      'While the Google project is in Testing mode, Google ends the sign-in after 7 days: connect again weekly.',
      'Without Pub/Sub push, Mewndo checks every few minutes, so who did it is a guess by time.',
    ],
  },
  drive: {
    id: 'drive', name: 'Google Drive', env: 'MEWNDO_DRIVE_URL', folder: 'cloud/drive', signIn: 'google',
    what: 'Put back files an agent trashed, moved or renamed in Drive.',
    restorePath: '/drive/restore', idsField: 'fileIds', noun: ['file', 'files'],
    limits: [
      'A file deleted forever comes back only from a copy Mewndo kept (optional R2 bucket, watched folders), as a NEW file with a new id: old share links stop working.',
      'Older file content isn’t put back; use Version history in Drive.',
      'Only changes after you connect are journaled.',
      'While the Google project is in Testing mode, Google ends the sign-in after 7 days: connect again weekly.',
    ],
  },
  notion: {
    id: 'notion', name: 'Notion', env: 'MEWNDO_NOTION_URL', folder: 'cloud/notion', signIn: 'notion-secret',
    what: 'Undo page trashes and removed blocks in pages you share with Mewndo.',
    restorePath: '/notion/restore', idsField: 'pageIds', noun: ['page', 'pages'],
    limits: [
      'Notion tells Mewndo about changes a minute or more late, so Notion undo takes about one to two minutes.',
      'Put-back blocks get new block ids and go at the end of the page; blocks added since stay.',
      'Only the top level of each page (first 100 blocks), and only pages shared with your integration.',
      'Only changes after you connect are journaled.',
    ],
  },
};

const WORKER_IDS = Object.keys(SERVICES);

// https://… (or http://localhost / 127.0.0.1 for `wrangler dev`), without a trailing slash; null if it isn't one.
function cleanUrl(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let u;
  try { u = new URL(text.trim()); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

// Where a service's Worker is: the Settings field first, else the environment variable, else nowhere.
function workerUrl(id, { saved = {}, env = process.env } = {}) {
  return cleanUrl(saved[id]) ?? cleanUrl(env[SERVICES[id].env]) ?? null;
}

// The words for a card whose Worker isn't set up: exactly what to deploy and where to put its address.
function setupText(id) {
  const s = SERVICES[id];
  return `Not set up. Deploy the ${s.name} Worker from ${s.folder} with “npx wrangler@3 deploy”, then paste its address in `
    + `Settings → Connections (or set ${s.env}). Steps: docs/connections-setup.md.`;
}

// For Google sign-in: a secret only the app knows, and the hash the browser carries.
function newClaim() {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: crypto.createHash('sha256').update(secret).digest('hex') };
}

const DEADLINES = { status: 10_000, changes: 20_000, sync: 30_000, claim: 8_000, connect: 30_000, restore: 120_000, disconnect: 15_000 };

// A client for one Worker. getToken() reads the app token from Credential Manager.
function workerClient({ id, baseUrl, getToken, fetch = globalThis.fetch }) {
  const s = SERVICES[id];
  const what = `The ${s.name} Worker`;
  const call = async (path, { method = 'GET', body, auth = true, deadline }) => {
    const token = auth ? getToken() : null;
    if (auth && !token) throw Object.assign(new Error(`${s.name} isn’t connected.`), { code: 'NO_TOKEN' });
    const r = await requestJson(fetch, `${baseUrl}${path}`, {
      method, body, deadlineMs: deadline, what, secrets: token ? [token] : [],
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (r.status === 401) throw Object.assign(new Error(`${s.name} needs you to connect again.`), { code: 'SIGNED_OUT' });
    if (!r.ok && !(path === '/oauth/claim' && r.status === 404)) {
      throw new Error(`${what} answered ${r.status}${r.data?.error ? `: ${r.data.error}` : '.'}`);
    }
    return r;
  };
  return {
    startUrl: (claimHash) => `${baseUrl}/oauth/start?claim=${claimHash}`,
    // { user, token } once the browser sign-in finished, or null while it hasn't.
    async claim(secret) {
      const r = await call('/oauth/claim', { method: 'POST', body: { claim: secret }, auth: false, deadline: DEADLINES.claim });
      return r.status === 404 ? null : r.data;
    },
    async connectNotion(secret) {
      const r = await requestJson(fetch, `${baseUrl}/notion/connect`, { method: 'POST', body: { token: secret }, deadlineMs: DEADLINES.connect, what, secrets: [secret] });
      if (!r.ok) throw new Error(r.data?.error ?? `${what} answered ${r.status}.`);
      return r.data;
    },
    status: async () => (await call('/app/status', { deadline: DEADLINES.status })).data,
    sync: async () => (await call('/app/sync', { method: 'POST', body: {}, deadline: DEADLINES.sync })).data,
    changes: async () => (await call('/app/changes', { deadline: DEADLINES.changes })).data?.changes ?? [],
    restore: async (ids, before) => (await call(s.restorePath, { method: 'POST', body: { [s.idsField]: ids, before }, deadline: DEADLINES.restore })).data,
    disconnect: async () => (await call('/app/disconnect', { method: 'POST', body: {}, deadline: DEADLINES.disconnect })).data,
  };
}

// A Worker's restore answer, in one sentence for the user.
function restoreSummary(id, r) {
  const s = SERVICES[id];
  const n = (k, word) => `${k} ${word[k === 1 ? 0 : 1]}`;
  if (id === 'gmail') {
    const gone = r?.permanently_deleted?.length ?? 0;
    return [`Put back ${n(r?.restored ?? 0, s.noun)} in Gmail.`, gone ? `${n(gone, s.noun)} were deleted forever and can’t come back.` : ''].filter(Boolean).join(' ');
  }
  if (id === 'drive') {
    const back = r?.restored?.length ?? 0;
    const re = (r?.reuploaded ?? []).filter((x) => x.restored).length;
    const lost = (r?.reuploaded ?? []).filter((x) => !x.restored).length;
    const failed = r?.failed?.length ?? 0;
    return [`Put back ${n(back, s.noun)} in Drive.`,
      re ? `${n(re, s.noun)} came back from Mewndo’s copy with a new id: share links need redoing.` : '',
      lost ? `${n(lost, s.noun)} had no copy and can’t come back.` : '',
      failed ? `${failed} couldn’t be changed (see the log).` : ''].filter(Boolean).join(' ');
  }
  const pages = r?.restored?.length ?? 0;
  const blocks = (r?.restored ?? []).reduce((k, p) => k + (p.blocks_restored ?? 0), 0);
  const failed = r?.failed?.length ?? 0;
  return [`Put back ${n(pages, s.noun)} in Notion${blocks ? ` (${blocks} blocks, at the end of each page, with new ids)` : ''}.`,
    failed ? `${failed} couldn’t be changed (see the log).` : ''].filter(Boolean).join(' ');
}

module.exports = { SERVICES, WORKER_IDS, workerClient, workerUrl, cleanUrl, setupText, newClaim, restoreSummary, DEADLINES };
