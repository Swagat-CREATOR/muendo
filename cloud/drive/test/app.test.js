// The app-facing side of the Drive Worker: renames, the inferred "before" of a first-seen trashed file, the change
// list, optional R2, and that every account route refuses a request without the app token.
import { test } from 'node:test'
import assert from 'node:assert'
import { healPlan, fromBefore, inferBefore, changeList } from '../src/heal.js'
import { newSecret, sha256hex } from '../src/app-auth.js'
import worker, { DriveUser } from '../src/index.js'
import { fakeNamespace, withFetch } from '../../gmail/test/fake-do.js'

test('a renamed file gets its old name back', () => {
  const p = healPlan([
    { id: 'f', at: 1, trashed: false, parents: ['A'], name: 'plan.docx' },
    { id: 'f', at: 2, trashed: false, parents: ['A'], name: 'old-plan.docx' },
  ])
  assert.deepEqual(p.rename, [{ id: 'f', name: 'plan.docx' }])
  assert.equal(p.untrash.length, 0)
})

test('a file first seen in the trash was in the same folder, untrashed; anything else first seen has no before', () => {
  const b = inferBefore({ id: 'f', at: 5, trashed: true, gone: false, parents: ['A'], name: 'x' })
  assert.equal(b.trashed, false)
  assert.deepEqual(b.parents, ['A'])
  assert.equal(b.inferred, true)
  assert.equal(inferBefore({ id: 'g', at: 5, trashed: false, gone: false, parents: ['B'] }), null)
  assert.equal(inferBefore({ id: 'h', at: 5, trashed: false, gone: true, parents: [] }), null)
})

test('changeList: trash and moves can be undone, permanent deletes and edits say why not', () => {
  const entries = [
    { id: 't', at: 1, trashed: false, parents: ['A'], name: 't.txt' },
    { id: 't', at: 4, trashed: true, parents: ['A'], name: 't.txt' },
    { id: 'm', at: 1, trashed: false, parents: ['A'], name: 'm.txt' },
    { id: 'm', at: 3, trashed: false, parents: ['B'], name: 'm.txt' },
    { id: 'd', at: 1, trashed: false, parents: ['A'], name: 'd.txt', revision: 'r1' },
    { id: 'd', at: 2, gone: true, trashed: false, parents: [] },
    { id: 'e', at: 1, trashed: false, parents: ['A'], name: 'e.txt', revision: 'r1' },
    { id: 'e', at: 5, trashed: false, parents: ['A'], name: 'e.txt', revision: 'r2' },
  ]
  const list = changeList(entries)
  assert.deepEqual(list.map((c) => c.id), ['e', 't', 'm', 'd'])
  const by = Object.fromEntries(list.map((c) => [c.id, c]))
  assert.equal(by.t.undoable, true)
  assert.equal(by.t.title, 't.txt')
  assert.equal(by.m.kind, 'moved')
  assert.equal(by.d.undoable, false)
  assert.match(by.d.why, /no copy/)
  assert.equal(by.e.undoable, false)
  assert.match(by.e.why, /Version history/)
  // Undoing the move only: fromBefore(…, 3) starts at the state just before it.
  assert.deepEqual(healPlan(fromBefore(entries, 3), ['m']).untrash[0].addParents, ['A'])
})

const env = () => ({ DRIVE_USER: fakeNamespace(DriveUser), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs' })

test('account routes refuse a request without the app token, and never take the account from the body', async () => {
  const e = env()
  for (const [path, method] of [['/drive/restore', 'POST'], ['/drive/watched', 'POST'], ['/drive/budget', 'GET'], ['/app/changes', 'GET'], ['/app/status', 'GET'], ['/app/disconnect', 'POST']]) {
    const r = await worker.fetch(new Request(`https://w${path}?user=priya@gmail.com`, { method, body: method === 'POST' ? JSON.stringify({ user: 'priya@gmail.com' }) : undefined }), e)
    assert.equal(r.status, 401, path)
  }
})

test('sign-in parks a token; status says copies are off without an R2 bucket', async (t) => {
  const e = env()
  const secret = newSecret()
  const claim = await sha256hex(secret)
  const calls = withFetch(t, (url) => {
    if (url.startsWith('https://oauth2.googleapis.com/token')) return { access_token: 'at', refresh_token: 'refresh-SECRET-9', scope: 'https://www.googleapis.com/auth/drive' }
    if (url.includes('/about')) return { user: { emailAddress: 'priya@gmail.com' } }
    if (url.includes('changes/startPageToken')) return { startPageToken: '7' }
    if (url.includes('changes/watch')) return { resourceId: 'res1', expiration: String(Date.now() + 3600e3) }
    return new Response('{}', { status: 500 })
  })
  const page = await worker.fetch(new Request(`https://mewndo-drive.me.workers.dev/oauth/callback?code=c&state=${claim}`), e)
  assert.equal(page.status, 200)
  const watch = calls.find((c) => c.url.includes('changes/watch'))
  const body = JSON.parse(watch.init.body)
  assert.equal(body.address, 'https://mewndo-drive.me.workers.dev/drive/push', 'the Worker uses its own address')
  assert.equal(body.token, 'priya@gmail.com', 'the push names the account')
  const got = await worker.fetch(new Request('https://w/oauth/claim', { method: 'POST', body: JSON.stringify({ claim: secret }) }), e).then((r) => r.json())
  const auth = { authorization: `Bearer ${got.token}` }
  const status = await worker.fetch(new Request('https://w/app/status', { headers: auth }), e).then((r) => r.json())
  assert.equal(status.connected, true)
  assert.equal(status.copies, false)
  assert.equal(JSON.stringify(status).includes('refresh-SECRET'), false)
})
