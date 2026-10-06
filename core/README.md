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
not been measured against v0's speed yet (P1.6 benchmarks).

On Windows every file path goes through `src/paths.rs` (the `\\?\` form, as Node uses), so names Windows
would otherwise change, such as `notes.` or `draft ` (trailing dot or space), and paths over 260 characters are
stored and restored exactly.

Protocol: one JSON object per line, each with the protocol version `v` and a request `id`. See `src/protocol.rs`.

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
