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

The Windows installer carries this folder to `%LOCALAPPDATA%\Programs\Mewndo\resources\claude-code\`, with
`bin\mewndo-hook.exe` staged in by `apps/desktop/build/stage-binaries.js` (which also refuses to package a hook
binary that is not a 64-bit Windows program, or a hooks file that runs anything but `bin/mewndo-hook.exe`).

**Nothing installs it into Claude Code yet.** An earlier version of this page described a Rust `connect` module
(`plan`/`install`/`remove`) in `core/crates/mewndo-core/src/agents/claude.rs`; it does not exist. What the app's
Connect page installs today is the v0 hooks (`apps/desktop/engine/claude-hooks.js`: a save-point hook and the
HTTP Guard). Pointing Claude Code at this plugin needs the user's own `~/.claude/settings.json` changed (or Claude
Code's plugin command), which is a verify-first item (§32.5 rule 3) and needs the user's consent first.

When it is installed by hand, uninstalling Mewndo takes it out again: `Mewndo.exe --remove-claude-hooks` (run by
the uninstaller) removes every hook whose command runs `mewndo-hook`, as well as the v0 entries, and keeps the rest
of the file, with a backup next to it.

## `hooks/hooks.fallback.json`

§33.10 Part C step 6: if a `PreToolUse` `"ask"` turns out **not** to raise a `PermissionRequest` hook, then
`PreToolUse` itself has to wait for the card, and its 5-second timeout is not enough. The fallback file adds a
second `PreToolUse` entry, with a 300-second timeout, matching only the tools that can need approval. Claude
Code then runs the `pre-tool` hook **twice** for those tools; the core recognises the duplicate (same session,
same tool, same input digest) and only one of the two waits.

Do not install both files. The fallback is off by default and switched on with the core setting
`claude.pre_tool_waits_for_card`, which is also what makes the core wait.
