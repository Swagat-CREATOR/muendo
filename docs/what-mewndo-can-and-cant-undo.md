# What Mewndo can and can't undo

## Can

- Restore any saved version of any file in a protected folder, byte for byte. Every restore is checked
  against the file's SHA-256 before it is put in place.
- Restore symbolic links and junctions as links. Mewndo records where a link points but never follows it.
- Restore the whole folder, chosen files or folders, or a copy into a separate empty folder. Anything a
  restore removes or replaces goes to Mewndo's trash, and the state just before the restore is kept as a
  save point, so a restore can itself be undone. A restore cut short by a crash finishes on the next start.
- Keep several protected folders at once, each with its own history.
- Keep manual, brief and before-undo save points for the folder's whole retention period (30 days by
  default), even when storage is tight. Only automatic save points are removed early to stay within budget.
- Keep everything in Mewndo's trash until you choose to empty it.
- Make a save point when an AI agent starts (Claude Code, Cursor, Codex, Windsurf, OpenClaw, the Claude app, and
  any you add to `agents.json`), and every 10 minutes while one runs and files changed. With the Claude Code hooks
  set up, also right before every command Claude Code runs.
- Pick up changes made while Mewndo was closed. The folder as it was when Mewndo last saw it is kept as a
  save point.
- Protect the `.git` folder, so an agent's damage to your repository history can be undone too.

## Can't

Mewndo only undoes changes to files in protected folders. It can't undo:

- **Emails or messages** an agent sent.
- **Payments** or purchases.
- **Changes to websites or online accounts**, including cloud services and databases.
- **Changes outside protected folders**, anywhere else on the computer.
- **Files it skipped** because of their size or ignore rules (details below).

In more detail:

- **After a power cut or system crash**, file versions saved in the last few minutes may not have reached the
  disk. Mewndo checks them at the next start: damaged ones are removed, files still on disk are saved again, and
  it tells you if any versions were lost.
- **While a protected folder can't be found** (for example an unplugged drive), changes to it can't be recorded.
  Its save points are kept, and Mewndo resumes protecting it as soon as it's back.
- **Files over 50 MB** are skipped by default. Mewndo records that they were skipped, so you can see it.
- **Online-only OneDrive files** (and other cloud placeholders that aren't on this PC) are skipped and recorded,
  because reading them would download them. Files kept on this device are protected normally.
- **Ignored folders** (`node_modules`, `.venv`, `dist`, `build`, cache folders) are not saved. They can
  normally be rebuilt.
- **Files that change while Mewndo reads them** are skipped for that save point and recorded as
  "changed while reading". The next save point picks them up.
- **Which agent made a change** is only known for sure when the agent reports itself (Claude Code with the hooks
  set up). Otherwise Mewndo names the agent that was running and marks it "likely": a change you made yourself
  while an agent was open gets that label too.
- **Save points "before every command"** are made as fast as possible but never hold Claude Code up for more than
  a second, so a command that changes files immediately may start before the save point is finished. Mewndo's
  file history still records every change.
- **Links to files on Windows** can only be recreated with Developer Mode on or as administrator. Links to
  folders come back as junctions, which need neither. A link that can't be recreated is reported.
- **Links swapped in mid-read on Windows:** Windows can't fully block a file being swapped for a link at the
  exact moment Mewndo reads it. Mewndo re-checks the file after opening and reading and skips it if anything
  changed, which catches it in practice. Exploiting the gap needs write access to the protected folder.
- **Resuming a braked agent** gives it a Continue card: the task, what really changed on disk (marked
  "Verified"), what went wrong, what was healed, and new rules. Mewndo can't restore the agent's own memory of the
  session, and it can't check what the agent says it did (marked "Agent says"). Claude Code gets the card when its
  next session starts in that folder, so Mewndo must still be running then. Codex reads it from a block Mewndo
  writes into the folder's `AGENTS.md`, Cursor from `.cursor/rules/mewndo-continue.mdc`; both stay until the next
  resume replaces them, so remove them once the task is done.

## How fast

Measured on one PC on 6 October 2026: Windows 11, Intel Core i5-8265U (4 cores, 8 threads), 8 GB RAM, NTFS,
Windows Defender real-time protection on, an unsigned release build, no Dev Drive. Targets are from spec §25.2 and
§28.6. Method and the full table: [benchmarks](benchmarks.md). Restore times are until every file is in place;
verification (a fresh scan with full rehash) finishes at the time in brackets.

| Case | Measured | Target |
|---|---|---|
| Restore 5,000 small files, Rust core | 28.65 s (verified 35.17 s); 16.46 s in an earlier run | under 5 s: missed |
| Restore 5,000 small files, v0 engine | 61.13 s (verified 80.81 s); 54.81 s in an earlier run | under 5 s: missed |
| Restore 5,000 edited files, Rust core | 84.48 s (verified 93.81 s) | under 5 s: missed |
| Undo that restore | 54.37 s (verified 64.81 s) | under 5 s: missed |
| Restore one 1 GB file | not run: that PC had 3.5 GB free and the case needs 5 GB | under 1 s: not measured |
| `mewndo-core` idle, watching 50,000 files | 4.9 MB working set, 0.05 % CPU | under 30 MB (spec §31): met |

So Mewndo does not promise undo in five seconds, and this page won't say so until a measurement shows it. On that
PC, Windows Defender scans every file a restore touches and is what the time goes on: during a 5,000-file restore
Defender used up to 7.8 of the 8 logical CPUs while Mewndo used under 0.6. The same case varies by up to 2× from
run to run. A Dev Drive, a signed build, moving the before-undo save point into the core, and an opt-in Defender
exclusion for Mewndo's store would each close part of the gap without removing a safety step, but none of them has
been measured on that PC; the one number behind them is v0's earlier finding that unsigned builds run about 2×
slower under Defender.

Nothing else about speed is measured. The decision service has never been deployed or timed, so [latency](latency.md)
has no numbers in it, and every figure in spec §38.7 — hook round trip, hook to card, grace to continue, Talk to
delivery, receipt on the Done card, real mouse movement to pause — is a target, not measured.

## What is built and what isn't

Read from the repository on 9 October 2026. Everything above is about **files on this Windows PC**. That is the
only thing Mewndo protects today, and it runs on the v0 Node engine, with restores carried out by the Rust core.

Written but not connected, so Mewndo can't undo anything there today:

- **Gmail, Drive and Notion.** Worker code and its local tests are in `cloud/`, but nothing has been deployed as
  far as this repository shows: the gateway's own notes say "Not deployed and not measured", the decision service
  has no URL to measure against, and the Drive Worker's origin is still an `example.workers.dev` placeholder. No
  mailbox, Drive or workspace is being watched. Google's own setup guide (`docs/google-setup.md`) also keeps the
  project in Testing mode, where a sign-in lasts 7 days and at most 100 people can be added, until the
  restricted-scope security review is done.
- **The hosted MCP and the cloud hub** (`cloud/gateway`, spec §37.6 K6 and K7): written, 73 tests pass against a
  faked runtime, not deployed. Cloud agents can ask the user before a risky step through `ask_user`, and nobody
  answering is never an approval — the tool replies "No answer yet … Do not go ahead without one". The desktop
  side of that link isn't built, so today there is nothing for a card to appear on, and the WebSocket upgrade
  itself has never run: `WebSocketPair` only exists inside Cloudflare's runtime.
- **Send Guard** (`cloud/gmail`, spec §28.4 Flow D): written, 26 tests pass. The rules (first-time recipient,
  look-alike domain, too many recipients, external mail with attachments, secrets and personal data, leftover
  placeholders) and the release bar run offline, and a deadline timeout, a transport error, an unreadable answer
  and a rules-only fallback are all **holds**, so nothing sends without a verdict. But it is not deployed, it has
  never run against a real mailbox, Mewndo holds no send credential, and the hold queue and countdown chip aren't
  built. **No email an agent sends is checked by Mewndo today.**
- **The decision gateway** (`cloud/gateway`, spec §37): tested against a faked runtime, never run on Cloudflare.
  Its own "Honest limits" record that the exact request and response shape of `clef-flash` is still unverified, so
  an answer it can't parse becomes a fallback to the local rules, never a guessed verdict. Nothing points the core
  at a gateway by default: unless `MEWNDO_DECIDE_URL` is set, no model is called at all and every Guard decision is
  made by the rules in the core, on this PC.
  The core's gateway client (`core/crates/mewndo-core/src/clef_gateway.rs`) is written and has run against the real
  Worker under `wrangler dev` with a **stubbed** model, on Linux only. It is used only when `MEWNDO_GATEWAY_URL` is
  set and a device token is saved in Windows Credential Manager (`Mewndo/gateway-device-token`); nothing saves that
  token yet, and the Worker is not deployed, so on a real PC every Guard decision is still the rules'. Its HTTPS
  path (SChannel) has been compiled for Windows but never run there.

Started on that date, and nothing in the app calls any of it yet:

- **Receipts** (`core/crates/mewndo-trace`, spec §35): the claim extractor, the evidence rules, the receipt line
  and the test-runner detection pass their tests. Nothing calls them, so no "Done" card has ever carried a
  receipt, and the check that an agent's summary matches what it really did does not run anywhere a user can see.
- **The Clef Router** (`core/crates/mewndo-router`, spec §34): being written as this was read, and its own tests
  were not all passing at the time. Guard decisions are still made by the rules in `core/src/policy.rs`.
- **The decision gateway's day budget** (`cloud/gateway`, spec §37.2): when the free Workers AI neurons run low,
  Receipts and triage use rules only and voice routing uses keyword matching; past 95% even Guard does, and the
  dock says "Rules only mode". The gateway is not deployed, so this has only run in tests.
- **A standalone ledger verifier** (`tools/ledger-verify`, spec §30.2): see the Flight Recorder note below.

The Agent Inbox (spec §33) is built and was checked in the real app on Windows with a Claude-format permission
request: a card, answered with the Inbox key, the answer back to the hook, focus back to the user's app. No live
Claude Code or Codex session has driven it yet. Not built at all: guarded computer use and Show Me (spec §36). Whoever lands
one of these owns the matching change to this page: spec §31.7 makes keeping it level with §28.10 part of the
work, and nothing may be claimed here that isn't measured.

**Habit cards** (spec §34.7): after the same answer three times to the same action in the same project, the Inbox
offers "Always allow `npm test` in shop?" with yes, no and never ask. Yes stops asking for that action in that
project at once, and adds the command to `[allow]` (or `[deny]`) in `%APPDATA%\Mewndo\rules.toml` under a
`# habit <date>` comment, keeping the rest of the file as it was. What it can't do: rules.toml has no per-project
section, so after the next restart that line applies in **every** project, and as a phrase it also matches longer
commands that contain it. A rules.toml that doesn't parse is never rewritten; the habit then lasts until the core
stops. "Never ask" and the counts are kept in memory only, so they reset when the core restarts. Undoing a habit means
deleting its line from rules.toml; there is no Settings → Habits page yet. Tested in the core and the app's card
logic on Linux; not yet seen in the real app on Windows.

**Lanes** (spec §33.7): the core can start Claude Code, Codex or Cursor's agent in a terminal Mewndo owns, type a
reply into it at any time, press Ctrl+C in it (the brake), resize it, replay its last 256 KB to a window that opens
later, and stop it. Tested end to end over the desk pipe on Linux with `sh`, and on Windows in CI with `cmd` through
ConPTY; never yet with a real agent. What it can't do: it reads a terminal, it doesn't understand one, so a reply
typed while the agent is mid-answer is typed then, exactly as if you had pressed the keys. A lane does not outlive
Mewndo: quitting Mewndo stops every agent running in a lane. The replay buffer is memory only. The lanes window
still shows a placeholder, so none of this can be used from the app yet.

**Guarded computer use** (spec §36): built in the core and the proxy, off by default, and nothing in the app
can switch it on yet. When on, every action an agent takes on the desktop through cua-driver is shown on a card
first and happens only if you allow it; touching the mouse or keyboard while an agent is acting pauses it until
you choose Resume. What it can't do: **nothing a click does can be undone by Mewndo**, so the card is the only
protection. The card cannot show what is under the pointer (no element name, no screenshot yet), and it shows
typed text only as its length. Never run against the real cua-driver; tested with a fake driver on Linux.

**Uninstalling** asks whether to delete Mewndo's saved history; the default is No. Yes permanently deletes every
save point, Mewndo's trash, the Agent Inbox's card history and rules.toml (`%APPDATA%\mewndo` and
`%LOCALAPPDATA%\Mewndo`), and that cannot be undone. Either way Mewndo's hooks are taken out of Claude Code's
settings, keeping the rest of the file and a backup. The installer has not yet been built and run as part of v1.

Partly built: the **Flight Recorder**. The core keeps a local append-only log of guard decisions, heals, holds,
approvals, save points and restores, hash-chained and signed with a device key, so rewriting or dropping an event
is detectable. A standalone verifier now exists (`tools/ledger-verify`, 11 tests) that recomputes the
hash chain, catches a tampered or dropped event, and checks an anchored Merkle root without sharing any code with
Mewndo. Two limits stand, and they are the whole point of the feature:

- The signature is symmetric (HMAC), so holding the device key lets you verify a record and equally lets you forge
  one. A third party still **cannot** verify who wrote the log. That needs an asymmetric device key, which isn't
  built.
- The hourly Merkle roots, the cloud anchor and the public transparency log aren't built. Without them, dropping
  the **last** events leaves a perfectly intact chain — no gap, no broken link — and the verifier exits 0. There
  is a test asserting exactly that. Until roots are anchored somewhere Mewndo doesn't control, a truncated log is
  undetectable.

Builds are unsigned — there's no code-signing certificate yet. Problems found but not fixed are in
[known issues](known-issues.md).

## What Mewndo never claims

- **Not "we copy before the delete finishes."** Mewndo stores versions ahead of time, at save points. A file comes
  back because it was already saved, not because Mewndo raced the delete.
- **Not "instant undo for Notion or OneDrive."** Notion isn't connected. Online-only OneDrive files are skipped and
  recorded, because reading them would download them.
- **Not "we check every email any agent sends."** Mewndo can only check what is sent through Mewndo, and nothing is
  sent through Mewndo today.
- **Not "we can stop any agent."** Mewndo can brake the agents whose hooks it has — Claude Code, Codex, Cursor —
  and on Windows freeze a process and its children. An agent it has no hook into isn't stopped, and a write already
  under way finishes before a freeze takes hold.
- **Not "unsend."** Mewndo can't unsend anything.
