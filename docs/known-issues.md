# Known issues

Problems found and understood but not fixed yet, with what fixes them. Remove an entry when it's fixed.

## v0 engine: a folder named by a Windows 8.3 short alias

Found 5 Oct 2026 by the first CI run on Windows. Windows can name a folder by a short alias such as
`C:\Users\JOHNSM~1\Projects` instead of `C:\Users\John Smith\Projects`. The v0 engine stores a protected folder
by its long real path, so:

- a folder protected through its alias is listed under the long path, not the one given;
- calls that name the folder by its alias (settings, unprotect, a hook whose agent works in the alias) answer
  "not a protected folder";
- `readStable` can refuse a file as "outside protected folder" when the folder and the file are resolved
  differently (`fs.realpathSync` keeps aliases; `fs.promises.realpath` expands them).

How likely: low. The folder picker always gives long paths; aliases come from old tools, some shells and the
`TEMP` folder of users whose names are long or have spaces.

Reproduce: run the Node tests on Windows with `TEMP` and `TMP` set to a short alias (11 tests fail). CI points
`TEMP` at a long path so it tests what users have; see `.github/workflows/ci.yml`.

Fixed in the Rust core (P1.3): `scan` and `watch` resolve every folder to its long real path (`paths::real`) and
know it by that, so an alias and the long path name the same folder (test:
`feed::live::a_short_8_3_alias_is_watched_as_its_long_real_path`). Still open in the v0 engine, which is the
reference until cutover (P1.7) and then retired; remove this entry then.

## v0 test: the savepoint hook's one-second budget can be missed under load

Found 5 Oct 2026. `mewndo-savepoint: asks Mewndo for a save point, prints nothing, exits 0 quickly`
(`apps/desktop/test/agents.test.js`) needs the hook script to exit within 1 s and the save point to exist 200 ms
later. It failed once on Windows, in the first full test run after a new `mewndo-core.exe` was built (Windows
Defender scans a new program on its first runs, and the test files run in parallel), then passed in five runs.

The same happened once to its neighbour `mewndo-savepoint: still exits 0 within a second when Mewndo isn't set up,
isn't running, or hangs` (5 Oct 2026, full Windows run after the process control tests were added, which start
`cmd` and `ping`); it passed in the next four runs, alone and in the full suite.

If it fails again, keep the budget: it's the promise that a hook never slows the agent. Measure where the time
goes (Node start, the HTTP call, the save point) instead.

## Rust test: the policy rules' 5 ms budget can be missed on a cold first run

Found 8 Oct 2026. `check` in `policy.rs`'s tests asserts that a verdict takes under 5 ms. On WSL, the first run of a
freshly built test binary failed it in 3 of 75 tests (about 11 ms each), and in 4 of 8 when only the policy tests
ran; the next runs all passed. The rules are pure CPU work with no file or network access, so the time is the
thread waiting to be scheduled, not the rules.

If it fails again, keep the budget: it's the promise in spec §24 that the guard never slows the agent. Measure the
check alone (outside the parallel test runner) before changing anything.

## Desktop tests: timing checks fail when the PC is busy

Found 9 Oct 2026, while other agents were building on the same 4-core PC (load 2 to 3). In full runs, a different
timing check failed each time and every one passed when its file ran alone: the guard harness Codex and Cursor
scenarios (Linux, 13 to 18 s), `a folder can be unprotected while its first scan is still running` ("unprotect
took 3464 ms", Linux), and `mewndo-savepoint: asks Mewndo for a save point` (Windows: the save point wasn't listed
200 ms after the hook exited; 3 of 3 passes alone). None of them start the core with `--desk`, so the Agent Desk
pipe isn't involved. CI on its own runner passes.

If one fails on an idle PC, it's real: keep the budget and find where the time goes.

## Connect agents: the v1 hooks are installed, but never run against a real agent here

Found 10 Oct 2026, changed 11 Oct 2026. The Connect buttons now write the v1 hooks (`mewndo-hook.exe`) into
`~/.claude/settings.json`, `~/.codex/hooks.json` plus a `notify` line in `~/.codex/config.toml`, and
`~/.cursor/hooks.json` (`apps/desktop/engine/agent-connect.js`), replacing the v0 hooks. Tested only against
temporary folders on Linux. Not verified: that Claude Code on Windows runs a quoted forward-slash path (the v0 hooks
use the same form); that Codex loads the user-level `~/.codex/hooks.json` at all (the project-level file did not run,
`docs/decisions.md`; the spec says hooks are on by default, so no feature flag is written); that Cursor reads
`timeout_ms`; and that Codex and Cursor run a quoted backslash path. Codex and Cursor get no save points from the
v1 hooks (only Mewndo's own, when it sees the agent), and with the core down their v1 hooks let everything through
except protected paths, where the v0 guard script refused destructive commands.

## Typing into an idle agent's terminal: never run against a real terminal

Found 11 Oct 2026. The pure parts (choosing the agent's process, cleaning the text, the key records, the offer's
single use and expiry, the app's confirm flow) are tested on Linux; the Windows code compiles for
x86_64-pc-windows-gnu. Not verified, because no Windows console was available here: that `AttachConsole` plus
`WriteConsoleInputW` into `CONIN$` reaches an agent running in Windows Terminal (ConPTY) or the classic console;
that Claude Code's Ink input, Codex and Cursor read the key events as typing (Ink may treat a fast burst as a paste,
and its Enter handling may differ) and submit on the final `VK_RETURN`; that Claude Code on Windows runs hooks
through a shell the walk skips (Git Bash, cmd), so the reported process is the agent's; and how long the Toolhelp32
snapshot adds to each hook. A parent process that exited may have had its id reused, which a snapshot cannot tell
apart; the core refuses to type when the reported id changed since the offer, but not this. If typing fails, the
Talk box shows the helper's reason and offers a lane.

## Computer use and Show Me: never run on Windows

Found 11 Oct 2026. Everything that can run on Linux is tested there (the switch, the download's size and SHA-256
check with a local fake file, the per-program check, the MCP settings for each agent, the skill format on both
sides, the recording state machine and its password rules, replay through the guard with a stand-in for
cua-driver), and the Windows code compiles and is clippy-clean for x86_64-pc-windows-gnu. Not verified, because no
Windows machine was available here:

- the download from GitHub and `Expand-Archive` in the real app (the pinned archive was fetched once on Linux, and
  its SHA-256 matched the pin);
- that `cua-driver.exe mcp` starts from `%LOCALAPPDATA%\Mewndo\vendor\cua-driver` and answers (no live capture);
- the recording hooks: that they see the user's clicks and keys and not injected ones; that UI Automation's
  `IsPassword` is reported by the browsers and apps people use (a field it can't read is treated as a password
  field, so typed text may be missing rather than leaked); that `ToUnicodeEx` gives the right characters on
  non-US layouts (dead keys may come out wrong); that clicks on elevated apps reach the hooks; that a hung app's
  UI Automation does not hold up the steps behind it for long;
- that the global Esc shortcut and the core's Esc both stop a recording without the recorded app seeing Esc;
- replay: clicks are aimed at the recorded point on the primary display (cua-driver's desktop target), so a
  window that moved, another display or a different DPI scale clicks the wrong place; the card names the step so
  the user can refuse it;
- that Claude Code, Codex and Cursor load the `mewndo-computer` MCP server from the files Mewndo writes (Claude Code
  rewrites `~/.claude.json` often; a running Claude Code may overwrite the change until it restarts).

## Installer: never built here

Found 10 Oct 2026. `build/stage-binaries.js --check` and its tests run on Linux and in CI against synthetic Windows
binaries, but no NSIS installer has been produced by this work, and `installer.nsh` has not been run. An update
installed while an agent is running a `mewndo-hook.exe` from the installed plugin folder (a permission hook can
wait 300 s) would find that file in use; the NSIS installer then asks to retry. Not seen: no installer has run.

