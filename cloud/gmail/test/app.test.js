// The app-facing side of the Gmail Worker: sign-in claim, app token, journal helpers, and that every route which
// reads the journal or changes the mailbox refuses a request without the account's app token.
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { makeAppToken, parseAppToken, accountFrom, sha256hex, newSecret } from '../src/app-auth.js'
import { historyToEntries, fromBefore, changeList, healPlan } from '../src/heal.js'
import worker, { GmailUser } from '../src/index.js'
import { fakeNamespace, withFetch } from './fake-do.js'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))

test('the three Workers carry the same app-auth.js', () => {
  const gmail = readFileSync(here('../src/app-auth.js'), 'utf8')
  assert.equal(readFileSync(here('../../drive/src/app-auth.js'), 'utf8'), gmail)
  assert.equal(readFileSync(here('../../notion/src/app-auth.js'), 'utf8'), gmail)
})

test('an app token names its account and only its own secret passes', async () => {
  const { token, hash } = await makeAppToken('priya@gmail.com')
  const parsed = parseAppToken(`Bearer ${token}`)
  assert.equal(parsed.account, 'priya@gmail.com')
  assert.equal(await sha256hex(parsed.secret), hash)
  const req = (t) => new Request('https://w/app/status', { headers: { authorization: `Bearer ${t}` } })
  assert.equal(await accountFrom(req(token), async () => hash), 'priya@gmail.com')
  const forged = token.replace(/\.[^.]+$/, `.${newSecret()}`)
  assert.equal(await accountFrom(req(forged), async () => hash), null)
  assert.equal(await accountFrom(req(token), async () => null), null, 'an account with no token stored')
  assert.equal(parseAppToken('Bearer nonsense'), null)
})

test('history records give the state before and after without a call per message', () => {
  const items = historyToEntries([
    { labelsRemoved: [{ message: { id: 'a', labelIds: ['UNREAD'] }, labelIds: ['INBOX'] }] },
    { labelsAdded: [{ message: { id: 'a', labelIds: ['UNREAD', 'TRASH'] }, labelIds: ['TRASH'] }] },
    { messagesAdded: [{ message: { id: 'new', labelIds: ['INBOX'] } }] },
    { messagesDeleted: [{ message: { id: 'gone' } }] },
    { messages: [{ id: 'mystery' }] },
  ])
  const a = items.find((x) => x.id === 'a')
  assert.deepEqual(a.before.labelIds.sort(), ['INBOX', 'UNREAD'])
  assert.equal(a.before.trashed, false)
  assert.equal(a.after.trashed, true)
  assert.equal(items.find((x) => x.id === 'new').before, null, 'a new message had no earlier state')
  assert.equal(items.find((x) => x.id === 'gone').after.gone, true)
  assert.equal(items.find((x) => x.id === 'mystery').needsFetch, true)
})

test('fromBefore makes the restore go back to just before the chosen change', () => {
  const entries = [
    { id: 'm', labelIds: ['INBOX', 'UNREAD'], trashed: false, at: 1 },
    { id: 'm', labelIds: ['INBOX'], trashed: false, at: 5 }, // the user read it
    { id: 'm', labelIds: ['TRASH'], trashed: true, at: 9 }, // the agent trashed it
  ]
  const plan = healPlan(fromBefore(entries, 9))
  assert.deepEqual(plan.untrash, ['m'])
  assert.deepEqual(Object.keys(plan.relabel), [JSON.stringify({ add: ['INBOX'], remove: [] })], 'UNREAD is not put back')
  assert.equal(fromBefore(entries, 0).length, 3)
})

test('changeList words each change and is honest about permanent deletes', () => {
  const list = changeList([
    { id: 'x', labelIds: ['INBOX', 'UNREAD'], trashed: false, at: 1, inferred: true },
    { id: 'x', labelIds: ['UNREAD'], trashed: false, at: 2 },
    { id: 'y', labelIds: ['INBOX'], trashed: false, at: 1 },
    { id: 'y', labelIds: [], trashed: false, gone: true, at: 3 },
    { id: 'z', labelIds: ['INBOX'], trashed: false, at: 1 },
    { id: 'z', labelIds: ['TRASH'], trashed: true, at: 4, by: 'mewndo' },
  ])
  assert.deepEqual(list.map((c) => c.id), ['z', 'y', 'x'], 'newest first')
  const [z, y, x] = list
  assert.equal(x.what, 'Archived')
  assert.equal(x.undoable, true)
  assert.equal(x.restoreBefore, 2)
  assert.equal(y.undoable, false)
  assert.match(y.why, /no undelete/)
  assert.equal(z.kind, 'trashed')
  assert.equal(z.by, 'mewndo')
})

function env() {
  return { GMAIL_USER: fakeNamespace(GmailUser), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_PUBSUB_TOPIC: 'projects/YOUR-PROJECT-ID/topics/x' }
}

test('restore, changes, status and disconnect refuse a request without the app token', async () => {
  const e = env()
  for (const [path, method] of [['/gmail/restore', 'POST'], ['/app/changes', 'GET'], ['/app/status', 'GET'], ['/app/sync', 'POST'], ['/app/disconnect', 'POST']]) {
    const r = await worker.fetch(new Request(`https://w${path}`, { method, body: method === 'POST' ? JSON.stringify({ user: 'priya@gmail.com' }) : undefined }), e)
    assert.equal(r.status, 401, path)
  }
})

test('sign-in: start redirects to Google with the claim; the callback parks a token the app collects once', async (t) => {
  const e = env()
  const secret = newSecret()
  const claim = await sha256hex(secret)
  const start = await worker.fetch(new Request(`https://w/oauth/start?claim=${claim}`), e)
  assert.equal(start.status, 302)
  const to = new URL(start.headers.get('location'))
  assert.equal(to.searchParams.get('state'), claim)
  assert.equal(to.searchParams.get('access_type'), 'offline')
  assert.match(to.searchParams.get('scope'), /gmail\.modify/)
  assert.equal(to.searchParams.get('redirect_uri'), 'https://w/oauth/callback')

  withFetch(t, (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return { access_token: 'at', refresh_token: 'refresh-SECRET-123', scope: 'https://www.googleapis.com/auth/gmail.modify' }
    if (url.endsWith('/profile')) return { emailAddress: 'priya@gmail.com', historyId: '100' }
    return new Response('{}', { status: 500 })
  })
  const page = await worker.fetch(new Request(`https://w/oauth/callback?code=c&state=${claim}`), e)
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(html, /priya@gmail\.com/)
  assert.doesNotMatch(html, /mw1\./, 'the page never shows the token')

  const take = () => worker.fetch(new Request('https://w/oauth/claim', { method: 'POST', body: JSON.stringify({ claim: secret }) }), e)
  const got = await take().then((r) => r.json())
  assert.equal(got.user, 'priya@gmail.com')
  assert.match(got.token, /^mw1\./)
  assert.equal((await take()).status, 404, 'a claim is collected once')
  const wrong = await worker.fetch(new Request('https://w/oauth/claim', { method: 'POST', body: JSON.stringify({ claim: newSecret() }) }), e)
  assert.equal(wrong.status, 404)

  const status = await worker.fetch(new Request('https://w/app/status', { headers: { authorization: `Bearer ${got.token}` } }), e).then((r) => r.json())
  assert.equal(status.user, 'priya@gmail.com')
  assert.equal(status.connected, true)
  assert.equal(status.pushOn, false)
  assert.match(status.watchError, /Pub\/Sub/)
  assert.equal(JSON.stringify(status).includes('refresh-SECRET'), false, 'the refresh token never leaves the Worker')
})
