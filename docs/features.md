# Mewndo: every feature, and how far each one is built

Mewndo is a Windows desktop app that undoes AI agents: it protects folders, keeps every version of every file, and
restores a folder or chosen files to an earlier save point. Version 1 adds an Agent Desk (an Inbox for agents'
questions, a Talk box, lanes), a decision router (Clef), receipts, guarded computer use and cloud speech.

Status words: **Works** = built and tested, used by the app. **Built** = built and tested, not yet switched on or
not yet run on Windows / with the real service. **Not built** = not there. The honest limits of each are in
`docs/what-mewndo-can-and-cant-undo.md`; how to run it is in `docs/run-locally.md`.

## 1. Protection and undo (v0 engine, `apps/desktop/engine/`) — Works

- **Protected folders**, several at once, each with its own history. Data lives in the app data folder, never inside
  a protected folder. The screen opens the first folder's save points; warnings show above every screen as one row
  each with an icon and Dismiss. A folder that can't be found also has **Remove from Mewndo…** (asks; keeps its save
  points unless you also choose to delete them; never touches the folder) and **Locate…**, which says honestly that
  a folder's history can't move to a new place yet and offers to protect the new place with a fresh history. Low
  disk space and over-budget history have **Open storage settings** (the history budget). Unverified on Windows.
- **Every version of every file**, content-addressed (SHA-256), text gzipped. Links and junctions are stored as
  links, never followed. Files over 50 MB are skipped and recorded. `node_modules`, `.venv`, `dist`, `build` and
  caches are ignored; `.git` is kept.
- **Save points**: automatic, manual, before an agent starts, every 10 minutes while one runs, before every Claude
  Code command (with its hooks), before an undo. Changes made while Mewndo was closed are picked up.
- **Restore** the whole folder, chosen files, or into a separate folder. Every file goes to a temp file, is checked
  against its SHA-256, then renamed into place. Anything replaced goes to Mewndo's trash (never deleted). A restore
  cut short by a crash finishes on the next start. A restore can itself be undone.
- **Guard (v0)**: Claude Code's HTTP hook asks Mewndo before shell commands and edits; rules say allow/deny/ask.
- **Brake**: freeze or stop an agent's whole process tree.
- **Local MCP server** (`mewndo-core mcp`): agents can make save points, request deletes, report progress. Undo is
  never exposed to agents.

## 2. The core service (`core/`, Rust) — Works

`mewndo-core` runs beside the app: the v1 socket, the store, restores, the scanner, the process tree, and with
`--desk` the **Agent Desk pipe** (protocol v2, framed JSON plus binary lane frames, current user only).
`mewndo-hook.exe` forwards every agent hook to it in a few milliseconds and fails open from a cached deny list when
the core is down. A **signed, hash-chained Flight Recorder** logs decisions, save points and restores; a standalone
verifier checks it.

## 3. Agent Desk (§33)

- **Agent Inbox** — Works. Permission, question, done, drift and receipt cards from Claude Code, Codex and Cursor
  hooks (installed by the Connect buttons; Codex and Cursor not yet tried on a real run); answer with keys (1–3,
  Space to type, V for voice) with a 2 s grace and Esc to take it back; the answer goes back to the waiting hook;
  focus returns to your app; Undo from a Done card restores its save point. A new card never takes focus; clicking
  into one makes the keys work (1–3 options or a Done card's next steps, Space reply, X X stop the agent, E
  discard, Esc close) and hands focus back after. V (or the reply box's mic) records with Mewndo's own mic and puts
  the words in the reply box for you to check and send with Enter; focusing a Done card's reply asks the core to
  keep its Stop hook waiting (`inbox.hold`). Unverified on Windows (written and unit-tested on Linux).
- **"Needs you" chip** — Built, unverified on Windows. "Claude needs you" beside the dock while a card waits;
  hover shows the cards without taking focus, click opens them to answer.
- **Habit card** (§34.7) — Built. Three identical answers offer "Always allow `npm test` in shop?"; Yes writes the
  rule into `%APPDATA%\Mewndo\rules.toml` (formatting kept, `# habit <date> agent=<kind> project=<name>`), temp file
  then rename. **Settings → Habits** lists every learned rule (allow or deny, the command, agent, project, date),
  refreshes while open, and removes one after asking (just its two lines, temp file then rename). Limits: a removed
  rule stops applying at the next start (the core reads the file only then); "never ask" isn't written to the file,
  so it isn't listed and lasts until restart; rules you wrote yourself aren't listed.
- **Do not disturb and sound** (Settings → Notifications) — Built, unverified on Windows. Off / 1 hour / until 8:00
  tomorrow / every day between two times. While on, cards still reach the Inbox and the dock badge but don't pop
  up, and Mewndo shows no Windows notifications; permission requests from your agents still pop up. An optional soft
  sound on a new card (off by default; volume; Test), a bundled WAV made by `apps/desktop/scripts/make-sound.js`.
  It's Mewndo's own setting, not Windows' Focus.
- **Talk box** — Works. Type or speak where text should go; the Router picks the agent (or a Mewndo command),
  and low confidence shows the top two as chips.
- **Messages to an agent** (`agent.message`) — Built in the core. Claude Code and Cursor: delivered now while
  the Done card's hook waits, or queued while the agent works and delivered at its next stop (Claude carries on,
  Cursor gets a follow-up). Codex: queued messages only (its stop hook has no reply window yet). An agent idle at
  its prompt with no hook running can't be reached except through a lane, and Mewndo says so. Typing in or
  dictating into a Done card holds its window open (up to 120 s Claude, 25 s Cursor).
- **Typing into an idle agent's terminal** — Built, unverified on Windows. When an agent is idle at its prompt
  and its hook reported which process owns its terminal (`console_pid`, found by `mewndo-hook.exe` past the shell
  that ran it), the Talk box asks first: the reason ("Claude Code is idle at its prompt. Type this into its
  terminal?"), the exact text in quotes, and 1 Type it / 2 Cancel. Type it sends `agent.type {offer_id}`; the core
  types the text it showed (one line: newlines become spaces, control characters go, at most 2000 characters) and
  presses Enter, through a helper attached to that console, then says "Typed into Claude Code's terminal." The
  offer is single use and lasts a minute; if the agent started working or stopped with a hook waiting since, the
  text is queued or sent instead of typed. Limits: Windows only; only text you entered in Mewndo, only into a
  terminal Mewndo's own hook reported, never without your confirm, and the text never goes on a command line, into
  a log or onto disk. Not verified against Windows Terminal, ConPTY or Claude Code's input (docs/known-issues.md);
  elsewhere, or with no terminal reported, it is "can't reach" with "Open a lane" as before.
- **Done card next steps** — Built in the core. Up to three rule-based options ("Send back: …" when the Receipt
  found a mismatch, "Fix the failing tests", or "Looks good, carry on" / "Run the tests" / "Summarize what you
  changed"); choosing one sends it like a typed reply. Codex, Cursor and Claude all appear on the agent list
  (working, needs-you, done, idle), with the lane when they run in one.
- **Press to talk** — Built, unverified on Windows. Hold the dock's mic: a short command that leads the sentence
  ("stop Claude", "undo the last ten minutes") acts as before; anything else is a message. It appears in the Talk
  box as heard and goes to the only agent, or where the Router says (chips when unsure). Delivery: a lane, else
  an open Done card's reply, else the core's `agent.message`; the box then says "Sent to Claude", "Queued: Claude
  gets it when it finishes this step", or the core's reason with "Open a lane". Typed Talk text uses the same
  delivery. Limits: the words show after recognition finishes, not live; a core without `agent.message` gives the
  old "can't reach outside a lane"; no answer within 6 s is reported as unknown, never as sent; the command rules
  are word rules, so a long sentence with "stop" in it is a message, not a brake.
- **Lanes** (§33.7) — Built; the window is unverified on Windows. Tray → Lanes…, or "Open a lane" when the Talk
  box can't reach an agent, opens a terminal window (xterm.js, vendored): tabs per agent, a New lane picker
  (Claude Code, Codex or Cursor, in the most recently changed protected folder or home), keystrokes, resize,
  brake (Ctrl+C), "exited (code)", close, and the last 256 KB replayed to a window that opens later. A missing
  agent shows the core's own words ("claude is not on PATH"). Can't: start a plain shell (the core runs only the
  three agents); read the terminal (it can't tell whether the agent waits at a prompt); keep a lane after Mewndo
  quits. Talk reaches Codex and Cursor in a lane (their agent id names it); not yet Claude Code in a lane, whose
  agent.status doesn't name its lane. Core lanes tested over the pipe on Linux and through ConPTY on Windows
  CI; the window was only smoke-tested with Electron on Linux against fake core messages.

## 4. Clef router and gateway (§34, §37)

- **Router** — Works on rules. Built-in and user rules (`rules.toml`), normalization of every agent's actions,
  scope from the brief, a 5-minute answer cache, habits, triage of card urgency, voice routing, shadow mode (the
  model only advises), a kill switch.
- **Clef transport** — Built. The core asks the gateway (`POST /v1/decide`) over one warm HTTPS connection, with
  a deadline on every call and the rules as the fallback. Device token in Windows Credential Manager. Tested
  against the real Worker under `wrangler dev` with a stubbed model.
- **Gateway** (`cloud/gateway`, Cloudflare Worker) — Built, not yet deployed. Invite/judge codes and device
  tokens, Workers AI only, a daily neuron budget with a priority order (Guard keeps the model longest), per-device
  and per-code caps, an answer cache, "Rules only mode" when the day runs out, admin status/settings, a hosted MCP
  and a hub for cloud agents.
- **Receipts** (§35, `mewndo-trace`) — Built. Claims in an agent's summary checked against what it really did,
  including "I edited/created/deleted <file>" against the files its tool calls touched (Claude Code only; a
  shell command that could have changed the file unseen leaves the claim unchecked rather than flagged).

## 5. Cloud speech (§19.5) — Built

The mic's recording goes to the gateway (`POST /v1/transcribe`, Whisper base on Workers AI), with an 8 s deadline
and its own place in the budget below Guard. Any fallback, error, timeout or missing token uses **Windows' offline
recognizer**, which is also the only provider when no gateway is set. Audio is never stored.

## 6. Guarded computer use (§36) — Built, off by default, never run on Windows

- **Settings → Computer use**: an On/Off switch (Off by default). On needs cua-driver 0.34.0: if it is missing,
  Settings shows its size (31.3 MB to download, about 84 MB unpacked, x64; 29.5 MB for arm64), where it comes from
  (the pinned GitHub release), its SHA-256 and the folder, and downloads only when you press Download. The archive
  must match its pinned SHA-256 and each program in it its own, or nothing is installed; the core checks the
  programs again before it starts the driver. Then the core is restarted with `--computer-use`. Status shows Off /
  not downloaded / On / Paused (with Resume), and the honest limits.
- **Connect an agent** (same section): adds `mewndo-core mcp-computer --agent <claude|codex|cursor>` as an MCP
  server to `~/.claude.json`, `~/.codex/config.toml` (a marked block) or `~/.cursor/mcp.json`, after showing
  exactly what is added, with a backup first; Remove takes it out again.
- `mewndo-core mcp-computer --agent <name>` offers the pinned, SHA-256-checked **cua-driver** tools as
  `computer_*` only; there is no unguarded name.
- **Every call is checked by the core**: off unless the core runs with `--computer-use`; reads pass; every action
  becomes an Inbox card and your answer decides; no core or no answer = refused. Typed text is shown only as its
  length.
- **Human takeover**: touching the mouse or keyboard while an agent acts pauses everything until Resume. The hooks
  read only "was this injected", never keys or positions.
- **Agent cursor overlay**: Mewndo's own labelled cursor ("Claude · clicking") on a click-through window per
  display; cua-driver's cursor is switched off (label-only fallback).
- Not built: the element name and screenshot on the card (an agent's own act still says "click at 412, 230").

## 6a. Show Me skills (§36.6 U9) — Built, needs computer use on, never run on Windows

- **Record a skill** on the Skills screen: the main window steps aside and "Recording — Esc to stop" stays on top
  of every window (click-through, kept out of screenshots). Esc, Stop or 10 minutes ends it.
- Recorded: the app and window brought to the front, clicks (with the element's name and control type from UI
  Automation when it gives one), typed text, named keys and shortcuts. **Never recorded:** text typed into a
  password field, into a password manager or Windows' credential prompts, into a field UI Automation can't
  describe, or anything on the secure desktop; the step says "something private" and keeps no text or length.
- Review: name it, describe it, delete steps, correct typed text, Save. Saved skills are listed; Edit renames,
  edits steps or deletes (the file goes to `skills\.trash`). Stored as JSON in `%LOCALAPPDATA%\Mewndo\skills`.
- Agents run one with the MCP tool **`run_skill {name}`**: each step is the same driver call an agent could make
  and goes through the same guard one at a time (every act classified and asked about, the card naming the skill
  and step; touching the mouse pauses it). The first refusal, failure or private step stops the run, and the
  agent is told how far it got.
- Not built: scrolling, dragging and held keys are not recorded; pasted text is recorded as Ctrl+V; replay clicks
  the recorded screen points on the primary display (it does not find the element again or switch windows); no
  screenshots of steps.

## 7. Installer (§31.7) — Built, never run

An unsigned per-user NSIS installer carrying the app, `mewndo-core.exe`, `mewndo-hook.exe` and the Claude Code
plugin; starts at sign-in; uninstall removes Mewndo's hooks from Claude Code, Codex and Cursor and asks before
deleting history.
`build/stage-binaries.js` refuses to package non-x64 or non-Windows binaries, a broken plugin, or a core without
`--desk`. Connect installs the v1 hooks (`mewndo-hook.exe`) for Claude Code, Codex and Cursor, replacing the v0 ones.

## 8. Integrations

Claude Code (plugin hooks), Codex (hooks + notify), Cursor (hooks), all installed from Connect; the Grok bot skill,
Kaggle notebooks (`notebooks/`).

**Connections screen** (`app/connectors/`, §23.8, §25.3) — Built, never run against a real account. Setup:
`docs/connections-setup.md`.

- **Gmail, Google Drive, Notion** — through Workers you deploy to your own free Cloudflare account (`cloud/gmail`,
  `cloud/drive`, `cloud/notion`). Connect runs Google's sign-in through the Worker (the app collects an app token
  with a claim secret; no local listener) or hands Notion's internal-integration secret to the Worker once. The
  card shows Protected / Connect again, recent changes from the Worker's journal grouped into bursts, who did it
  ("likely" by time to a local agent session, or "?"), and Undo per change or per burst with progress. Gmail:
  untrash and labels; deleted-forever mail can't come back. Drive: untrash, moves, renames; deleted-forever files
  only from an optional R2 copy (needs a card; no watched-folder picker yet). Notion: untrash and removed blocks,
  1–2 min late, new block ids. Google Testing mode: sign in again every 7 days. Without a Worker address (Settings
  → Connections or `MEWNDO_*_URL`) a card says "Not set up" and what to deploy. Pub/Sub push is optional (needs a
  Google billing account); without it the app asks the Worker to check every 3 minutes.
- **GitHub** — local, no Worker. A fine-grained token in Credential Manager; up to 10 repos polled every 5 min with
  ETags: branch heads, default-branch protection, open/closed issues and PRs. Undo: recreate a deleted branch,
  move a force-pushed branch back (native confirm naming branch and both SHAs; a second one on the default branch;
  refused if it moved again), reopen issues/PRs. Can't: changes before journaling, deleted repos, merged PRs,
  re-enabling protection.
- Unverified: no Worker deployed; no real Google/Notion/GitHub call made; Credential Manager writes not run on
  Windows. The bar's up-arrow panel still lists only protected folders, not accounts.

## Not done yet

Live agents end to end on Windows (needs your Claude `/login` and OK to edit your Claude/Codex config); the lanes
window against a real core and ConPTY, the computer-use setting and Resume control (UI session, `docs/ui-requests.md`); the gateway deploy
(`docs/run-locally.md` §6); signed builds and auto-update.
