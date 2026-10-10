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
unsigned and there are no auto-updates: see [Installing and updates](#installing-and-updates).

## Installing and updates

`npm run dist` from the repository root builds `mewndo-core.exe` and `mewndo-hook.exe` in release, copies the
forwarder into the Claude Code plugin, and then runs `electron-builder` to make one Windows installer that
carries all of it:

| What | Where it lands |
|---|---|
| The Electron app | `%LOCALAPPDATA%\Programs\Mewndo\Mewndo.exe` |
| `mewndo-core.exe`, the always-on service | `…\Mewndo\resources\` |
| `mewndo-hook.exe`, the hook forwarder | `…\Mewndo\resources\`, and again inside the plugin folder |
| The Claude Code plugin | `…\Mewndo\resources\claude-code\` |

It's a per-user install, so there's no UAC prompt and no Windows service. **Starting the core at login** means
the installer adds one `HKCU\…\CurrentVersion\Run` entry that starts `Mewndo.exe --hidden`, and the app starts
the core as a child process. So the core is as alive as the app: if the app is killed, the core stops with it
and nothing restarts it until the next sign-in. The Settings toggle owns that entry afterwards, and an update
never turns it back on if you turned it off.

`node apps/desktop/build/stage-binaries.js --check` verifies the whole packaging config — the binaries, the
plugin, the icon, the installer script — without building anything.

### Builds are unsigned

There's no code-signing certificate, so nothing Mewndo ships is signed, and **signed auto-updates don't exist**:
no update feed is configured, and a new version means downloading and running the installer again. Three things
that costs you:

- **SmartScreen stops the installer the first time.** Windows shows "Windows protected your PC" and hides the
  Run button behind **More info → Run anyway**. That isn't a warning about Mewndo specifically; an unsigned
  installer nobody has downloaded yet has no reputation, and there's no way to earn one without a certificate.
- **Defender scans a new, unknown binary harder on its first runs.** `docs/benchmarks.md` measured unsigned
  builds at **about 2× slower** under Defender than signed, packaged ones, and the 5,000-file restore there
  (28.65 s against a 5 s target) was already Defender-bound. Expect the first restore after an install to be
  the slowest one.
- **No automatic updates, so a fix doesn't reach you on its own.** Nothing checks for a new version.

With a certificate, four things change and nothing else: `electron-builder` signs the installer and both
`.exe`s, SmartScreen stops asking once the signature has some download history, `electron-updater` plus a
`publish` target can be switched on for signed auto-updates, and the Defender penalty above goes away.
`apps/desktop/package.json` deliberately sets `"publish": null` and no signing identity, and
`stage-binaries.js` fails the build if either appears, so nothing here can quietly start claiming to be signed.
A certificate costs money, and `docs/v1-build-prompts.md`'s "needs money, approvals or a company account" table
puts it before public launch, not in this sprint. Nothing has been bought and no paid service has been added.

### Not verified

`electron-builder` has never run in this repository: making an NSIS installer needs Windows tooling that the
development machine hasn't got, so **no installer has been produced and none has been installed**. What is
checked is the configuration and its inputs, by the `--check` command above. Everything the installer itself
does — the Run entry, the shortcut, the uninstall questions, the folder layout in the table — is read off
`apps/desktop/build/installer.nsh` and electron-builder's documented NSIS behaviour, not observed.

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
