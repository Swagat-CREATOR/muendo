# mewndo-core

The Rust background service for Mewndo version 1 (docs/spec.md sections 21 to 31). The desktop app starts it,
talks to it over a Windows named pipe (a Unix socket elsewhere), checks every 10 s that it answers, and restarts
it if it stops. It logs to `mewndo-core.log` in the app's log folder, rotated like the app's own log.

Content store (`src/store.rs`): a port of v0's, with the exact same files on disk, so either engine reads what
the other wrote (`apps/desktop/test/store-compat.test.js` checks both ways). Files are hashed and compressed on a
pool of 8 to 32 threads. Like v0, it keeps no metadata of its own: a batch's index or manifest is one JSON file
written whole (`write_file_atomic`).

What it can't do yet: the app doesn't use it. Protection, scanning and restores still run in the v0 Node engine
(`apps/desktop/engine`), which stays the reference until this core passes every v0 test. The core's store has
not been measured against v0's speed yet (P1.6 benchmarks), and its Windows code is type-checked here but runs
only in the Windows CI that comes later.

Protocol: one JSON object per line, each with the protocol version `v` and a request `id`. See `src/protocol.rs`.

```
npm start    # from the repository root: builds the core, then starts the app
npm test     # from the repository root: core tests, then the app's
```
