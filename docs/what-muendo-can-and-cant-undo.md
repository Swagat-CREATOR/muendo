# What Muendo can and can't undo

## Can

- Restore any saved version of any file in a protected folder, byte for byte. Every restore is checked
  against the file's SHA-256 before it is put in place.
- Restore symbolic links and junctions as links. Muendo records where a link points but never follows it.
- Keep several protected folders at once, each with its own history.
- Protect the `.git` folder, so an agent's damage to your repository history can be undone too.

## Can't

- **Files over 50 MB** are skipped by default. Muendo records that they were skipped, so you can see it.
- **Ignored folders** (`node_modules`, `.venv`, `dist`, `build`, cache folders) are not saved. They can
  normally be rebuilt.
- **Files that change while Muendo reads them** are skipped for that save point and recorded as
  "changed while reading". The next save point picks them up.
- **Links swapped in mid-read on Windows:** Windows can't fully block a file being swapped for a link at the
  exact moment Muendo reads it. Muendo re-checks the file after opening and reading and skips it if anything
  changed, which catches it in practice. Exploiting the gap needs write access to the protected folder.
