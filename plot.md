# Mewndo rules

Mewndo is a Windows desktop app that undoes AI agents. It protects folders,
keeps every version of every file, and restores a folder or chosen files to
an earlier save point. Real people trust it with their files: correctness
beats features.

Stack: Electron + Node.js, plain JavaScript (CommonJS), Chokidar for watching,
`node:test` for tests. No UI frameworks.

Layout: `apps/desktop/` the Electron app, containing `engine/` all file logic,
plain Node, never imports Electron · `app/` Electron main process and windows ·
`test/` tests · `scripts/` dev scripts. Also `core/` Rust service · `cloud/`
Cloudflare Workers · `notebooks/` Kaggle notebooks · `docs/`. Run npm scripts from the root.

1. Mewndo's data lives in the user's app data folder, never inside a protected folder.
2. Never follow symbolic links or Windows directory junctions. Always use `lstat`
   and store a link as a link.
3. Mewndo never permanently deletes user files. Anything it removes goes into
   Mewndo's trash folder.
4. Every file written during a restore goes to a temporary file first and is
   then renamed into place.
5. Ignore `node_modules`, `.venv`, `dist`, `build` and cache folders by default,
   but include the `.git` folder.
6. Skip files larger than 50 MB by default and record that they were skipped.
7. Everything stays on the user's computer. No network calls except the
   localhost-only server added later.
8. The engine supports several protected folders at once, each with its own history.
9. Never block the user interface. Long work reports progress.
10. Every engine feature gets tested. Tests only use temporary folders, never
    real user folders.
11. Keep the code simple and readable.
