# Codex CLI samples — HAND-WRITTEN, UNVERIFIED

**Every file in this folder was written by hand. Not one of them came out of a running Codex CLI.**
There was no Codex CLI on the machine these were made on, and no credentials to run one, so
there was nothing to capture.

This folder is the one place in the build where §32.5 rule 2 — *"Never guess field names"* — was
broken, and it is broken on purpose rather than quietly. Rule 2's own instruction is to capture a
real payload with the forwarder's `--dump` mode before writing a parser. That mode exists
(`mewndo-hook --dump`, §33.10 Part B step 4) and is the right way to replace this folder. Until
somebody runs it, treat every field name below as a guess, and treat
`core/crates/mewndo-core/src/agents/codex.rs` as code written against a guess.

## How to replace these with real ones

```powershell
# 1. Point the dump at a folder you can read.
$env:MEWNDO_DUMP_DIR = "$env:LOCALAPPDATA\Mewndo\dumps"

# 2. Install the hooks and the notify line with --dump added to every command line.
#    integrations/codex/hooks.json and integrations/codex/config.snippet.toml are the
#    starting point; add "--dump" to each argument list.

# 3. Use Codex normally for a few minutes: run a shell command, let it ask for
#    permission once, deny it once, and let one turn finish.

# 4. Copy what landed in $env:MEWNDO_DUMP_DIR\codex\ over the files here, keep the
#    "_mewndo_sample" line, change it to say which Codex version produced it, and
#    delete the "guessed" table below for every name the real payload confirms.
```

Then run `cargo test -p mewndo-core codex` — the tests in `agents/codex.rs` read these files, so a
real sample with different field names fails a test instead of silently changing behaviour.

## What is guessed, exactly

`notify` is the one event with a shape worth believing: the Codex CLI's
`notify` setting is documented as an external program called with a single JSON argument, and the
argument has a `type` of `agent-turn-complete` carrying the last assistant message. The *spelling*
of those keys is still unverified here.

The four hook events are guessed much harder. §33.10 Part F names the events
(`PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`) and §33.6 names what they do, but the
payload field names are taken from Claude Code's hook format on the assumption that Codex followed
it. That assumption may be wrong in every detail.

| File | Field | Where the name came from | Risk if wrong |
|---|---|---|---|
| `notify-agent-turn-complete.json` | `type` | Codex `notify` docs, `"agent-turn-complete"` | the Done card is not made; no output either way, so Codex is unaffected |
| | `last-assistant-message` | Codex `notify` docs (hyphenated) | the Done card has an empty body. `codex.rs` also accepts `last_assistant_message` and `lastAssistantMessage` |
| | `turn-id` | Codex `notify` docs | the card loses its turn id only |
| | `input-messages` | Codex `notify` docs | the card title falls back to the agent id |
| | `cwd` | **guess.** Not in the docs; the forwarder supplies its own `cwd` on `hook.request`, which is what is actually used | nothing: `codex.rs` prefers `HookRequest.cwd` |
| `pre-tool-shell.json` | `tool_name` | **guess**, copied from Claude Code | the Router is asked about an unknown tool, which cannot match a command rule, so a risky command is NOT denied. Fails open, never closed |
| | `tool_input` | **guess**, copied from Claude Code | same |
| | `tool_input.command` **as an array** | Codex's `shell` tool takes argv, not a shell string. This is the one place the schema is believed to differ from Claude's, and `codex.rs` is where it is mapped | a command the rules would deny is not seen as that command |
| | `tool_input.workdir` | **guess.** Codex's shell tool names its directory `workdir`, not `cwd` | the action is scoped to the forwarder's cwd instead |
| | `session_id` | §38.5 lists it on `hook.request`; the forwarder reads it out of the payload under exactly this name | the agent id falls back to the pid |
| | `hook_event_name` | **guess**, copied from Claude Code. Read for nothing: the event comes from argv | none |
| `permission-request.json` | `tool_use_id` | **guess**, copied from Claude Code | the card cannot be tied to one tool call |
| | `permission_mode` | **guess**, copied from Claude Code | none; recorded, not acted on |
| `post-tool.json` | `tool_response` | **guess**, copied from Claude Code | the Done card and the Receipt (§35) lose the command's output |
| | `tool_response.exit_code` | **guess** | a failed command is not recorded as failed |
| `stop.json` | `last_assistant_message` | **guess** | the Done card has an empty body |
| | `stop_hook_active` | **guess**, copied from Claude Code's loop guard | without it a `Stop` handler that blocked could loop. `codex.rs` never blocks on `Stop`, so it cannot |

### The names Mewndo does *not* guess

`codex.rs` reads the tool name and the tool input through a list of candidate spellings, in order,
and gives up rather than inventing meaning: a payload it cannot read produces **no output and
exit 0**, so Codex behaves exactly as if Mewndo were not installed (§32.5 rule 7). The one thing it
will never do on an unreadable payload is print an allow.

## Not captured, and why

- **A real `PermissionRequest` deny being honoured.** That needs a live Codex to read the output
  back. Part F's "Done when" asks for one real run; the harness half is done and the real half is
  not. See `core/crates/mewndo-core/src/agents/codex.rs`, the module comment.
- **Whether Codex's `Stop` hook can continue a turn.** §33.6 makes the reply window conditional on
  the fake-agent harness confirming it. It is not confirmed, so `Stop` here makes a Done card and
  returns nothing. No reply window for Codex.
