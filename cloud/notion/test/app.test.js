// The app-facing side of the Notion Worker: connect with an integration secret, the change list, restoring to just
// before a chosen change, and that account routes need the app token.
import { test } from 'node:test'
import assert from 'node:assert'
import { restorePlan, fromBefore, changeList, looksLikeNotionToken } from '../src/heal.js'
import worker, { NotionUser } from '../src/index.js'
import { fakeNamespace, withFetch } from '../../gmail/test/fake-do.js'

const para = (text) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] } })

test('only something shaped like an integration secret is sent to Notion', () => {
  assert.equal(looksLikeNotionToken(`ntn_${'a1'.repeat(20)}`), true)
  assert.equal(looksLikeNotionToken(`secret_${'B2'.repeat(20)}`), true)
  assert.equal(looksLikeNotionToken('my password 123'), false)
  assert.equal(looksLikeNotionToken('ntn_short'), false)
})

test('changeList: removed blocks and trash can be undone; added blocks say why not', () => {
  const list = changeList([
    { id: 'p', at: 1, edited: 1, in_trash: false, title: 'Plan', blocks: [para('a'), para('b')] },
    { id: 'p', at: 60, edited: 50, in_trash: false, title: 'Plan', blocks: [para('a')] },
    { id: 'q', at: 1, in_trash: false, title: 'Notes', blocks: [] },
    { id: 'q', at: 70, in_trash: false, title: 'Notes', blocks: [para('new')] },
    { id: 'r', at: 1, in_trash: false, title: 'Old', blocks: [] },
    { id: 'r', at: 80, in_trash: true, title: 'Old', blocks: [] },
  ])
  const by = Object.fromEntries(list.map((c) => [c.id, c]))
  assert.equal(by.p.undoable, true)
  assert.match(by.p.what, /1 block removed/)
  assert.match(by.p.note, /new block ids/)
  assert.equal(by.p.changedAt, 50, 'Notion’s own edit time')
  assert.equal(by.q.undoable, false)
  assert.equal(by.r.kind, 'trashed')
  assert.equal(by.r.title, 'Old')
})

test('restoring to just before a change ignores older edits', () => {
  const entries = [
    { id: 'p', at: 1, in_trash: false, blocks: [para('draft'), para('keep')] },
    { id: 'p', at: 5, in_trash: false, blocks: [para('keep')] }, // the user removed "draft"
    { id: 'p', at: 9, in_trash: true, blocks: [para('keep')] }, // the agent trashed it
  ]
  const plan = restorePlan(fromBefore(entries, 9))
  assert.equal(plan[0].untrash, true)
  assert.equal(plan[0].restoreBlocks.length, 0, 'the user’s own earlier edit stays')
})

const env = () => ({ NOTION_USER: fakeNamespace(NotionUser), MAX_ACCOUNTS: '1' })

test('account routes refuse a request without the app token', async () => {
  const e = env()
  for (const [path, method] of [['/notion/restore', 'POST'], ['/app/changes', 'GET'], ['/app/status', 'GET'], ['/app/sync', 'POST'], ['/app/disconnect', 'POST']]) {
    const r = await worker.fetch(new Request(`https://w${path}`, { method, body: method === 'POST' ? JSON.stringify({ user: 'x' }) : undefined }), e)
    assert.equal(r.status, 401, path)
  }
})

test('connect checks the secret with Notion, keeps it in the Worker and hands back only an app token', async (t) => {
  const e = env()
  const secret = `ntn_${'Z9'.repeat(20)}`
  withFetch(t, (url, init) => {
    if (url.endsWith('/users/me')) {
      return init.headers.authorization === `Bearer ${secret}` ? { id: 'bot-1', type: 'bot', bot: { workspace_name: 'Priya’s space' } } : new Response('{}', { status: 401 })
    }
    if (url.endsWith('/search')) return { results: [] }
    return new Response('{}', { status: 500 })
  })
  const bad = await worker.fetch(new Request('https://w/notion/connect', { method: 'POST', body: JSON.stringify({ token: `ntn_${'X1'.repeat(20)}` }) }), e)
  assert.equal(bad.status, 400)
  const r = await worker.fetch(new Request('https://w/notion/connect', { method: 'POST', body: JSON.stringify({ token: secret }) }), e)
  const got = await r.json()
  assert.equal(r.status, 200)
  assert.match(got.token, /^mw1\./)
  assert.equal(got.workspace, 'Priya’s space')
  assert.equal(JSON.stringify(got).includes(secret), false, 'the Notion secret is not sent back')
  const status = await worker.fetch(new Request('https://w/app/status', { headers: { authorization: `Bearer ${got.token}` } }), e).then((x) => x.json())
  assert.equal(status.connected, true)
  assert.equal(JSON.stringify(status).includes(secret), false)
  assert.match(status.undoLag, /one to two minutes/)
})

test('a deploy polls at most MAX_ACCOUNTS workspaces', async (t) => {
  const e = env()
  let n = 0
  withFetch(t, (url) => (url.endsWith('/users/me') ? { id: `bot-${++n}`, type: 'bot', bot: {} } : { results: [] }))
  const connect = () => worker.fetch(new Request('https://w/notion/connect', { method: 'POST', body: JSON.stringify({ token: `ntn_${'Q7'.repeat(20)}` }) }), e)
  assert.equal((await connect()).status, 200)
  assert.equal((await connect()).status, 403)
})
