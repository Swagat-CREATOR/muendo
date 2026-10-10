# Cursor samples — HAND-WRITTEN, UNVERIFIED

**Every file in this folder was written by hand. Not one of them came out of a running Cursor.**
There was no Cursor install on the machine these were made on, so there was nothing to capture.

Like `docs/samples/codex/`, this folder breaks §32.5 rule 2 — *"Never guess field names"* — on
purpose and in the open. Rule 2's own remedy is the forwarder's `--dump` mode (§33.10 Part B
step 4); until somebody runs it, `core/crates/mewndo-core/src/agents/cursor.rs` is code written
against a guess.

Cursor matters more than Codex here, because Cursor is the one agent where Mewndo **blocks** on its
own card: §33.10 Part F step 5 says Cursor's own "ask" opens a prompt Mewndo cannot answer, so when
the Router says ask, the hook waits for the Inbox card itself and returns allow or deny. A wrong
field name there is not a missed save point, it is a hook that waits and then says nothing.

## How to replace these with real ones

```powershell
$env:MEWNDO_DUMP_DIR = "$env:LOCALAPPDATA\Mewndo\dumps"
# Install integrations/cursor/hooks.json to %USERPROFILE%\.cursor\hooks.json with
# "--dump" added to each command line, then use Cursor normally: run a terminal
# command, call an MCP tool, and let one response finish.
# Copy what lands in %MEWNDO_DUMP_DIR%\cursor\ over the files here.
```

Then run `cargo test -p mewndo-core cursor` — the tests in `agents/cursor.rs` read these files, so a
real sample with different names fails a test instead of silently changing behaviour.

## What is guessed, exactly

| File | Field | Where the name came from | Risk if wrong |
|---|---|---|---|
| `before-shell-execution.json` | `command` | §33.10 Part F step 4 names the event; this is the obvious name and the only one a shell hook could have | the Router is asked about an empty command, which matches no rule, so a risky command is NOT denied. Fails open, never closed |
| | `cwd` | **guess** | the action is scoped to the forwarder's cwd instead, which is nearly always the same folder |
| | `conversation_id` | **guess.** Used as the agent id, so one Cursor conversation is one row in the Agents tab | the agent id falls back to `cursor-<pid>`, so two conversations look like two agents |
| | `generation_id` | **guess** | the card loses its turn id only |
| | `hook_event_name` | **guess.** Read for nothing: the event comes from argv | none |
| | `workspace_roots` | **guess** | none; recorded, not acted on |
| `before-mcp-execution.json` | `tool_name` | **guess** | the MCP call is guarded as an unknown tool |
| | `tool_input` | **guess** | same |
| | `server_name`, `url` | **guess** | the card does not say which MCP server asked |
| `after-agent-response.json` | `text` | **guess.** `cursor.rs` also accepts `message` and `response` | the Done-adjacent record has no body |
| `stop.json` | `status` | **guess** | none; recorded, not acted on |
| **output** | `permission`: `"allow"` / `"deny"` / `"ask"` | §33.10 Part F step 5 and §33.6 | **this is the dangerous one.** If Cursor does not read `permission`, a deny is ignored and the action runs |
| **output** | `agent_message` | matched to `mewndo-hook/src/failopen.rs::deny_json`, which Part B already landed, rather than to a second guess of my own | the deny is honoured but Cursor's model never learns why |
| **output** | `followup_message` | §33.10 Part F step 6, quoted verbatim in the spec | a reply typed on a Done card never reaches Cursor |
| **hooks.json** | `timeout_ms` per hook entry | **guess, and a §32.5 rule 3 verify-first item** ("Cursor's hook timeout field"). See `integrations/cursor/README.md` and the `docs/decisions.md` text in the Part F report | if the real field has another name, Cursor uses its own default timeout and may kill the hook while it is still waiting for the card. `cursor.rs` therefore has its own shorter deadline and does not rely on the config value |

### The names Mewndo does *not* guess

`cursor.rs` reads the command, the tool and the ids through a list of candidate spellings, in order,
and gives up rather than inventing meaning. A payload it cannot read produces **no output and
exit 0** (§32.5 rule 7), and it never prints an allow — not on a bad payload, not on a timeout, not
on a missing Inbox.

## Not captured, and why

- **A real `beforeShellExecution` deny being honoured, and a real `followup_message` being sent.**
  Both need a live Cursor to read the output back. Part F's "Done when" asks for one real run with
  each agent; the harness half is done and the real half is not.
- **Cursor's own timeout behaviour when a hook takes 30 s.** This is what decides whether the
  waiting-for-a-card design in step 5 works at all. Unverified.
