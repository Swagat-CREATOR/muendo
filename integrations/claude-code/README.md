# Mewndo for Claude Code

The Claude Code plugin from spec §38.4, with the handlers in
`core/crates/mewndo-core/src/agents/claude.rs` (§33.10 Part C).

```
integrations/claude-code/
  .claude-plugin/plugin.json      name, version, description
  hooks/hooks.json                the eight hooks of §38.4            <- installed by default
  hooks/hooks.fallback.json       the §33.10 Part C step 6 variant    <- only if "ask" never reaches PermissionRequest
  bin/mewndo-hook.exe             copied in by the build script       <- NOT in the repository
```

## `bin/mewndo-hook.exe` is not in the repository

Every command in `hooks/hooks.json` runs `"${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe"`. That binary is
`core/crates/mewndo-hook` (§33.10 Part B), and **the build script copies it into `bin/` as part of packaging**;
it is a build output, so it is not committed. Until it is copied in, the hooks fail to start, which Claude Code
treats as a hook that said nothing - the agent carries on (§38.4, "Fail open").

The path is quoted in every command because `${CLAUDE_PLUGIN_ROOT}` expands to a real folder on a real machine,
and real folders contain spaces (`C:\Users\Ana Maria\...`). Unquoted, the shell would run `C:\Users\Ana` and the
user would silently lose the guard.

## Installing

The Connect page (§22.2, prompt P5.2) installs this. Its logic is Rust, in
`core/crates/mewndo-core/src/agents/claude.rs`, module `connect`:

| Call | What it does |
|---|---|
| `connect::plan(settings_path, plugin_root, variant)` | What installing would change, without changing it: `preview`, `merged`, `installed`, `v0_entries` |
| `connect::install(..)` | Backs the file up, merges, writes through a temp file and a rename |
| `connect::remove(..)` | Takes every Mewndo entry out again and leaves everything else alone |

It merges into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) with absolute paths, because
§33.10 Part C step 2's first choice - the official "install a local plugin" command - is a **verify-first item**
(§32.5 rule 3) that could not be checked here: there is no Claude Code on this machine. See the report in
`docs/samples/claude/README.md` for what is unverified.

Installing **removes the v0 hook entries** first (§33.10's first pitfall: otherwise the v0 save-point hook and
the v0 HTTP Guard fire alongside the plugin and the user gets two cards and two save points for one action). A
Mewndo entry is any hook whose `command` contains `mewndo`, whose `url` is the v0 guard
(`http://127.0.0.1:<port>/guard`), or which carries an `X-Mewndo-Token` header - the v0 Guard is an `http` hook
with no command at all, so matching the command alone would leave it behind.

Installing twice changes nothing. The previous settings file is copied to `settings.json.mewndo-backup` (kept
once, so the first backup is always the one from before Mewndo) before anything is written.

## `hooks/hooks.fallback.json`

§33.10 Part C step 6: if a `PreToolUse` `"ask"` turns out **not** to raise a `PermissionRequest` hook, then
`PreToolUse` itself has to wait for the card, and its 5-second timeout is not enough. The fallback file adds a
second `PreToolUse` entry, with a 300-second timeout, matching only the tools that can need approval. Claude
Code then runs the `pre-tool` hook **twice** for those tools; the core recognises the duplicate (same session,
same tool, same input digest) and only one of the two waits.

Do not install both files. The fallback is off by default and switched on with the core setting
`claude.pre_tool_waits_for_card`, which is also what makes the core wait.
