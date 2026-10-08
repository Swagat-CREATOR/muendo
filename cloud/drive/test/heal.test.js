import { test } from 'node:test'
import assert from 'node:assert'
import { healPlan, r2Budget, FREE_R2_BYTES } from '../src/heal.js'

test('a trashed file is untrashed and put back in its original folder', () => {
  const p = healPlan([
    { id: 'f1', at: 1, gone: false, trashed: false, parents: ['folderA'], name: 'a.txt' },
    { id: 'f1', at: 2, gone: false, trashed: true, parents: ['folderA'], name: 'a.txt' },
  ])
  assert.equal(p.untrash.length, 1)
  assert.equal(p.untrash[0].id, 'f1')
  assert.deepEqual(p.gone, [])
})

test('a file moved to another folder goes back to the original parent', () => {
  const p = healPlan([
    { id: 'f2', at: 1, gone: false, trashed: false, parents: ['folderA'], name: 'b.txt' },
    { id: 'f2', at: 2, gone: false, trashed: false, parents: ['folderB'], name: 'b.txt' },
  ])
  assert.equal(p.untrash.length, 1)
  assert.deepEqual(p.untrash[0].addParents, ['folderA'])
  assert.deepEqual(p.untrash[0].removeParents, ['folderB'])
})

test('a permanently deleted file is reported with the data needed to re-upload', () => {
  const p = healPlan([
    { id: 'f3', at: 1, gone: false, trashed: false, parents: ['folderA'], name: 'c.txt', revision: 'r1' },
    { id: 'f3', at: 2, gone: true, trashed: false, parents: [], name: undefined },
  ])
  assert.equal(p.untrash.length, 0)
  assert.deepEqual(p.gone, [{ id: 'f3', name: 'c.txt', parents: ['folderA'], revision: 'r1' }])
})

test('an untouched file needs no action', () => {
  const p = healPlan([
    { id: 'f4', at: 1, gone: false, trashed: false, parents: ['folderA'], name: 'd.txt' },
    { id: 'f4', at: 2, gone: false, trashed: false, parents: ['folderA'], name: 'd.txt' },
  ])
  assert.equal(p.untrash.length, 0)
  assert.equal(p.gone.length, 0)
})

test('R2 budget warns near the free limit and refuses past it', () => {
  assert.deepEqual(r2Budget(0, 1024), { allowed: true, warning: null })
  const near = r2Budget(FREE_R2_BYTES * 0.85, 1024)
  assert.equal(near.allowed, true)
  assert.match(near.warning, /free copy space/)
  const over = r2Budget(FREE_R2_BYTES - 10, 1000)
  assert.equal(over.allowed, false, 'must not silently exceed the free tier')
  assert.match(over.warning, /10 GB/)
})
