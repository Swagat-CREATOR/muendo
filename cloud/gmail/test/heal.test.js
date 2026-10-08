import { test } from 'node:test'
import assert from 'node:assert'
import { healPlan } from '../src/heal.js'

test('untrash restores a message trashed out of scope', () => {
  const entries = [
    { id: 'm1', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm1', labelIds: ['TRASH'], trashed: true, gone: false, at: 2 },
  ]
  const p = healPlan(entries)
  assert.deepEqual(p.untrash, ['m1'])
  assert.deepEqual(p.gone, [])
})

test('label changes become one batch per distinct (add,remove)', () => {
  const entries = [
    // m1 lost INBOX, gained SPAM; m2 lost INBOX, gained SPAM (same change -> one batch)
    { id: 'm1', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm1', labelIds: ['SPAM'], trashed: false, gone: false, at: 2 },
    { id: 'm2', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm2', labelIds: ['SPAM'], trashed: false, gone: false, at: 2 },
    // m3 only lost a custom label (different change -> its own batch)
    { id: 'm3', labelIds: ['INBOX', 'Label_9'], trashed: false, gone: false, at: 1 },
    { id: 'm3', labelIds: ['INBOX'], trashed: false, gone: false, at: 2 },
  ]
  const p = healPlan(entries)
  const keys = Object.keys(p.relabel)
  assert.equal(keys.length, 2, 'two distinct label changes')
  const m1m2 = p.relabel[JSON.stringify({ add: ['INBOX'], remove: ['SPAM'] })]
  assert.deepEqual(m1m2.sort(), ['m1', 'm2'])
  const m3 = p.relabel[JSON.stringify({ add: ['Label_9'], remove: [] })]
  assert.deepEqual(m3, ['m3'])
})

test('a permanently deleted message is reported as gone, not restored', () => {
  const entries = [
    { id: 'm1', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm1', labelIds: [], trashed: false, gone: true, at: 2 },
  ]
  const p = healPlan(entries)
  assert.deepEqual(p.gone, ['m1'])
  assert.deepEqual(p.untrash, [])
  assert.equal(Object.keys(p.relabel).length, 0)
})

test('onlyIds restricts the plan', () => {
  const entries = [
    { id: 'm1', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm1', labelIds: ['TRASH'], trashed: true, gone: false, at: 2 },
    { id: 'm2', labelIds: ['INBOX'], trashed: false, gone: false, at: 1 },
    { id: 'm2', labelIds: ['TRASH'], trashed: true, gone: false, at: 2 },
  ]
  const p = healPlan(entries, ['m1'])
  assert.deepEqual(p.untrash, ['m1'])
})
