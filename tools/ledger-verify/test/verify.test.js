import { test } from 'node:test'
import assert from 'node:assert'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { verify, merkleRoot, linkHash, rawEvent } from '../verify.js'

const KEY = Buffer.from('a'.repeat(64), 'hex')
const HERE = dirname(fileURLToPath(import.meta.url))

// Build a ledger the way core/crates/mewndo-core/src/ledger.rs does, so the verifier is
// tested against the real format and not against its own idea of it. Field order matches
// the Event struct, and model_probabilities is included because that is where serde_json
// and JSON.stringify disagree about floats.
function event(i, over = {}) {
  return {
    time_ms: 1_791_500_000_000 + i * 1000,
    kind: 'guard',
    agent: 'claude-code',
    vendor: 'anthropic',
    principal: 'priya',
    brief_hash: 'b'.repeat(64),
    action: { tool: 'Bash', command: `rm -rf db/migrations-${i}` },
    target: `C:/work/shop/db/migrations-${i}`,
    decision: 'deny',
    model_probabilities: { in_scope: 0.03, irreversible: 0.95 },
    ...over,
  }
}

function writeLedger(folder, events, { key = KEY, roots = null } = {}) {
  const lines = []
  const hashes = []
  let prev = 'genesis'
  events.forEach((ev, seq) => {
    // The line is built first so the hash is over exactly the bytes on disk.
    const eventJson = JSON.stringify(ev)
    const hash = linkHash(seq, prev, Buffer.from(eventJson, 'utf8'))
    const sig = createHmac('sha256', key).update(Buffer.from(hash, 'utf8')).digest('hex')
    lines.push(`{"seq":${seq},"prev":${JSON.stringify(prev)},"event":${eventJson},"hash":"${hash}","sig":"${sig}"}`)
    hashes.push(hash)
    prev = hash
  })
  writeFileSync(join(folder, 'ledger.jsonl'), lines.join('\n') + '\n')
  if (roots) writeFileSync(join(folder, 'roots.json'), JSON.stringify(roots))
  return { lines, hashes }
}

const folder = () => mkdtempSync(join(tmpdir(), 'mewndo-ledger-'))

test('a clean export verifies, and the signature is only claimed when it was checked', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLedger(dir, [event(0), event(1), event(2)])

  const noKey = verify(dir)
  assert.equal(noKey.ok, true, JSON.stringify(noKey.problems))
  assert.equal(noKey.records, 3)
  assert.equal(noKey.signatures_checked, 0)
  assert.match(noKey.signature_note, /not checked/)

  const withKey = verify(dir, { key: KEY })
  assert.equal(withKey.ok, true)
  assert.equal(withKey.signatures_checked, 3)
  // The honest part: an HMAC proves possession of the key, not authorship.
  assert.match(withKey.signature_note, /possession of the same device key, not who wrote/)
})

test('a tampered event is detected', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { lines } = writeLedger(dir, [event(0), event(1), event(2)])
  // Change what the agent did, keeping the stored hash: exactly what a cover-up looks like.
  lines[1] = lines[1].replace('"decision":"deny"', '"decision":"allow"')
  writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n')

  const out = verify(dir, { key: KEY })
  assert.equal(out.ok, false)
  assert.equal(out.problems[0].seq, 1)
  assert.match(out.problems[0].problem, /do not match the stored hash/)
})

test('a dropped event is detected', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { lines } = writeLedger(dir, [event(0), event(1), event(2)])
  lines.splice(1, 1) // remove the middle record
  writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n')

  const out = verify(dir)
  assert.equal(out.ok, false)
  const reasons = out.problems.map((p) => p.problem).join(' ')
  assert.match(reasons, /dropped, reordered or rewritten/)
  assert.match(reasons, /seq jumps from 0 to 2/)
})

test('a forged signature is detected, and a wrong key fails every record', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeLedger(dir, [event(0), event(1)], { key: Buffer.from('c'.repeat(64), 'hex') })
  const out = verify(dir, { key: KEY })
  assert.equal(out.ok, false)
  assert.equal(out.problems.length, 2)
  assert.ok(out.problems.every((p) => p.problem === 'bad signature'))
  // Without the key the chain still verifies: the records are internally consistent.
  assert.equal(verify(dir).ok, true)
})

test('a broken first record is detected', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { lines } = writeLedger(dir, [event(0), event(1)])
  writeFileSync(join(dir, 'ledger.jsonl'), lines.slice(1).join('\n') + '\n')
  const out = verify(dir)
  assert.equal(out.ok, false)
  const reasons = out.problems.map((p) => p.problem).join(' ')
  assert.match(reasons, /prev is not "genesis"/)
  assert.match(reasons, /seq is 1, not 0/)
})

test('an anchored Merkle root is checked, and a wrong one is caught', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const events = [event(0), event(1), event(2), event(3), event(4)]
  const { hashes } = writeLedger(dir, events)
  const root = merkleRoot(hashes)

  writeFileSync(join(dir, 'roots.json'), JSON.stringify([{ at: 1, seq_from: 0, seq_to: 4, root }]))
  const good = verify(dir)
  assert.equal(good.ok, true, JSON.stringify(good.problems))
  assert.equal(good.roots_checked, 1)

  writeFileSync(join(dir, 'roots.json'), JSON.stringify([{ at: 1, seq_from: 0, seq_to: 4, root: 'd'.repeat(64) }]))
  const bad = verify(dir)
  assert.equal(bad.ok, false)
  assert.match(bad.problems[0].problem, /Merkle root for 0..4 does not match/)
})

test('an odd number of leaves promotes the last one, and one leaf is its own root', () => {
  const h = (s) => createHash('sha256').update(s).digest('hex')
  const [a, b, c] = [h('a'), h('b'), h('c')]
  assert.equal(merkleRoot([a]), a)
  const ab = createHash('sha256').update(Buffer.from(a, 'hex')).update(Buffer.from(b, 'hex')).digest()
  assert.equal(merkleRoot([a, b]), ab.toString('hex'))
  const expected = createHash('sha256').update(ab).update(Buffer.from(c, 'hex')).digest('hex')
  assert.equal(merkleRoot([a, b, c]), expected)
  assert.equal(merkleRoot([]), null)
})

test('the event bytes are read from the line, never re-encoded', () => {
  // serde_json writes 1.0 where JSON.stringify writes 1, so re-encoding would break
  // every record carrying a model probability. The slice must come back verbatim.
  const line = '{"seq":0,"prev":"genesis","event":{"p":1.0,"s":"} not the end {","n":null},"hash":"x","sig":"y"}'
  assert.equal(rawEvent(line).toString(), '{"p":1.0,"s":"} not the end {","n":null}')
  assert.equal(rawEvent('{"seq":0}'), null)
})

test('a missing or unreadable ledger fails loudly instead of passing', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const empty = verify(dir)
  assert.equal(empty.ok, false)
  assert.match(empty.problems[0].problem, /no ledger.jsonl/)

  writeFileSync(join(dir, 'ledger.jsonl'), 'not json at all\n')
  const garbage = verify(dir)
  assert.equal(garbage.ok, false)
  assert.equal(garbage.problems[0].problem, 'not JSON')
})

test('the command line exits 0 only when every check it can do passes', (t) => {
  const dir = folder()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { lines } = writeLedger(dir, [event(0), event(1)])
  const script = join(HERE, '..', 'verify.js')

  const ok = execFileSync(process.execPath, [script, dir], { encoding: 'utf8' })
  assert.match(ok, /^OK: 2 records, chain intact, signature unchecked/m)

  lines[1] = lines[1].replace('"kind":"guard"', '"kind":"heal"')
  writeFileSync(join(dir, 'ledger.jsonl'), lines.join('\n') + '\n')
  assert.throws(
    () => execFileSync(process.execPath, [script, dir], { encoding: 'utf8', stdio: 'pipe' }),
    (e) => e.status === 1 && /record 1: contents do not match/.test(String(e.stderr)),
  )
})
