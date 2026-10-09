# Decisions

Choices the spec left open or contradicted, and the verify-first items of §32.5 rule 3 once checked. Newest last.

## Pipe protocol v2: frame format (9 Oct 2026)

§33.10 Part A step 2 says a frame is a 1-byte frame type, a 4-byte little-endian length, then the payload. §38.5
says a 4-byte length followed by JSON. **Chosen: §33.10's format**: lanes (§33.10 Part G) send raw terminal bytes
as frame type 1, which a JSON-only frame can't carry. Maximum payload 8 MB. A lane payload is a 1-byte lane id
length, the lane id, then the bytes. Code: `core/crates/mewndo-proto`.

## Pipe protocol v2: pipe name (9 Oct 2026)

§33.10 Part A step 4 says `\\.\pipe\mewndo-core-<8 random hex>`; §38.2 says `\\.\pipe\mewndo-core-<user SID>`.
**Chosen: random**, published in `core.json`. A name anyone can work out lets another process create the pipe
first and receive the hooks' traffic; `first_pipe_instance` and the current-user-only DACL
(`D:P(A;;GA;;;<SID>)`, checked on Windows: one ACE, this user, full control) close the rest.

## Pipe protocol v2 runs alongside v1 (9 Oct 2026)

The app and the v0 engine speak protocol v1 (JSON lines, `core/crates/mewndo-core/src/protocol.rs`) to the core
today, and §32.5 rule 6 keeps the v0 engine as is. So v2 is a second pipe in the same core, started only with
`mewndo-core --desk <folder>`; v1 is unchanged. Without `--desk` (every existing test, and the app until §33.10
Part E connects to v2) nothing changes and no single-instance lock is taken.

## desk.db location (9 Oct 2026)

§38.6 puts `desk.db` in `%APPDATA%\Mewndo` (Roaming); §33.10 A5 puts `core.json` in `%LOCALAPPDATA%\Mewndo`.
**Chosen: both in the `--desk` folder, normally `%LOCALAPPDATA%\Mewndo`.** A roaming profile copies Roaming at
sign-out, which is the wrong place for a live SQLite WAL database, and one folder keeps one core per folder simple.

## desk.db on the windows-gnu dev box (8 Oct 2026)

Real SQLite (`rusqlite`, bundled) is a C build. Linux and Windows-MSVC (CI) build it; the windows-gnu dev box has
no C compiler, so there `writer.rs` is a sink that stores nothing and says so in the log. Every desk.db test runs
on Linux and in CI.

## Single instance (9 Oct 2026)

One core per desk folder: the named mutex `Local\MewndoCore` for `%LOCALAPPDATA%\Mewndo` (§33.10 A3), and
`Local\MewndoCore-<hash of the folder>` for any other folder, so tests and a second desk folder don't collide.
`flock` on `core.lock` elsewhere. A second core exits with code 3 before it prints `ready`.
