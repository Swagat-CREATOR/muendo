#!/usr/bin/env node
'use strict'
// mewndo-ledger-verify: check a Mewndo Flight Recorder export without trusting Mewndo.
//
//   node verify.js <folder> [--key <hex device key>] [--json]
//
// The folder holds `ledger.jsonl` (one record per line, as written by
// core/crates/mewndo-core/src/ledger.rs) and optionally `roots.json`.
//
// Spec §30.2 asks for a record anyone can check. That is only worth anything if the
// checker is separate from the thing it checks, so this has no dependencies, reads
// nothing but the folder you point it at, and is short enough to read in one sitting.
//
// What it checks:
//   1. every record's hash, recomputed from the bytes on the line;
//   2. the chain: each `prev` is the previous record's hash, and `seq` has no gap;
//   3. the Merkle root of each range in roots.json, if there is one;
//   4. the device signature, if you pass the key.
//
// What it CANNOT check, and says so rather than implying otherwise: the signature is
// an HMAC, so it is symmetric. Holding the key lets you verify a record and equally
// lets you forge one. Without an asymmetric device key this tool can prove the chain
// is internally consistent, not who wrote it. ledger.rs says the same thing.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GENESIS = 'genesis'

// The chain link, exactly as ledger.rs builds it:
//   sha256( seq as little-endian u64 || prev as utf-8 || 0x00 || the event's JSON bytes )
//
// The event bytes are taken verbatim from the line, never re-encoded. serde_json and
// JSON.stringify disagree about floats (serde writes 1.0 where JSON.stringify writes 1)
// and would silently fail every record carrying a model probability.
function linkHash(seq, prev, eventBytes) {
  const seqLe = Buffer.alloc(8)
  seqLe.writeBigUInt64LE(BigInt(seq))
  return createHash('sha256')
    .update(seqLe)
    .update(Buffer.from(prev, 'utf8'))
    .update(Buffer.from([0]))
    .update(eventBytes)
    .digest('hex')
}

// The raw `"event":{...}` bytes out of one line, by matching braces while respecting
// strings and escapes. Returns null if the line has no event object.
function rawEvent(line) {
  const at = line.indexOf('"event":')
  if (at === -1) return null
  let i = at + '"event":'.length
  while (i < line.length && line[i] === ' ') i++
  if (line[i] !== '{') return null
  const start = i
  let depth = 0
  let inString = false
  let escaped = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return Buffer.from(line.slice(start, i + 1), 'utf8')
  }
  return null
}

// Leaves are the records' own 32-byte hashes; a parent is sha256(left || right); an odd
// node at the end is promoted unchanged. This is the verifier's definition, because the
// core does not write roots yet (P7.2); whatever builds them must match it.
function merkleRoot(hashesHex) {
  if (hashesHex.length === 0) return null
  let level = hashesHex.map((h) => Buffer.from(h, 'hex'))
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length
        ? createHash('sha256').update(level[i]).update(level[i + 1]).digest()
        : level[i])
    }
    level = next
  }
  return level[0].toString('hex')
}

function verify(folder, { key = null } = {}) {
  const path = join(folder, 'ledger.jsonl')
  if (!existsSync(path)) return fail(`no ledger.jsonl in ${folder}`)

  const lines = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  const problems = []
  const hashes = []
  let checkedSignatures = 0
  let previous = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let record
    try {
      record = JSON.parse(line)
    } catch {
      problems.push({ index: i, seq: null, problem: 'not JSON' })
      break // the chain cannot be followed past a line that will not parse
    }
    const where = { index: i, seq: record.seq }

    const eventBytes = rawEvent(line)
    if (!eventBytes) {
      problems.push({ ...where, problem: 'no event object on the line' })
      continue
    }
    if (typeof record.seq !== 'number' || typeof record.prev !== 'string' || typeof record.hash !== 'string') {
      problems.push({ ...where, problem: 'missing seq, prev or hash' })
      continue
    }

    // 1. the record's own hash
    const recomputed = linkHash(record.seq, record.prev, eventBytes)
    if (recomputed !== record.hash) {
      problems.push({ ...where, problem: 'contents do not match the stored hash (tampered event)' })
    }

    // 2. the chain
    if (previous === null) {
      if (record.prev !== GENESIS) problems.push({ ...where, problem: `first record's prev is not "${GENESIS}"` })
      if (record.seq !== 0) problems.push({ ...where, problem: `first record's seq is ${record.seq}, not 0` })
    } else {
      if (record.prev !== previous.hash) {
        problems.push({ ...where, problem: `prev does not point at record ${previous.seq} (an event was dropped, reordered or rewritten)` })
      }
      if (record.seq !== previous.seq + 1) {
        problems.push({ ...where, problem: `seq jumps from ${previous.seq} to ${record.seq} (an event was dropped)` })
      }
    }

    // 4. the signature, only if a key was supplied
    if (key) {
      const expected = createHmac('sha256', key).update(Buffer.from(record.hash, 'utf8')).digest()
      const given = Buffer.from(String(record.sig ?? ''), 'hex')
      const ok = given.length === expected.length && timingSafeEqual(given, expected)
      if (!ok) problems.push({ ...where, problem: 'bad signature' })
      else checkedSignatures++
    }

    hashes.push(record.hash)
    previous = record
  }

  // 3. anchored Merkle roots
  const rootsPath = join(folder, 'roots.json')
  const rootResults = []
  if (existsSync(rootsPath)) {
    let roots
    try {
      roots = JSON.parse(readFileSync(rootsPath, 'utf8'))
    } catch {
      problems.push({ index: null, seq: null, problem: 'roots.json is not JSON' })
      roots = []
    }
    for (const entry of Array.isArray(roots) ? roots : roots.roots ?? []) {
      const from = Number(entry.seq_from ?? 0)
      const to = Number(entry.seq_to ?? hashes.length - 1)
      const slice = hashes.slice(from, to + 1)
      const got = merkleRoot(slice)
      const ok = got === entry.root
      rootResults.push({ seq_from: from, seq_to: to, expected: entry.root, got, ok })
      if (!ok) {
        problems.push({ index: null, seq: from, problem: `the Merkle root for ${from}..${to} does not match the anchored one` })
      }
    }
  }

  return {
    ok: problems.length === 0,
    records: lines.length,
    chain_checked: true,
    signatures_checked: key ? checkedSignatures : 0,
    signature_note: key
      ? 'HMAC verified: this proves possession of the same device key, not who wrote the record'
      : 'no key given, so signatures were not checked',
    roots_checked: rootResults.length,
    roots: rootResults,
    problems,
  }
}

function fail(message) {
  return { ok: false, records: 0, problems: [{ index: null, seq: null, problem: message }] }
}

function main(argv) {
  const args = argv.slice(2)
  const folder = args.find((a) => !a.startsWith('--'))
  const keyIndex = args.indexOf('--key')
  const keyHex = keyIndex === -1 ? null : args[keyIndex + 1]
  if (!folder) {
    console.error('usage: node verify.js <folder> [--key <hex device key>] [--json]')
    return 2
  }
  const result = verify(folder, { key: keyHex ? Buffer.from(keyHex, 'hex') : null })

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.ok) {
    const parts = [`${result.records} records`, 'chain intact']
    parts.push(result.signatures_checked ? `${result.signatures_checked} signatures verified` : 'signature unchecked')
    if (result.roots_checked) parts.push(`${result.roots_checked} Merkle roots match`)
    console.log(`OK: ${parts.join(', ')}`)
    if (result.signature_note) console.log(`note: ${result.signature_note}`)
  } else {
    console.error(`FAILED: ${result.problems.length} problem(s) in ${result.records} records`)
    for (const p of result.problems) {
      console.error(`  ${p.seq === null ? '' : `record ${p.seq}: `}${p.problem}`)
    }
  }
  return result.ok ? 0 : 1
}

export { verify, linkHash, merkleRoot, rawEvent, GENESIS }

// fileURLToPath, not a string compare: this repo's own path has a space in it, which
// import.meta.url percent-encodes.
if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  process.exit(main(process.argv))
}
