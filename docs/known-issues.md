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

If it fails again, keep the budget: it's the promise that a hook never slows the agent. Measure where the time
goes (Node start, the HTTP call, the save point) instead.
