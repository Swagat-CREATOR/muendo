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
