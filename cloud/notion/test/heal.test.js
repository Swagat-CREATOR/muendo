import { test } from 'node:test'
import assert from 'node:assert'
import { restorePlan, RateLimiter, UNDO_LAG_NOTE } from '../src/heal.js'

const para = (text) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] } })

test('a trashed page is untrashed', () => {
  const plan = restorePlan([
    { id: 'p1', at: 1, in_trash: false, blocks: [para('hello')] },
    { id: 'p1', at: 2, in_trash: true, blocks: [para('hello')] },
  ])
  assert.equal(plan.length, 1)
  assert.equal(plan[0].untrash, true)
  assert.equal(plan[0].restoreBlocks.length, 0)
})

test('deleted blocks come back from the snapshot', () => {
  const plan = restorePlan([
    { id: 'p2', at: 1, in_trash: false, blocks: [para('keep'), para('deleted')] },
    { id: 'p2', at: 2, in_trash: false, blocks: [para('keep')] },
  ])
  assert.equal(plan.length, 1)
  assert.equal(plan[0].untrash, false)
  assert.equal(plan[0].restoreBlocks.length, 1)
  assert.equal(plan[0].restoreBlocks[0].paragraph.rich_text[0].plain_text, 'deleted')
})

test('an unchanged page needs no action', () => {
  const plan = restorePlan([
    { id: 'p3', at: 1, in_trash: false, blocks: [para('same')] },
    { id: 'p3', at: 2, in_trash: false, blocks: [para('same')] },
  ])
  assert.equal(plan.length, 0)
})

test('onlyIds restricts the plan', () => {
  const entries = [
    { id: 'p4', at: 1, in_trash: false, blocks: [] },
    { id: 'p4', at: 2, in_trash: true, blocks: [] },
    { id: 'p5', at: 1, in_trash: false, blocks: [] },
    { id: 'p5', at: 2, in_trash: true, blocks: [] },
  ]
  assert.equal(restorePlan(entries).length, 2)
  const only = restorePlan(entries, ['p4'])
  assert.equal(only.length, 1)
  assert.equal(only[0].id, 'p4')
})

test('the rate limiter spaces calls to about 3 per second', async () => {
  const l = new RateLimiter(3)
  const t0 = Date.now()
  await l.wait()
  await l.wait()
  await l.wait()
  const took = Date.now() - t0
  // Three calls => two gaps of ~333 ms.
  assert.ok(took >= 600, `three calls took ${took} ms, expected >= 600`)
})

test('the honest Notion lag note says one to two minutes', () => {
  assert.match(UNDO_LAG_NOTE, /one to two minutes/)
  assert.match(UNDO_LAG_NOTE, /MCP/)
})
