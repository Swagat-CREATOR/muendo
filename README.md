# Mewndo

Undo what AI agents did to your files. Mewndo protects folders on your Windows PC, keeps every version of
every file, and restores a whole folder or just some files to an earlier save point.

Everything stays on your computer: the app and the v0 engine make no outbound network calls, only a
localhost-only hook server, and the core calls a decision service only if `MEWNDO_DECIDE_URL` is set, which it
isn't by default. See [What Mewndo can and can't undo](docs/what-mewndo-can-and-cant-undo.md).

## What works today

Local files on a Windows PC, through the v0 Node engine with restores carried out by the Rust core: protected
folders, save points (manual, when an agent starts, every 10 minutes while one runs and files changed, and before
each Claude Code command when its hooks are set up), full file history, restoring a folder or chosen files,
undoing a restore, Mewndo's trash, and the Guard and Brake for Claude Code, Codex and Cursor.

Nothing else is connected. The Gmail, Drive and Notion workers, the hosted MCP and the decision gateway are in
`cloud/` with local tests, but nothing there has been deployed as far as this repository shows, so Mewndo can't
undo anything in email, Drive, Notion or OneDrive today, and it doesn't check any email an agent sends. The Agent
Inbox, Clef Router, Receipts, guarded computer use and Show Me (spec §32 to §38) aren't built. Builds are
unsigned: there's no code-signing certificate yet, so there are no signed auto-updates either.

## How fast

Measured on one PC on 6 October 2026 (Intel Core i5-8265U, 8 GB RAM, NTFS, Defender on, unsigned build, no Dev
Drive): restoring 5,000 small files took 28.65 s with the Rust core and 61.13 s with the v0 engine, against a 5 s
target — missed, with Windows Defender's scanning the limit. The 1 GB cases didn't run: that PC had 3.5 GB free
and the case needs 5 GB. `mewndo-core` idle used 4.9 MB and 0.05 % CPU, against a 30 MB target — met. Full table
and method: [docs/benchmarks.md](docs/benchmarks.md).

Decision-service latency has never been measured ([docs/latency.md](docs/latency.md) is empty because no Worker is
deployed), so every figure in spec §38.7 is a target, not measured.

## Development

```
npm install
npm test     # Rust core tests, then the desktop and v0 engine tests, then the cloud Worker tests
npm start    # builds the core, then starts the Electron app
```

Tests only ever use temporary folders. Rules every change follows: [plot.md](plot.md). Pinned versions:
[docs/versions.md](docs/versions.md). Problems found but not fixed: [docs/known-issues.md](docs/known-issues.md).
