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

Everything above is about **files on this Windows PC**. That is the only thing Mewndo protects today, and it runs
on the v0 Node engine, with restores carried out by the Rust core.

Written but not connected, so Mewndo can't undo anything there today:

- **Gmail, Drive and Notion.** Worker code and its local tests are in `cloud/`, but nothing has been deployed as
  far as this repository shows: the gateway's own notes say "Not deployed and not measured", the decision service
  has no URL to measure against, and the Drive Worker's origin is still an `example.workers.dev` placeholder. No
  mailbox, Drive or workspace is being watched. Google's own setup guide (`docs/google-setup.md`) also keeps the
  project in Testing mode, where a sign-in lasts 7 days and at most 100 people can be added, until the
  restricted-scope security review is done.
- **The hosted MCP and Send Guard** (`cloud/mcp`): written, tested locally, not deployed. No email an agent sends
  is checked by Mewndo.
- **The decision gateway** (`cloud/gateway`, spec §37): tested against a faked runtime, never run on Cloudflare.
  Its own "Honest limits" record that the exact request and response shape of `clef-flash` is still unverified, so
  an answer it can't parse becomes a fallback to the local rules, never a guessed verdict. Nothing points the core
  at a gateway by default: unless `MEWNDO_DECIDE_URL` is set, no model is called at all and every Guard decision is
  made by the rules in the core, on this PC.

Not built at all, though spec §32 to §38 describe them: the Agent Inbox and side dock, the Clef Router, Receipts,
guarded computer use and Show Me. `core/crates/` holds only `mewndo-core` and `mewndo-proto`.

Partly built: the **Flight Recorder**. The core keeps a local append-only log of guard decisions, heals, holds,
approvals, save points and restores, hash-chained and signed with a device key, so rewriting or dropping an event
is detectable. The hourly Merkle roots, the cloud anchor, the public transparency log and the standalone verifier
aren't built, and the signature is symmetric: today only someone holding the device key can check the log, so a
third party can't yet verify it without trusting Mewndo.

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
