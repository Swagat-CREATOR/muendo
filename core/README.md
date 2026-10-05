# mewndo-core

The Rust background service for Mewndo version 1 (docs/spec.md sections 21 to 31). The desktop app starts it,
talks to it over a Windows named pipe (a Unix socket elsewhere), checks every 10 s that it answers, and restarts
it if it stops. It logs to `mewndo-core.log` in the app's log folder, rotated like the app's own log.

What it can't do yet: any file work. Protection still runs in the v0 Node engine (`apps/desktop/engine`), which
stays the reference until this core passes every v0 test.

Protocol: one JSON object per line, each with the protocol version `v` and a request `id`. See `src/protocol.rs`.

```
npm start    # from the repository root: builds the core, then starts the app
npm test     # from the repository root: core tests, then the app's
```
