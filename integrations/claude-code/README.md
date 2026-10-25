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

**Connecting it.** The app's Connect buttons (Agents screen, and step 3 of the first run) install it:
`apps/desktop/engine/agent-connect.js` writes the hooks of `hooks/hooks.json` into the user's
`~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR`), with `${CLAUDE_PLUGIN_ROOT}/bin/mewndo-hook.exe` replaced by the
installed `resources\claude-code\bin\mewndo-hook.exe`, quoted, with forward slashes. It shows the exact change and
asks first, keeps a timestamped backup next to the file, keeps every other hook and setting, and changes nothing
when run twice. It takes out the v0 hooks (the save-point script and the HTTP Guard): `UserPromptSubmit` asks the
v0 engine for a save point every turn, and the core's Router is the guard. It refuses when `mewndo-hook.exe` is
missing, and when the settings file is a link. The same buttons install the Codex and Cursor hooks
(`integrations/codex`, `integrations/cursor`). It writes the hooks into the settings file rather than installing
this folder as a Claude Code plugin; `hooks/hooks.fallback.json` is never installed by it.

The same dialog removes them again, and uninstalling Mewndo takes them out too: `Mewndo.exe --remove-claude-hooks`
(run by the uninstaller) removes every hook whose command runs `mewndo-hook`, as well as the v0 entries, from
Claude Code's, Codex's and Cursor's files, puts back a Codex `notify` it had set aside, and keeps the rest, with a
backup next to each file.

## `hooks/hooks.fallback.json`

§33.10 Part C step 6: if a `PreToolUse` `"ask"` turns out **not** to raise a `PermissionRequest` hook, then
`PreToolUse` itself has to wait for the card, and its 5-second timeout is not enough. The fallback file adds a
second `PreToolUse` entry, with a 300-second timeout, matching only the tools that can need approval. Claude
Code then runs the `pre-tool` hook **twice** for those tools; the core recognises the duplicate (same session,
same tool, same input digest) and only one of the two waits.

Do not install both files. The fallback is off by default and switched on with the core setting
`claude.pre_tool_waits_for_card`, which is also what makes the core wait.
