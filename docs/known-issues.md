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

Fix: in the Rust core (P1.3 change feed onwards), resolve every folder root to its long real path once, at the
edge (`GetFinalPathNameByHandle`), and look folders up by that. Add a test that protects a folder by its alias,
then names it by alias and by long path. The v0 engine is the reference and is retired at cutover (P1.7).
