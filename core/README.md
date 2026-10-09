# mewndo-core

The Rust background service for Mewndo version 1 (docs/spec.md sections 21 to 31). The desktop app starts it,
talks to it over a Windows named pipe (a Unix socket elsewhere), checks every 10 s that it answers, and restarts
it if it stops. It logs to `mewndo-core.log` in the app's log folder, rotated like the app's own log.

Content store (`src/store.rs`): a port of v0's, with the exact same files on disk, so either engine reads what
the other wrote (`apps/desktop/test/store-compat.test.js` checks both ways). Files are hashed and compressed on a
pool of 8 to 32 threads. Like v0, it keeps no metadata of its own: a batch's index or manifest is one JSON file
written whole (`write_file_atomic`).

Scanner (`src/scanner.rs`): v0's scanner, giving exactly v0's manifest (checked against v0 in
`apps/desktop/test/feed.test.js`), so an index either engine wrote works with the other. With a list of folders
it rescans only those: the reconciliation scan.

Change feed (`src/feed.rs`, Windows): ReadDirectoryChangesW reports changes as they happen; a delete goes out at
once (measured: well under a millisecond to the feed), new and edited files once they've been quiet for 300 ms.
The NTFS change journal (USN) catches up on what changed while Mewndo was closed, or in a burst too big for the
live feed, and the feed says which folders to rescan. Same ignore rules as v0; links and junctions are never
followed; folders are known by their long real path.

Restore (`src/restore.rs`, spec §28.6): the v0 engine plans a restore and writes its log as always; with a core
(`createJournal({ core })`) the core runs the steps and verifies. The restore ladder, per file: rename it back out
of Mewndo's trash when it's the version wanted (a rename undone, or undoing a restore); otherwise copy it from
the store with the OS (`CopyFile2` on Windows, which block clones on ReFS and Dev Drive), or unpack it when the
store keeps it gzipped. Every file is staged under a temp name next to where it goes, then all are renamed into
place; one flush at the end, then the app hears "restored" and verification (a fresh scan with full rehash) runs
and writes the result to the restore log. Kept from v0: the before-undo save point, trash instead of delete,
retries for locked files, crash recovery from the log. `apps/desktop/test/restore.test.js` runs every v0 restore
test on both engines.

Hot cache (`src/store.rs`, spec §25.2): new content up to 1 MB that the store gzips is also kept uncompressed in
`<store>/hot/` for 24 hours (both engines write it; the app's daily cleanup removes older copies). Restores copy
from it first and check the copy's hash. It's only a copy and isn't counted in the storage budget. Why: see
`docs/benchmarks.md` (Defender unpacks gzip files to scan them).

Slow requests (storing, scanning, process control, restores) run alongside the rest on a connection, so the app's
health check is never stuck behind a long scan; their replies can come after later requests' replies.

Engine choice (P1.7): the app's Settings have "Restore engine": Rust core (default), Shadow (v0 restores; both
engines scan every protected folder each hour and differences are logged) or v0. The engine process connects to
the core itself (`apps/desktop/engine/core-client.js`, address in `MEWNDO_CORE_PIPE`). `npm run test:rust` runs
every v0 test and the reliability suite with restores going through the core.

Process control (`src/process.rs`, Windows, for Brake in spec §24.3): `process_freeze`, `process_resume` and
`process_end` act on a process and all its descendants. Freeze uses `NtSuspendProcess` and re-reads the tree
until no new child turns up; resume thaws every thread fully, so a tree frozen twice comes back with one resume;
end freezes, then terminates. It refuses system processes (pids 0 and 4, session 0 services, critical processes,
the Windows shell and its helpers) and Mewndo itself (the core, everything it runs under, and every process
running the app's program), and says why.

What it can't do yet:
- Restores run in the core by default; scanning, watching and storing still run in the v0 Node engine. The core's
  scanner and change feed are tested against v0 (and compared hourly in shadow mode) but not used by the app yet.
- Restore: no hard links from the store (the spec's rung 3; it needs copy-on-first-write watching). A file is
  renamed back out of the trash when its size and modified time match the version wanted, the rule the scanner
  uses everywhere; verification then checks its content. Files are staged next to where they go, not in a
  separate staging folder, so they get that folder's permissions (a file staged elsewhere and renamed in keeps
  the permissions of where it was made). On Windows the one flush at the end is a flush of each written file, in
  parallel (flushing a whole drive needs admin rights). The user still waits for verification in the v0 app
  flow; the "restored" moment is sent as progress.
- The change journal is read without admin rights, which gives no file names, only which folders changed; a
  reconciliation scan of those folders finds the rest. Drives without a journal (FAT, exFAT, network folders), a
  journal that was reset or has moved past the saved position, and more than 2,000 changed folders all mean
  rescanning everything.
- The change feed and process control run on Windows only (Mewndo v1 is a Windows app).
- Process control: a write already in progress finishes before a freeze takes hold. A process that's elevated
  or another user's can't be frozen by a core that isn't; it's listed as skipped. A frozen process stays frozen
  if Mewndo closes; resuming it later still works, from any run of the core.
- Speed on Windows with Defender on is bound by Defender's scanning: 5,000 small files restore in about 16 s
  (v0: about 55 s), not the 5 s target. See `docs/benchmarks.md` for the measurements and what would close the gap.

On Windows every file path goes through `src/paths.rs` (the `\\?\` form, as Node uses), so names Windows
would otherwise change, such as `notes.` or `draft ` (trailing dot or space), and paths over 260 characters are
stored and restored exactly.

Protocol: one JSON object per line, each with the protocol version `v` and a request `id`. See `src/protocol.rs`.

With `--desk <folder>` the core also serves the Agent Desk pipe, protocol v2 (spec §33.10 Part A): framed messages
from `crates/mewndo-proto`, `core.json` and `desk.db` in that folder, one core per folder. See
`crates/mewndo-core/src/desk.rs` and `docs/decisions.md`.

```
npm start    # from the repository root: builds the core, then starts the app
npm test     # from the repository root: core tests, then the app's
```

## Testing on Windows

Every push runs the tests on a real Windows machine (`.github/workflows/ci.yml`). From WSL on a Windows PC, the
same tests run on Windows itself, on NTFS:

```
npm run test:windows                                 # core tests, then the app's, with Windows Rust and Node
scripts/windows.sh node apps/desktop/scripts/reliability.js
```

Setup, once (no admin; about 1 GB on C:):

1. Rust for Windows with the GNU toolchain, which needs no Visual Studio: download
   `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe` and run
   `rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal --no-modify-path`.
2. GNU `as.exe` and `dlltool.exe` in `%USERPROFILE%\.mewndo-dev\binutils`, with the DLLs they need
   (MSYS2 packages `mingw-w64-x86_64-binutils`, `gettext-runtime`, `libiconv`, `libwinpthread`, `zlib`, `zstd`).
   Rust's GNU toolchain ships `dlltool` but no assembler, and the `windows-sys` crate needs both.
3. Node.js for Windows in `C:\Program Files\nodejs`.

Build output goes to `%USERPROFILE%\.mewndo-dev\target`, not the repository.
