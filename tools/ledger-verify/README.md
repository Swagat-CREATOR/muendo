# mewndo-ledger-verify

Check a Mewndo Flight Recorder export **without trusting Mewndo** (spec §30.2, P7.2).

```bash
node verify.js <folder> [--key <hex device key>] [--json]
```

The folder holds `ledger.jsonl` — one record per line, as written by
`core/crates/mewndo-core/src/ledger.rs` — and optionally `roots.json`.

No dependencies, one file, short enough to read before you rely on it. That is the whole
point: a checker that shares code with the thing it checks proves nothing.

## What it checks

1. **Every record's hash**, recomputed as `sha256(seq as little-endian u64 ‖ prev ‖ 0x00 ‖ the event's JSON bytes)`.
2. **The chain**: each `prev` is the previous record's hash, `seq` starts at 0 and has no gap, and the first record's `prev` is `genesis`.
3. **Anchored Merkle roots**, if `roots.json` is present: `[{at, seq_from, seq_to, root}]`.
4. **The device signature**, only if you pass `--key`.

Exit code 0 only when every check it could run passed. Otherwise 1, naming the first
failing record.

```
OK: 3 records, chain intact, signature unchecked
note: no key given, so signatures were not checked
```

## What it cannot check, and why

- **The signature is symmetric.** `ledger.rs` signs with HMAC-SHA256 using a device key in
  Windows Credential Manager. Holding that key lets you verify a record and equally lets you
  forge one, so this tool can prove a chain is internally consistent but **not who wrote
  it**. Without the key it says "signature unchecked" rather than implying more. §30.2 wants
  a record anyone can check; that needs an asymmetric device key, which P7.2 has not swapped
  in. `ledger.rs` says the same thing in its own header.
- **Nothing anchors the roots yet.** The hourly Merkle root, the push to the Mewndo cloud and
  the public GitHub transparency log are the core's and the cloud's job and are **not
  built**. Until they are, a `roots.json` only proves the export is consistent with itself —
  it cannot show that history was not rewritten before the export was taken. That is the
  whole value of anchoring, and it is missing.
- **There is no exporter.** The core writes `ledger.jsonl` but has no "export" command, so
  today you point this at the data folder directly.
- **The Merkle rule is this tool's definition**, because nothing writes roots yet. It is
  RFC 6962 (Certificate Transparency): leaf = `sha256(0x00 ‖ d)`, node =
  `sha256(0x01 ‖ L ‖ R)`, split at the largest power of two below `n`, over the records' own
  32-byte hashes. The `0x00`/`0x01` prefixes stop a leaf being passed off as an internal
  node; the common promote-the-odd-leaf variant has a known second-preimage weakness, where
  two different leaf counts can give the same root. Whatever builds the roots must hash the
  same way.

## Why the event bytes are never re-encoded

The hash covers the event's JSON bytes. `serde_json` writes `1.0` where `JSON.stringify`
writes `1`, so re-serializing a parsed event would fail every record carrying a model
probability. `rawEvent()` slices the `"event":{…}` substring out of the line by matching
braces, respecting strings and escapes, and hashes exactly those bytes.

## The hole only anchoring can close

Dropping the **last** records leaves a perfectly intact chain: no `seq` gap, no broken
`prev` link. Chain verification alone exits 0 on a truncated ledger, and there is a test
asserting exactly that. Only a root covering the full range catches it — which is the whole
reason §30.2 anchors roots hourly, and the whole reason this tool's value is capped until
that anchoring is built.

## Tests

```bash
npm test     # 11 tests
```

They build a real ledger in a temp folder in the on-disk format, then check that a clean
export passes and that each of these is caught: a tampered event, a dropped event, a forged
signature, a wrong key, a missing first record, a wrong Merkle root, a truncated tail, a
ledger that is not JSON, and a missing file. Plus the command line's exit codes, the RFC 6962
hashing including its domain separation, and the verbatim event slice.
