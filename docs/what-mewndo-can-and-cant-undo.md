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
- Pick up changes made while Mewndo was closed. The folder as it was when Mewndo last saw it is kept as a
  save point.
- Protect the `.git` folder, so an agent's damage to your repository history can be undone too.

## Can't

- **Files over 50 MB** are skipped by default. Mewndo records that they were skipped, so you can see it.
- **Ignored folders** (`node_modules`, `.venv`, `dist`, `build`, cache folders) are not saved. They can
  normally be rebuilt.
- **Files that change while Mewndo reads them** are skipped for that save point and recorded as
  "changed while reading". The next save point picks them up.
- **Links to files on Windows** can only be recreated with Developer Mode on or as administrator. Links to
  folders come back as junctions, which need neither. A link that can't be recreated is reported.
- **Links swapped in mid-read on Windows:** Windows can't fully block a file being swapped for a link at the
  exact moment Mewndo reads it. Mewndo re-checks the file after opening and reading and skips it if anything
  changed, which catches it in practice. Exploiting the gap needs write access to the protected folder.
