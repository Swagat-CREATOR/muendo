# Mewndo: every feature, and how far each one is built

Mewndo is a Windows desktop app that undoes AI agents: it protects folders, keeps every version of every file, and
restores a folder or chosen files to an earlier save point. Version 1 adds an Agent Desk (an Inbox for agents'
questions, a Talk box, lanes), a decision router (Clef), receipts, guarded computer use and cloud speech.

Status words: **Works** = built and tested, used by the app. **Built** = built and tested, not yet switched on or
not yet run on Windows / with the real service. **Not built** = not there. The honest limits of each are in
`docs/what-mewndo-can-and-cant-undo.md`; how to run it is in `docs/run-locally.md`.

## 1. Protection and undo (v0 engine, `apps/desktop/engine/`) — Works

- **Protected folders**, several at once, each with its own history. Data lives in the app data folder, never inside
  a protected folder.
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
  hooks; answer with keys (1–3, Space to type, V for voice) with a 2 s grace and Esc to take it back; the answer
  goes back to the waiting hook; focus returns to your app; Undo from a Done card restores its save point.
- **Habit card** (§34.7) — Built. Three identical answers offer "Always allow `npm test` in shop?"; Yes writes the
  rule into `%APPDATA%\Mewndo\rules.toml` (formatting kept, `# habit <date>`), temp file then rename.
- **Talk box** — Works. Type or speak where text should go; the Router picks the agent (or a Mewndo command),
  and low confidence shows the top two as chips.
- **Lanes** (§33.7) — Built (core + app logic; the lanes window is still a placeholder). Start Claude, Codex or
  Cursor in a terminal Mewndo owns; reply at any time, brake (Ctrl+C), resize, replay the last 256 KB to a window
  that opens later, close. Tested over the pipe on Linux and through ConPTY on Windows CI.

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
- **Receipts** (§35, `mewndo-trace`) — Built. Claims in an agent's summary checked against what it really did.

## 5. Cloud speech (§19.5) — Built

The mic's recording goes to the gateway (`POST /v1/transcribe`, Whisper base on Workers AI), with an 8 s deadline
and its own place in the budget below Guard. Any fallback, error, timeout or missing token uses **Windows' offline
recognizer**, which is also the only provider when no gateway is set. Audio is never stored.

## 6. Guarded computer use (§36) — Built, off by default

- `mewndo-core mcp-computer --agent <name>` offers the pinned, SHA-256-checked **cua-driver** tools as
  `computer_*` only; there is no unguarded name.
- **Every call is checked by the core**: off unless the core runs with `--computer-use`; reads pass; every action
  becomes an Inbox card and your answer decides; no core or no answer = refused. Typed text is shown only as its
  length.
- **Human takeover**: touching the mouse or keyboard while an agent acts pauses everything until Resume. The hooks
  read only "was this injected", never keys or positions.
- **Agent cursor overlay**: Mewndo's own labelled cursor ("Claude · clicking") on a click-through window per
  display; cua-driver's cursor is switched off (label-only fallback).
- Not built: the element name and screenshot on the card; Show Me.

## 7. Installer (§31.7) — Built, never run

An unsigned per-user NSIS installer carrying the app, `mewndo-core.exe`, `mewndo-hook.exe` and the Claude Code
plugin; starts at sign-in; uninstall removes Mewndo's hooks from Claude Code and asks before deleting history.
`build/stage-binaries.js` refuses to package non-x64 or non-Windows binaries, a broken plugin, or a core without
`--desk`. The app still installs the v0 hooks, not the plugin.

## 8. Integrations

Claude Code (plugin + v0 hooks), Codex (hooks), Cursor (hooks), the Grok bot skill, Gmail/Notion/Drive cloud
helpers (`cloud/`), Kaggle notebooks (`notebooks/`).

## Not done yet

Live agents end to end on Windows (needs your Claude `/login` and OK to edit your Claude/Codex config); the lanes
window's look, the computer-use setting and Resume control (UI session, `docs/ui-requests.md`); the gateway deploy
(`docs/run-locally.md` §6); signed builds and auto-update.
