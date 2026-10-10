// Codex CLI: hooks plus `notify` for agent-turn-complete (spec §33.10 Part F, §33.6).
//
// Four hook events and one notifier, and only one of them is ever allowed to change what Codex does:
//
//   pre-tool     PreToolUse        Router -> deny, or nothing
//   permission   PermissionRequest Router -> deny, or nothing (Codex's own approval flow then runs)
//   post-tool    PostToolUse       recorded; never any output
//   stop         Stop              a Done card; never any output, and never a reply window (see below)
//   notify       agent-turn-complete, carrying the last assistant message -> a Done card
//
// **The rule this file is built around: any deny wins, and this file never prints an allow.**
//
// §33.6's Codex row says "any deny wins; otherwise Codex's normal approval flow". So the handler has exactly
// two outputs: a deny, or silence. There is no code path here that writes `"permissionDecision": "allow"`,
// which means no bug in it -- a guessed field name read wrong, an unparsable payload, a missing Router -- can
// turn into Mewndo approving something on the user's behalf. "Any deny wins" is then literally true: Mewndo's
// deny beats Codex's allow because it is printed, and Codex's deny beats Mewndo's silence because Mewndo said
// nothing. [`any_deny_wins`] applies the same rule to a payload that carries several actions at once.
//
// **What this file cannot do, honestly (§28.10, §32.5 rule 5).**
//
//  1. *Every field name it reads is a guess.* There was no Codex CLI to capture a payload from, so
//     `docs/samples/codex/` is hand-written and `docs/samples/codex/README.md` lists each guessed name and
//     what goes wrong if it is wrong. §32.5 rule 2 forbids exactly this, and this is the one place in the
//     build where it was unavoidable. Everything is read through a list of candidate spellings
//     ([`TOOL_NAME_KEYS`] and friends) and a payload that matches none of them produces **no output and exit
//     0** (§32.5 rule 7) rather than a guess at what the agent meant.
//  2. *No reply window on `Stop`.* §33.6 makes it conditional: "Use the reply window only if the fake agent
//     harness confirms Codex's `Stop` hook can continue a turn". It has not been confirmed, so `Stop` makes a
//     Done card and returns nothing. Messaging Codex after it finishes works only in a Mewndo lane (§33.7,
//     Part G).
//  3. *No real run.* Part F's "Done when" is "the card tests pass for Codex and Cursor in the harness, plus
//     one real run with each". The harness half is here. The real run has not happened.
//  4. *The schema difference is mapped here and nowhere else*, as Part F step 3 asks. Codex's `shell` tool
//     passes `command` as an argv array where Claude's `Bash` passes one string, and
//     `mewndo_router::normalize` wants the string ([`command_text`]). That is the only mapping, and it is in
//     this file so that Codex changing its hook format can never reach `agents/claude.rs`.
//
// The output *shape* is not this file's invention and must not be changed here alone: the hook forwarder
// prints the same shape from its own deny cache when the core is down
// (`core/crates/mewndo-hook/src/failopen.rs::deny_json`). Both print at the same Codex, so both must agree
// byte for byte. Change the two together.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "§33.10 Part F builds the handler; desk.rs wires `hook.request` to it in Part A's `respond`, \
                  and main.rs wires `config-merge`. Until those two lines land nothing here has a caller."
    )
)]

use mewndo_inbox::{Card, CardKind, Inbox, PermissionFacts};
use mewndo_proto::{HookRequest, HookResponse};
use mewndo_router::{GuardInput, Mode, Router, Verdict};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// `argv[2]` for each event, as `integrations/codex/hooks.json` and `config.snippet.toml` spell it. The
/// forwarder passes these through untouched (`mewndo-hook/src/args.rs`), and `mewndo-hook`'s own
/// `failopen::is_pre_action` already knows `pre-tool`, so the names are not free to change.
pub const PRE_TOOL: &str = "pre-tool";
pub const PERMISSION: &str = "permission";
pub const POST_TOOL: &str = "post-tool";
pub const STOP: &str = "stop";
pub const NOTIFY: &str = "notify";

/// The `type` of the one `notify` payload Mewndo acts on (`docs/samples/codex/notify-*.json`).
pub const TURN_COMPLETE: &str = "agent-turn-complete";

// --- the guessed field names, all in one place --------------------------------------------------------------------
//
// Every list is tried in order and the first hit wins. They are `const` and public so that the tests, and
// `docs/samples/codex/README.md`, name the same strings the code reads: a sample captured from a real Codex
// that disagrees fails a test here instead of quietly changing what the Router is asked about.

/// Which tool Codex is about to run. `tool_name` is Claude Code's spelling and the most likely one; the rest
/// are the plausible alternatives.
pub const TOOL_NAME_KEYS: &[&str] = &["tool_name", "tool", "toolName", "name"];
/// That tool's arguments.
pub const TOOL_INPUT_KEYS: &[&str] = &["tool_input", "arguments", "toolInput", "input", "params"];
/// The shell command inside the tool's arguments. A **string or an array of strings** -- see [`command_text`].
pub const COMMAND_KEYS: &[&str] = &["command", "cmd", "argv", "script"];
/// The folder the shell tool would run in. Codex's shell tool is believed to call this `workdir`.
pub const WORKDIR_KEYS: &[&str] = &["workdir", "cwd", "working_dir", "workingDirectory"];
/// What Codex last said. The hyphenated spelling is the documented `notify` one; the other two are the
/// spellings a hook payload would plausibly use instead.
pub const LAST_MESSAGE_KEYS: &[&str] = &[
    "last-assistant-message",
    "last_assistant_message",
    "lastAssistantMessage",
];
/// What the user asked for, as `notify` reports it: an array of strings.
pub const INPUT_MESSAGES_KEYS: &[&str] = &["input-messages", "input_messages", "inputMessages"];
/// Codex's own id for the finished turn.
pub const TURN_ID_KEYS: &[&str] = &["turn-id", "turn_id", "turnId"];

/// How long a card made from `Stop` or `notify` stays answerable. §33.2 gives a Done card a 15 s reply
/// window; Codex has no reply window (limit 2 above), so the card is simply a Done card the user may read,
/// and it expires on the Inbox's own default rather than holding anything open.
const DONE_RISK: u8 = 1;

/// A string under the first of `keys` that the object actually has. Anything that is not a string -- a
/// number, an object, null -- is not coerced: §32.5 rule 2's point is that a payload we do not understand is
/// to be left alone, not reinterpreted.
fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
}

/// The value under the first of `keys` that the object has.
fn first_val<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k))
}

// --- the one schema difference Part F step 3 asks to be mapped here ----------------------------------------------

/// Codex's shell tool as one command string.
///
/// This is the whole of the "if it differs from Claude's, map it in `codex.rs` only" clause. Claude Code's
/// `Bash` tool passes `{"command": "rm -rf build && npm run build"}`; Codex's `shell` tool is believed to
/// pass argv, `{"command": ["bash", "-lc", "rm -rf build && npm run build"]}`. `mewndo_router::normalize`
/// reads `command` as a string (`normalize.rs`, `first_str(input, &["command", ...])`), so an array would
/// normalize to an empty command -- which matches no deny rule, so a `rm -rf` would sail past the rules.
/// Flattening it here is therefore not cosmetic: it is the difference between the rules seeing the command
/// and not seeing it.
///
/// `["bash", "-lc", "<script>"]` is flattened to the script alone when the wrapper is a shell with a
/// read-from-argument flag, because `bash -lc "rm -rf /"` and `rm -rf /` are the same action and the rules,
/// the signature (§34.9 R4) and the habit counter (§34.7) must not see them as two. Anything else is joined
/// with spaces.
pub fn command_text(input: &Value) -> Option<String> {
    let raw = first_val(input, COMMAND_KEYS)?;
    let text = match raw {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            // Every element must be a string. A mixed array is a payload we do not understand.
            let mut parts: Vec<&str> = Vec::with_capacity(items.len());
            for item in items {
                parts.push(item.as_str()?);
            }
            unwrap_shell(&parts)
        }
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `["bash","-lc","<script>"]` -> `<script>`; `["git","push","--force"]` -> `git push --force`.
///
/// Only the exact `<shell> <read-from-argument flag> <one script>` shape is unwrapped, and only when there is
/// nothing after the script: `bash -lc "a" extra` keeps its arguments, because `$0` and `$1` change what the
/// script means and dropping them would show the user a command that is not the one that would run.
fn unwrap_shell(parts: &[&str]) -> String {
    const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash", "ash", "ksh"];
    const READS_ARG: &[&str] = &["-c", "-lc", "-cl", "-ic", "-lic"];
    if let [shell, flag, script] = parts {
        let base = Path::new(shell)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(shell)
            .to_ascii_lowercase();
        if SHELLS.contains(&base.as_str())
            && READS_ARG.contains(&flag.to_ascii_lowercase().as_str())
        {
            return (*script).to_string();
        }
    }
    parts.join(" ")
}

// --- what the handler is allowed to print ------------------------------------------------------------------------

/// The deny Codex reads. Verified, not guessed: Codex 0.156.1 ships the JSON schemas of its hook outputs
/// (`docs/samples/codex/schema/hook-schemas.json`, docs/decisions.md "Codex hook output schema"). Both are Claude
/// Code's shapes, nested in `hookSpecificOutput`, and both refuse unknown fields (`additionalProperties: false`),
/// so a field outside them makes the whole answer invalid. `PreToolUse` is byte for byte the shape of
/// `mewndo-hook/src/failopen.rs::deny_json("codex", …)`; the two must change together.
///
/// Exit code 0, not 2. The decision travels in the JSON, and a bare exit 2 carries no reason the model can
/// read; `failopen.rs` made the same call and the two must not disagree about the exit code either.
pub fn deny_json(event: &str, reason: &str) -> String {
    let inner = if event == PERMISSION {
        serde_json::json!({
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "deny", "message": reason},
        })
    } else {
        serde_json::json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        })
    };
    serde_json::json!({ "hookSpecificOutput": inner }).to_string()
}

/// Silence: exactly what the agent sees when Mewndo is not installed (§32.5 rule 7).
fn silent() -> HookResponse {
    HookResponse {
        stdout: String::new(),
        exit_code: 0,
    }
}

fn deny(event: &str, reason: &str) -> HookResponse {
    HookResponse {
        stdout: deny_json(event, reason),
        exit_code: 0,
    }
}

/// §33.6's "any deny wins", as a function over the verdicts for one hook event.
///
/// One Codex payload can describe more than one action -- an argv array of several commands, a patch
/// touching several files -- and each is guarded separately. The event has one answer, so: **if any action
/// was denied or braked, the event is denied**, whatever the others said. An empty list, or a list with no
/// deny in it, returns `None`, which this file turns into silence rather than an allow.
///
/// `Brake` counts as a deny because §24 freezes the session: the action must not run, and Codex has no
/// vocabulary for "frozen", so it is told no with the brake's reason.
pub fn any_deny_wins(verdicts: &[Verdict]) -> Option<usize> {
    verdicts
        .iter()
        .position(|v| matches!(v, Verdict::Deny | Verdict::Brake))
}

// --- what the core supplies --------------------------------------------------------------------------------------

/// The session facts the Router needs that a hook payload does not carry: the brief the user wrote (§34.1),
/// which project this is, and what the agent did last.
///
/// The core owns all four, and until it does the defaults are honest rather than invented: no brief means the
/// scope is the working folder (`mewndo_router::Scope::from_brief`), and `Mode::Shadow` is §34.6's "every
/// agent starts in shadow", so a half-wired core cannot start blocking things.
#[derive(Debug, Clone, Default)]
pub struct Session {
    pub brief: String,
    pub project: String,
    pub recent: Vec<String>,
    pub mode: Mode,
}

/// The handler. Holds what it needs from the core and nothing else, so a test can build one.
///
/// `inbox` is an `Option` on purpose: a core with no Inbox yet must still guard actions. Without one, `Stop`
/// and `notify` record nothing and still print nothing, which is the same thing Codex sees today.
pub struct Codex {
    pub router: Arc<Router>,
    pub inbox: Option<Inbox>,
    pub session: Session,
}

impl Codex {
    pub fn new(router: Arc<Router>, inbox: Option<Inbox>) -> Codex {
        Codex {
            router,
            inbox,
            session: Session::default(),
        }
    }

    /// One hook event in, one thing to print out.
    ///
    /// Never panics and never prints an allow. An event name it does not know, a payload it cannot read, a
    /// Router that decided anything other than deny: all silence.
    pub async fn handle(&self, req: &HookRequest) -> HookResponse {
        match event_name(&req.event) {
            Some(PRE_TOOL) | Some(PERMISSION) => self.guard(req),
            // §33.10 B5's reasoning in reverse: a deny after the fact is pointless. The event is worth
            // recording against the trace (§35) but there is nothing to say back.
            Some(POST_TOOL) => silent(),
            Some(STOP) => {
                self.done(req, first_str(&req.payload, LAST_MESSAGE_KEYS))
                    .await
            }
            Some(NOTIFY) => self.notify(req).await,
            _ => silent(),
        }
    }

    /// `PreToolUse` and `PermissionRequest`: ask the Router, print a deny or nothing.
    fn guard(&self, req: &HookRequest) -> HookResponse {
        let Some(actions) = self.actions(req) else {
            // No tool name, or a tool input we cannot read. The guessed field names did not match, so Mewndo
            // does not know what Codex is about to do -- and says nothing rather than guess (limit 1).
            return silent();
        };
        let mut verdicts = Vec::with_capacity(actions.len());
        let mut reasons = Vec::with_capacity(actions.len());
        for input in &actions {
            let guarded = self.router.guard(input);
            verdicts.push(guarded.decision.verdict);
            reasons.push(guarded.decision.reason);
        }
        match any_deny_wins(&verdicts) {
            Some(i) => deny(event_name(&req.event).unwrap_or(PRE_TOOL), &reasons[i]),
            // Allow, savepoint-then-allow and ask all land here. Codex's own approval flow runs, which is
            // what §33.6 asks for, and Mewndo has printed no allow it was not given.
            None => silent(),
        }
    }

    /// The Router calls this one event needs, or None when the payload could not be read.
    ///
    /// One per action: today that is always one, because one `PreToolUse` is one tool call. It is a `Vec` so
    /// that [`any_deny_wins`] has something real to be a rule about the moment a payload arrives carrying
    /// several -- which is the shape §33.6's "any deny wins" is written for.
    fn actions(&self, req: &HookRequest) -> Option<Vec<GuardInput>> {
        let tool = first_str(&req.payload, TOOL_NAME_KEYS)?;
        let raw = first_val(&req.payload, TOOL_INPUT_KEYS).unwrap_or(&Value::Null);
        let hook_cwd = req.cwd.as_deref().unwrap_or_default();
        let cwd = PathBuf::from(
            // The tool's own folder if it named one, else the folder the forwarder ran in.
            raw.as_object()
                .and_then(|_| first_str(raw, WORKDIR_KEYS))
                .unwrap_or(hook_cwd),
        );

        // The mapping of limit 4: an argv `command` becomes the string the Router reads. Only `command` is
        // rewritten; every other argument travels exactly as Codex sent it, because rewriting a field we
        // guessed the name of is how a guess turns into a wrong decision.
        let input = match command_text(raw) {
            Some(text) => {
                let mut obj = raw.as_object().cloned().unwrap_or_default();
                obj.insert("command".into(), Value::String(text));
                Value::Object(obj)
            }
            None => raw.clone(),
        };

        Some(vec![GuardInput {
            agent_kind: "codex".into(),
            tool: tool.to_string(),
            input,
            cwd,
            brief: self.session.brief.clone(),
            project: self.session.project.clone(),
            recent: self.session.recent.clone(),
            mode: self.session.mode,
        }])
    }

    /// `notify`, the one event §33.6 singles out: "`notify` for agent-turn-complete, which carries the last
    /// assistant message".
    ///
    /// Only `agent-turn-complete` makes a card. A `notify` of some other type is a Codex event Mewndo has no
    /// sample of, and §32.5 rule 2 says not to invent a meaning for it.
    async fn notify(&self, req: &HookRequest) -> HookResponse {
        if req.payload.get("type").and_then(Value::as_str) != Some(TURN_COMPLETE) {
            return silent();
        }
        self.done(req, first_str(&req.payload, LAST_MESSAGE_KEYS))
            .await
    }

    /// §33.2's Done card. No reply window (limit 2): the receiver is dropped at once, so nothing waits on an
    /// answer that Codex could not be told about anyway.
    async fn done(&self, req: &HookRequest, message: Option<&str>) -> HookResponse {
        let Some(inbox) = self.inbox.as_ref() else {
            return silent();
        };
        inbox.create(self.done_card(req, message)).await;
        silent()
    }

    /// The card itself, separated from `done` so a test can read it without running an Inbox actor.
    fn done_card(&self, req: &HookRequest, message: Option<&str>) -> Card {
        let title = first_val(&req.payload, INPUT_MESSAGES_KEYS)
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find_map(Value::as_str))
            .map(one_line)
            .unwrap_or_else(|| "Codex finished".to_string());
        let mut card = Card::new(
            CardKind::Done,
            agent_id(req),
            title,
            // The last assistant message is the body: it is the one thing §33.6 promises this event carries,
            // and it is what the user reads instead of going to find Codex's window.
            message
                .unwrap_or("Codex finished its turn. It said nothing Mewndo could read.")
                .trim(),
        );
        card.risk = DONE_RISK;
        card.trace_id = first_str(&req.payload, TURN_ID_KEYS).map(str::to_string);
        card
    }
}

/// The agent this event belongs to, and the whole of §33.10 Part F step 8's `MEWNDO_LANE_ID` handling.
///
/// A lane id beats a session id. When the core started Codex inside a Mewndo lane (§33.7, Part G) the
/// forwarder inherits `MEWNDO_LANE_ID` from that lane's environment (`mewndo-pty/src/launch.rs`) and puts it
/// on `hook.request`. The lane *is* the agent session: keying the card on it means the lane's terminal output
/// and the lane's hook events land on one agent in the Agents tab, and it is what lets Part G find the
/// terminal to write a reply into -- the one way §33.6 allows messaging Codex after it finishes.
///
/// Without a lane, a Codex-reported session id; without that, the forwarder's pid, so that two terminals are
/// still two agents.
pub fn agent_id(req: &HookRequest) -> String {
    if let Some(lane) = req
        .lane_id
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        return format!("lane:{lane}");
    }
    if let Some(session) = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return format!("codex:{session}");
    }
    match req.pid {
        Some(pid) => format!("codex:pid-{pid}"),
        None => "codex:unknown".to_string(),
    }
}

/// The event this is, accepting both the short argv name and Codex's own hook event name, because a user who
/// edits `hooks.json` by hand may well write either. Unknown names are None, never a default.
fn event_name(event: &str) -> Option<&'static str> {
    match event.trim().to_ascii_lowercase().as_str() {
        "pre-tool" | "pretool" | "pretooluse" => Some(PRE_TOOL),
        "permission" | "permission-request" | "permissionrequest" => Some(PERMISSION),
        "post-tool" | "posttool" | "posttooluse" => Some(POST_TOOL),
        "stop" => Some(STOP),
        "notify" => Some(NOTIFY),
        _ => None,
    }
}

/// A card title is one line. A pasted stack trace is not.
fn one_line(s: &str) -> String {
    let mut out: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 90 {
        out = out.chars().take(89).collect::<String>() + "\u{2026}";
    }
    out
}

/// Unused today, and here because a permission card for Codex needs it the moment Part E can show one: the
/// Router hands back the signature and the normalized command, and §34.7's habit counter needs both at
/// release, long after this call has returned.
fn facts(sig: mewndo_router::Sig, command_norm: String, project: String) -> PermissionFacts {
    PermissionFacts {
        agent_kind: "codex".to_string(),
        project,
        action_sig: sig,
        command_norm,
    }
}

// === the config.toml merge the Connect page needs =================================================================
//
// §33.10 Part F step 2: "The Connect page merges the user's `config.toml` without losing comments, using a
// `mewndo-core.exe config-merge` subcommand built on `toml_edit`."
//
// **There is no `toml_edit` here, and this does not need one.** The workspace pins `toml` 1.1.8 (and not even
// that is a dependency of this crate), and a build this file is one of five parallel pieces of may not edit
// `core/Cargo.toml`. More to the point, a parser-and-serializer round trip is the wrong tool for the job: a
// `toml` round trip drops every comment and reorders and respaces everything it did not touch, which is the
// one thing step 2 forbids, and even `toml_edit` reformats more than it is asked to.
//
// So the merge is a **pure function over the file text**. It changes the bytes it must and copies every other
// byte through unaltered -- comments, blank lines, key order, CRLF, inline tables, the user's own spacing. It
// is `(&str, &Path) -> Result<String>`, so there is no file in the test and no file in the function: the
// caller writes the result to a temp file and renames it into place (plot.md rule 4), and keeps the original
// as the backup P5.2 asks for.
//
// Honest limits. This is a line scanner, not a TOML parser:
//
//  * It does not validate TOML. A file that was already invalid stays invalid.
//  * It refuses rather than guesses when it cannot tell code from text: a file that ends inside a multi-line
//    string, or one over [`MERGE_CAP`], returns `Err` and the Connect page shows the snippet to paste by
//    hand. Refusing is the only safe failure for a function that rewrites a file the user owns.
//  * It only ever looks at the **top-level** table for `notify`, because `notify` is a top-level key. A
//    `notify` inside `[profiles.work]` is a different key and is left completely alone.

/// Biggest config.toml the merge will touch. A real one is a few kilobytes; past this something is wrong and
/// refusing beats rewriting it.
pub const MERGE_CAP: usize = 1024 * 1024;

/// The marker lines. Everything Mewndo adds sits between them and nothing outside them is ever changed, which
/// is what makes [`merge_notify`] idempotent and [`remove_notify`] exact.
pub const BLOCK_BEGIN: &str = "# mewndo:begin";
pub const BLOCK_END: &str = "# mewndo:end";
/// A line of the user's own `notify`, kept verbatim so uninstall can put it back.
pub const WAS_PREFIX: &str = "# mewndo:was ";
/// Inside the block when install had to end the user's last line, so uninstall can take that newline out again.
pub const ADDED_NEWLINE: &str = "# mewndo:added-final-newline";
const BEGIN_LINE: &str =
    "# mewndo:begin  Added by the Mewndo Connect page (spec §33.10 Part F step 2).";
const BEGIN_HELP: &str = "#   Removing this block, or running `mewndo-core config-merge --remove`, restores what was here before.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeError {
    /// The file ends inside a `\"\"\"` or `'''` string, so the scanner cannot tell code from text.
    Unterminated,
    /// Over [`MERGE_CAP`].
    TooBig(usize),
    /// A `notify` key whose value never finishes: an unclosed `[`.
    UnfinishedValue,
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::Unterminated => write!(
                f,
                "config.toml ends inside a multi-line string, so Mewndo cannot tell which parts are text. \
                 Nothing was changed."
            ),
            MergeError::TooBig(n) => write!(
                f,
                "config.toml is {n} bytes, over Mewndo's {MERGE_CAP}-byte limit for editing it. Nothing was \
                 changed."
            ),
            MergeError::UnfinishedValue => write!(
                f,
                "config.toml has a `notify` value that is never closed. Nothing was changed."
            ),
        }
    }
}

impl std::error::Error for MergeError {}

/// A TOML basic string: the only escapes TOML requires, and nothing else touched.
///
/// A Windows path is why this exists at all: `C:\Users\ana\AppData\Local\Mewndo\bin\mewndo-hook.exe` has to
/// reach the file as `"C:\\Users\\ana\\…"`, and getting that wrong gives Codex a path with `\U` and `\A`
/// escapes in it.
pub fn toml_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04X}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// §33.10 Part F step 2, verbatim: `notify = ["<abs path>\\mewndo-hook.exe", "codex", "notify"]`.
pub fn notify_line(exe: &Path) -> String {
    format!(
        "notify = [{}, \"codex\", \"{NOTIFY}\"]",
        toml_string(&exe.to_string_lossy())
    )
}

/// Add Mewndo's `notify` to the user's config.toml, keeping every comment and every other byte.
///
/// Defined as **unmerge, then insert**, which is what makes installing twice change nothing: the first step
/// restores the file to exactly what it was before any Mewndo block, so the second always has the same input.
/// `merge(merge(x)) == merge(x)` and `remove(merge(x)) == x`, both pinned by tests.
pub fn merge_notify(text: &str, exe: &Path) -> Result<String, MergeError> {
    if text.len() > MERGE_CAP {
        return Err(MergeError::TooBig(text.len()));
    }
    let clean = remove_notify(text)?;
    let nl = if clean.contains("\r\n") || (clean.is_empty() && cfg!(windows)) {
        "\r\n"
    } else {
        "\n"
    };
    let lines = logical_lines(&clean)?;

    let mut block = String::new();
    block.push_str(BEGIN_LINE);
    block.push_str(nl);
    block.push_str(BEGIN_HELP);
    block.push_str(nl);

    // Where the block goes, and what it has to carry with it.
    let (at, replaced) = match find_notify(&clean, &lines)? {
        // The user already has a top-level `notify`. Their line -- with its own trailing comment, and every
        // line of it if the value spans several -- is kept verbatim as `# mewndo:was` so that uninstall puts
        // it back exactly. Commenting it out is the only way both can be true at once: Codex takes one
        // `notify`, and the user's must not be lost.
        Some(span) => (span.clone(), Some(clean[span].to_string())),
        // No `notify` yet: the end of the top-level table, which is where a top-level key has to go. After
        // the first `[table]` header it would belong to that table instead.
        None => (
            top_level_end(&clean, &lines)..top_level_end(&clean, &lines),
            None,
        ),
    };
    if let Some(original) = &replaced {
        for line in original.split_inclusive('\n') {
            block.push_str(WAS_PREFIX);
            block.push_str(line.trim_end_matches(['\r', '\n']));
            block.push_str(nl);
        }
    }
    block.push_str(&notify_line(exe));
    block.push_str(nl);
    block.push_str(BLOCK_END);
    block.push_str(nl);

    let mut out = String::with_capacity(clean.len() + block.len() + 2);
    out.push_str(&clean[..at.start]);
    // A block inserted at the end of a file that does not end in a newline would otherwise join the last line.
    // The block says so, so uninstall gives back the file without it.
    if at.start == clean.len() && !clean.is_empty() && !clean.ends_with('\n') {
        out.push_str(nl);
        block.insert_str(
            block.len() - BLOCK_END.len() - nl.len(),
            &format!("{ADDED_NEWLINE}{nl}"),
        );
    }
    out.push_str(&block);
    out.push_str(&clean[at.end..]);
    Ok(out)
}

/// Take Mewndo's block out again and put the user's own `notify` back, exactly as it was.
///
/// Also the uninstall P5.2 asks for, and safe to run on a file that has no block: it returns the text
/// unchanged, so the Connect page can call it without first working out whether Mewndo is installed.
pub fn remove_notify(text: &str) -> Result<String, MergeError> {
    if text.len() > MERGE_CAP {
        return Err(MergeError::TooBig(text.len()));
    }
    let lines = logical_lines(text)?;
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < lines.len() {
        let line = &lines[i];
        if !line.in_string
            && text[line.start..line.end]
                .trim_start()
                .starts_with(BLOCK_BEGIN)
        {
            // Inside a block: keep only the user's own lines, unwrapped from their `# mewndo:was` prefix.
            let mut added_newline = false;
            let mut j = i + 1;
            while j < lines.len() {
                let inner = &lines[j];
                let raw = &text[inner.start..inner.end];
                let trimmed = raw.trim_start();
                if trimmed.starts_with(BLOCK_END) {
                    break;
                }
                if trimmed.starts_with(ADDED_NEWLINE) {
                    added_newline = true;
                }
                if let Some(rest) = trimmed.strip_prefix(WAS_PREFIX) {
                    out.push_str(rest.trim_end_matches(['\r', '\n']));
                    // The line terminator the file was using, not one invented here.
                    out.push_str(if raw.ends_with("\r\n") {
                        "\r\n"
                    } else if raw.ends_with('\n') {
                        "\n"
                    } else {
                        ""
                    });
                }
                j += 1;
            }
            // Past the end marker, if it is there; an unterminated block still ends at the last line, so a
            // half-written file cannot make this loop stall.
            i = if j < lines.len() { j + 1 } else { j };
            if added_newline {
                let cut = if out.ends_with("\r\n") {
                    2
                } else {
                    usize::from(out.ends_with('\n'))
                };
                out.truncate(out.len() - cut);
            }
            continue;
        }
        out.push_str(&text[line.start..line.end]);
        i += 1;
    }
    Ok(out)
}

// --- the line scanner -------------------------------------------------------------------------------------------

/// One physical line, with whether it began inside a multi-line string. `start..end` includes the line's own
/// terminator, so the lines of a file concatenate back into exactly that file.
#[derive(Debug, Clone, Copy)]
struct Ln {
    start: usize,
    end: usize,
    /// True when the line began inside a `"""` or `'''` string. Such a line is text, not code: nothing in it
    /// is a table header or a key, however much it looks like one.
    in_string: bool,
}

/// Split the text into lines and work out, for each, whether it starts inside a multi-line string.
///
/// This is the whole reason the merge can be trusted with a file it did not write: a `notify = ...` sitting
/// inside a `description = """ … """` is text, and a scanner that did not track strings would rewrite it.
fn logical_lines(text: &str) -> Result<Vec<Ln>, MergeError> {
    let mut lines = Vec::new();
    let mut state: Option<char> = None;
    let mut start = 0usize;
    for (end, raw) in line_spans(text) {
        lines.push(Ln {
            start,
            end,
            in_string: state.is_some(),
        });
        state = after_line(raw, state);
        start = end;
    }
    if state.is_some() {
        return Err(MergeError::Unterminated);
    }
    Ok(lines)
}

/// `(end_offset_including_terminator, line_text_including_terminator)` for every line.
fn line_spans(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < text.len() {
        let end = match text[at..].find('\n') {
            Some(i) => at + i + 1,
            None => text.len(),
        };
        out.push((end, &text[at..end]));
        at = end;
    }
    out
}

/// The multi-line-string state after this line, given the state before it.
///
/// Walks the line honouring, in this order: an open multi-line string, `#` comments, `"""`/`'''` openers, and
/// single-line `"`/`'` strings. A single-line string that is not closed on its line is invalid TOML; the walk
/// stops at the end of the line and leaves the state alone rather than pretending to understand it.
fn after_line(line: &str, mut state: Option<char>) -> Option<char> {
    let b = line.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match state {
            Some(q) => {
                let quote = q as u8;
                // In a `"""` string a backslash escapes the next byte, so `\"""` is not a terminator. `'''`
                // has no escapes at all.
                if quote == b'"' && b[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if b[i] == quote && b[i..].len() >= 3 && b[i + 1] == quote && b[i + 2] == quote {
                    state = None;
                    i += 3;
                    continue;
                }
                i += 1;
            }
            None => match b[i] {
                b'#' => return None, // the rest of the line is a comment
                q @ (b'"' | b'\'') => {
                    if b[i..].len() >= 3 && b[i + 1] == q && b[i + 2] == q {
                        state = Some(q as char);
                        i += 3;
                    } else {
                        // A single-line string: skip to its close, honouring `\` only in a basic string.
                        i += 1;
                        while i < b.len() {
                            if q == b'"' && b[i] == b'\\' {
                                i += 2;
                                continue;
                            }
                            if b[i] == q {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                    }
                }
                _ => i += 1,
            },
        }
    }
    state
}

/// The byte range of the top-level `notify` assignment, terminator included, or None.
///
/// "Top-level" is the point: the scan stops at the first table header, because a `notify` after
/// `[profiles.work]` belongs to that table and is a different key. Multi-line values are followed to their
/// real end, so `notify = [\n "a",\n "b"\n]` is replaced whole.
fn find_notify(text: &str, lines: &[Ln]) -> Result<Option<std::ops::Range<usize>>, MergeError> {
    for line in lines {
        if line.in_string {
            continue;
        }
        let raw = &text[line.start..line.end];
        let trimmed = raw.trim_start();
        if trimmed.starts_with('[') {
            break; // the top-level table ends here
        }
        let Some(eq) = key_assignment(trimmed, "notify") else {
            continue;
        };
        let from = line.start + (raw.len() - trimmed.len()) + eq + 1;
        let end = value_end(text, from).ok_or(MergeError::UnfinishedValue)?;
        return Ok(Some(line.start..end));
    }
    Ok(None)
}

/// The offset of the `=` when this line assigns exactly `key` at its start, bare or quoted. `notify_me = 1`
/// and `[x] notify = 1` are not matches; `"notify" = …` and `notify=…` are.
fn key_assignment(trimmed: &str, key: &str) -> Option<usize> {
    for name in [key.to_string(), format!("\"{key}\""), format!("'{key}'")] {
        if let Some(rest) = trimmed.strip_prefix(&name) {
            let spaces = rest.len() - rest.trim_start().len();
            if rest.trim_start().starts_with('=') {
                return Some(name.len() + spaces);
            }
        }
    }
    None
}

/// One past the end of the value that starts at `from`, terminator included.
///
/// A value ends at the end of its line, unless a bracket or a brace is still open -- an array or an inline
/// table may span lines -- or unless a `"""` string is still open. Returns None when nothing ever closes,
/// which the caller turns into a refusal rather than a truncated file.
fn value_end(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    let (mut i, mut depth) = (from, 0i32);
    let mut ml: Option<u8> = None;
    let mut single: Option<u8> = None;
    while i < b.len() {
        if let Some(q) = ml {
            if q == b'"' && b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == q && b[i..].len() >= 3 && b[i + 1] == q && b[i + 2] == q {
                ml = None;
                i += 3;
                continue;
            }
            i += 1;
            continue;
        }
        if let Some(q) = single {
            if q == b'"' && b[i] == b'\\' {
                i += 2;
                continue;
            }
            if b[i] == q {
                single = None;
            }
            i += 1;
            continue;
        }
        match b[i] {
            q @ (b'"' | b'\'') => {
                if b[i..].len() >= 3 && b[i + 1] == q && b[i + 2] == q {
                    ml = Some(q);
                    i += 3;
                } else {
                    single = Some(q);
                    i += 1;
                }
                continue;
            }
            b'#' => {
                // A comment runs to the end of the line. Inside an open array that is legal TOML and the
                // comment stays part of the value's text, which is exactly what "lose no comments" needs.
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'[' | b'{' => depth += 1,
            b']' | b'}' => depth -= 1,
            b'\n' if depth <= 0 => return Some(i + 1),
            _ => {}
        }
        i += 1;
    }
    (depth <= 0 && ml.is_none() && single.is_none()).then_some(b.len())
}

/// Where the top-level table ends: the start of the first table header line.
///
/// Comments and blank lines immediately above that header come with it -- they are almost always about it --
/// so the insert point is before that run, not between the comment and the thing it describes.
fn top_level_end(text: &str, lines: &[Ln]) -> usize {
    let Some(header) = lines
        .iter()
        .position(|l| !l.in_string && text[l.start..l.end].trim_start().starts_with('['))
    else {
        return text.len();
    };
    let mut at = header;
    while at > 0 {
        let prev = &lines[at - 1];
        let t = text[prev.start..prev.end].trim();
        if prev.in_string || !(t.is_empty() || t.starts_with('#')) {
            break;
        }
        at -= 1;
    }
    lines[at].start
}

// === the files the Connect page installs ==========================================================================

/// The path the shipped `integrations/codex/*` files carry, and the exact string the Connect page replaces
/// with the real install path. A visible `<you>` cannot be mistaken for a working path.
pub const EXE_PLACEHOLDER: &str = r"C:\Users\<you>\AppData\Local\Mewndo\bin\mewndo-hook.exe";

/// `integrations/codex/hooks.json`, built from a real path.
///
/// The Connect page calls this instead of string-replacing in the shipped file, so a path with a space, a
/// quote or a backslash in it is escaped by `serde_json` rather than by hand. The shipped file is this
/// function's output for [`EXE_PLACEHOLDER`], and a test asserts they are the same JSON.
///
/// The *structure* is a guess: §33.10 Part F names the four events, and the Claude-Code-shaped
/// `{"hooks": {"<Event>": [{"hooks": [{"type": "command", "command": …}]}]}}` wrapper is assumed because it is
/// the only hook-config convention anyone has documented. `docs/samples/codex/README.md` says how to check it.
pub fn hooks_json(exe: &Path) -> String {
    let run = |event: &str, timeout: u64| {
        serde_json::json!([{
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": format!("\"{}\" codex {event}", exe.to_string_lossy()),
                "timeout": timeout,
            }],
        }])
    };
    serde_json::to_string_pretty(&serde_json::json!({
        "hooks": {
            // 5 s: a guard decision is microseconds on the rules and at most 300 ms with the model
            // (§34.8), so this is slack, not a budget.
            "PreToolUse": run(PRE_TOOL, 5),
            // 300 s, §33.9's permission deadline -- the only number here that is a real one. Mewndo still
            // prints nothing but a deny, so a slow user costs Codex nothing: its own approval prompt is live.
            "PermissionRequest": run(PERMISSION, 300),
            "PostToolUse": run(POST_TOOL, 5),
            // No reply window for Codex (limit 2), so `Stop` needs only enough time to make a card.
            "Stop": run(STOP, 5),
        }
    }))
    .expect("a tree of strings and numbers always serializes")
        + "\n"
}

/// `integrations/codex/config.snippet.toml`: the block the Connect page shows the user before it changes
/// anything (P5.2: "Always show the exact change first").
pub fn config_snippet(exe: &Path) -> String {
    format!(
        "# Mewndo: add this one line to ~/.codex/config.toml (spec §33.10 Part F step 2).\n\
         #\n\
         # `mewndo-core config-merge` does it for you and keeps every comment in the file. It also keeps your\n\
         # own `notify` if you have one, commented out as `# mewndo:was`, so uninstalling puts it back.\n\
         #\n\
         # Codex calls this program when a turn finishes, with one JSON argument carrying the last assistant\n\
         # message. That is what fills in the Done card (§33.2).\n\
         {}\n",
        notify_line(exe)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::Via;
    use mewndo_router::{CompiledRules, Sig};
    use std::time::Duration;

    // --- the samples ---------------------------------------------------------------------------------------------

    fn samples_dir() -> PathBuf {
        // `CARGO_MANIFEST_DIR` is core/crates/mewndo-core.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/samples/codex")
            .canonicalize()
            .expect("docs/samples/codex exists; it is this handler's only record of Codex's shape")
    }

    fn sample(name: &str) -> Value {
        let path = samples_dir().join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Every sample says, in the file, that it was written by hand. If one ever stops saying so it had better
    /// be because a real capture replaced it -- and then this test is the reminder to update the README's
    /// guessed-name table at the same time.
    #[test]
    fn every_sample_admits_it_is_hand_written() {
        let dir = samples_dir();
        let mut seen = 0;
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let note = v["_mewndo_sample"].as_str().unwrap_or_default();
            assert!(
                note.contains("HAND-WRITTEN") && note.contains("UNVERIFIED"),
                "{} must say it is hand-written and unverified (§32.5 rule 2)",
                path.display()
            );
            seen += 1;
        }
        assert!(seen >= 5, "expected the five Codex samples, found {seen}");
        let readme = std::fs::read_to_string(dir.join("README.md")).unwrap();
        for key in TOOL_NAME_KEYS
            .iter()
            .take(1)
            .chain(LAST_MESSAGE_KEYS.iter().take(1))
        {
            assert!(
                readme.contains(key),
                "README.md must list the guessed name {key}"
            );
        }
    }

    // --- a handler to test ---------------------------------------------------------------------------------------

    fn router() -> Arc<Router> {
        Arc::new(Router::new(
            CompiledRules::builtin(),
            Box::new(mewndo_router::clef::NoClef),
            Box::new(mewndo_router::facts::NoFacts),
        ))
    }

    fn handler() -> Codex {
        let mut codex = Codex::new(router(), None);
        // Active, not the §34.6 shadow default: shadow would send every decision to the rules, and these
        // tests are about what the handler does with a decision, not about which decider made it.
        codex.session.mode = Mode::Active;
        codex.session.project = "shop".into();
        codex
    }

    fn inbox() -> Inbox {
        Inbox::start(
            mewndo_inbox::Config {
                grace: Duration::from_millis(10),
                ..Default::default()
            },
            mewndo_inbox::Deps::default(),
        )
    }

    fn req(event: &str, payload: Value) -> HookRequest {
        HookRequest {
            agent: "codex".into(),
            event: event.into(),
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            pid: Some(4242),
            cwd: Some("/work/shop".into()),
            lane_id: None,
            payload,
        }
    }

    // --- each event against its sample ---------------------------------------------------------------------------

    #[tokio::test]
    async fn pre_tool_use_reads_its_sample_and_guards_the_command_inside_the_argv_array() {
        let payload = sample("pre-tool-shell.json");
        // The mapping of Part F step 3: the argv array became one string before the Router saw it.
        let input = first_val(&payload, TOOL_INPUT_KEYS).unwrap();
        assert_eq!(
            command_text(input).as_deref(),
            Some("rm -rf build && npm run build"),
            "Codex's argv array must reach the Router as the command Claude's Bash would have sent"
        );

        let codex = handler();
        let actions = codex.actions(&req(PRE_TOOL, payload.clone())).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].tool, "shell");
        assert_eq!(actions[0].input["command"], "rm -rf build && npm run build");
        // The tool named its own folder, so that is what the action is scoped to -- not the hook's cwd.
        assert_eq!(actions[0].cwd, PathBuf::from(r"C:\Users\ana\code\shop"));
        // Every other argument travelled untouched.
        assert_eq!(actions[0].input["timeout_ms"], 120000);

        // `npm run build` is not on any deny list, so Mewndo says nothing and Codex carries on.
        let out = codex.handle(&req(PRE_TOOL, payload)).await;
        assert_eq!(out, silent());
    }

    #[tokio::test]
    async fn permission_request_reads_its_sample_and_never_prints_an_allow() {
        let payload = sample("permission-request.json");
        let codex = handler();
        let actions = codex.actions(&req(PERMISSION, payload.clone())).unwrap();
        assert_eq!(actions[0].input["command"], "git push --force origin main");

        // `git push --force` is on §34.9 R1's *ask* list, not the deny list. §33.6 says "any deny wins;
        // otherwise Codex's normal approval flow" -- so an ask is silence, and Codex's own prompt runs.
        let guarded = codex.router.guard(&actions[0]);
        assert_eq!(
            guarded.decision.verdict,
            Verdict::Ask,
            "the rules ask about a force push"
        );
        let out = codex.handle(&req(PERMISSION, payload)).await;
        assert_eq!(out, silent(), "an ask must never become an allow on stdout");
        assert!(!out.stdout.contains("allow"));
    }

    #[tokio::test]
    async fn post_tool_use_reads_its_sample_and_says_nothing() {
        let payload = sample("post-tool.json");
        assert_eq!(
            payload["tool_response"]["exit_code"], 1,
            "the sample is a failed run"
        );
        assert_eq!(handler().handle(&req(POST_TOOL, payload)).await, silent());
    }

    #[tokio::test]
    async fn stop_makes_a_done_card_and_never_blocks() {
        let payload = sample("stop.json");
        let mut codex = handler();
        codex.inbox = Some(inbox());
        let mut events = codex.inbox.as_ref().unwrap().subscribe();

        let out = codex.handle(&req(STOP, payload.clone())).await;
        assert_eq!(
            out,
            silent(),
            "no reply window for Codex: §33.6 leaves it unconfirmed"
        );

        let card = match events.recv().await.unwrap() {
            mewndo_inbox::Event::Card(c) => c,
            other => panic!("expected inbox.card, got {other:?}"),
        };
        assert_eq!(card.kind, "done");
        assert!(card.body.contains("all 7 tests pass"), "{}", card.body);
        assert_eq!(card.agent_id, "codex:0199b3d2-7c41-7e8a-b2d5-5f1c9a0e4477");
    }

    // --- the notify payload carries the last assistant message ---------------------------------------------------

    #[tokio::test]
    async fn the_notify_payload_carries_the_last_assistant_message_onto_the_done_card() {
        let payload = sample("notify-agent-turn-complete.json");
        assert_eq!(payload["type"], TURN_COMPLETE);
        let mut codex = handler();
        codex.inbox = Some(inbox());
        let mut events = codex.inbox.as_ref().unwrap().subscribe();

        let out = codex.handle(&req(NOTIFY, payload.clone())).await;
        assert_eq!(out, silent(), "notify has no output contract at all");

        let card = match events.recv().await.unwrap() {
            mewndo_inbox::Event::Card(c) => c,
            other => panic!("expected inbox.card, got {other:?}"),
        };
        assert_eq!(card.kind, "done");
        assert_eq!(
            card.body,
            payload["last-assistant-message"].as_str().unwrap(),
            "§33.6: notify is the event that carries the last assistant message"
        );
        // The title is what the user asked for, so the card says which turn finished.
        assert!(
            card.title.contains("date tests are failing"),
            "{}",
            card.title
        );

        // All three spellings of the guessed name reach the card, so one wrong guess is not a blank card.
        for key in LAST_MESSAGE_KEYS {
            let p = serde_json::json!({"type": TURN_COMPLETE, *key: "it worked"});
            let card = codex.done_card(&req(NOTIFY, p.clone()), first_str(&p, LAST_MESSAGE_KEYS));
            assert_eq!(card.body, "it worked", "spelling {key}");
        }
        // A notify of a type Mewndo has no sample of makes no card and prints nothing.
        let other = serde_json::json!({"type": "session-start", "last-assistant-message": "hi"});
        assert_eq!(codex.handle(&req(NOTIFY, other)).await, silent());
    }

    // --- any deny wins -------------------------------------------------------------------------------------------

    #[tokio::test]
    async fn any_deny_wins() {
        use Verdict::*;
        // The rule itself: one deny anywhere in the list decides the event.
        assert_eq!(super::any_deny_wins(&[Allow, Allow, Deny]), Some(2));
        assert_eq!(super::any_deny_wins(&[Deny, Allow]), Some(0));
        assert_eq!(
            super::any_deny_wins(&[Allow, Brake]),
            Some(1),
            "§24's freeze is a no to the action"
        );
        assert_eq!(
            super::any_deny_wins(&[SavepointThenAllow, Ask, Allow]),
            None
        );
        assert_eq!(
            super::any_deny_wins(&[]),
            None,
            "nothing to deny is not a deny"
        );

        // And end to end, on a command the built-in rules do deny.
        let codex = handler();
        let payload = serde_json::json!({
            "tool_name": "shell",
            "tool_input": {"command": ["bash", "-lc", "format c: /q"]},
        });
        let out = codex.handle(&req(PRE_TOOL, payload)).await;
        let json: Value = serde_json::from_str(&out.stdout).expect("a deny is JSON");
        let inner = &json["hookSpecificOutput"];
        assert_eq!(inner["hookEventName"], "PreToolUse");
        assert_eq!(inner["permissionDecision"], "deny");
        assert!(
            inner["permissionDecisionReason"].as_str().unwrap().len() > 10,
            "a deny carries a reason the model can read"
        );
        assert_eq!(
            out.exit_code, 0,
            "the decision travels in the JSON, as failopen.rs also has it"
        );

        // The shape is the forwarder's shape. These two literals are the contract between this file and
        // core/crates/mewndo-hook/src/failopen.rs::deny_json; change both or neither.
        // Codex refuses unknown fields (additionalProperties: false), so nothing else may be printed.
        assert_eq!(json.as_object().unwrap().len(), 1);
        assert_eq!(inner.as_object().unwrap().len(), 3);

        // PermissionRequest has its own shape in Codex's schema: a decision with a behavior.
        let deny: Value = serde_json::from_str(&deny_json(PERMISSION, "no")).unwrap();
        assert_eq!(
            deny["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(deny["hookSpecificOutput"]["decision"]["message"], "no");
    }

    #[tokio::test]
    async fn an_allow_is_never_printed_for_any_event_or_any_payload() {
        let codex = handler();
        let payloads = [
            sample("pre-tool-shell.json"),
            sample("permission-request.json"),
            sample("post-tool.json"),
            sample("stop.json"),
            sample("notify-agent-turn-complete.json"),
            sample("malformed.json"),
            serde_json::json!({"tool_name": "shell", "tool_input": {"command": "ls"}}),
            Value::Null,
        ];
        for event in [PRE_TOOL, PERMISSION, POST_TOOL, STOP, NOTIFY, "nonsense"] {
            for payload in &payloads {
                let out = codex.handle(&req(event, payload.clone())).await;
                assert!(
                    !out.stdout.contains("allow"),
                    "{event} printed {:?}: this file must never print an allow the Router did not give",
                    out.stdout
                );
            }
        }
    }

    // --- malformed input: no output, no panic --------------------------------------------------------------------

    #[tokio::test]
    async fn malformed_input_produces_no_output_and_no_panic() {
        let mut codex = handler();
        codex.inbox = Some(inbox());
        let junk = [
            sample("malformed.json"),
            Value::Null,
            Value::Bool(true),
            // What the forwarder sends when stdin was not JSON at all (mewndo-hook/src/lib.rs::payload_of).
            Value::String("{\"tool_name\":\"shell\"".into()),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!({"tool_name": ""}),
            serde_json::json!({"tool_name": "shell", "tool_input": {"command": []}}),
            serde_json::json!({"tool_name": "shell", "tool_input": {"command": [1, 2]}}),
            serde_json::json!({"tool_name": "shell", "tool_input": "not an object"}),
            serde_json::json!({"type": TURN_COMPLETE, "last-assistant-message": {"a": 1}}),
            serde_json::json!({"tool_name": "shell", "tool_input": {"command": "x".repeat(100_000)}}),
        ];
        for payload in junk {
            for event in [
                PRE_TOOL,
                PERMISSION,
                POST_TOOL,
                STOP,
                NOTIFY,
                "",
                "pre_tool_use",
            ] {
                let out = codex.handle(&req(event, payload.clone())).await;
                assert_eq!(
                    out.exit_code, 0,
                    "{event} on {payload:?} must fail open (§32.5 rule 7)"
                );
                assert!(
                    out.stdout.is_empty() || out.stdout.contains("\"deny\""),
                    "{event} on {payload:?} printed {:?}",
                    out.stdout
                );
            }
        }
        // A `command` that is neither a string nor an array of strings is not understood, so it is not read.
        assert_eq!(
            command_text(&serde_json::json!({"command": {"argv": ["rm"]}})),
            None
        );
        assert_eq!(
            command_text(&serde_json::json!({"command": [1, "x"]})),
            None
        );
        assert_eq!(command_text(&serde_json::json!({"command": "   "})), None);
        assert_eq!(command_text(&Value::Null), None);
    }

    #[test]
    fn the_argv_unwrapper_only_unwraps_what_it_is_sure_of() {
        let argv = |items: &[&str]| serde_json::json!({"command": items});
        assert_eq!(
            command_text(&argv(&["bash", "-lc", "npm test"])).unwrap(),
            "npm test"
        );
        assert_eq!(
            command_text(&argv(&["/bin/sh", "-c", "npm test"])).unwrap(),
            "npm test"
        );
        assert_eq!(
            command_text(&argv(&["zsh", "-ic", "npm test"])).unwrap(),
            "npm test"
        );
        // Not a shell, or not a read-from-argument flag, or arguments after the script: joined, not unwrapped,
        // because `$0` and `$1` change what the script does.
        assert_eq!(
            command_text(&argv(&["git", "push", "--force"])).unwrap(),
            "git push --force"
        );
        assert_eq!(
            command_text(&argv(&["bash", "script.sh"])).unwrap(),
            "bash script.sh"
        );
        assert_eq!(
            command_text(&argv(&["bash", "-lc", "echo $1", "zero", "one"])).unwrap(),
            "bash -lc echo $1 zero one"
        );
        assert_eq!(
            command_text(&argv(&["python", "-c", "print(1)"])).unwrap(),
            "python -c print(1)"
        );
        // A single string is passed straight through: that is Claude's shape and it needs no mapping.
        assert_eq!(
            command_text(&serde_json::json!({"command": "ls -l"})).unwrap(),
            "ls -l"
        );
    }

    // --- MEWNDO_LANE_ID ------------------------------------------------------------------------------------------

    #[test]
    fn the_lane_id_from_the_forwarders_environment_names_the_agent() {
        let mut r = req(STOP, serde_json::json!({"session_id": "s1"}));
        assert_eq!(agent_id(&r), "codex:s1");

        // §33.10 Part F step 8: the lane the core started Codex in wins, so the lane's terminal output and
        // its hook events are one agent (and Part G can find the terminal to write a reply into).
        r.lane_id = Some("01JLANE7QX".into());
        assert_eq!(agent_id(&r), "lane:01JLANE7QX");
        assert_eq!(
            mewndo_pty::LANE_ID_ENV,
            "MEWNDO_LANE_ID",
            "the name the forwarder reads"
        );

        // Empty or whitespace is not a lane, and not a session either.
        r.lane_id = Some("  ".into());
        assert_eq!(agent_id(&r), "codex:s1");
        r.session_id = Some(String::new());
        assert_eq!(agent_id(&r), "codex:pid-4242");
        r.pid = None;
        assert_eq!(agent_id(&r), "codex:unknown");
    }

    #[tokio::test]
    async fn a_lane_card_is_keyed_on_the_lane() {
        let mut codex = handler();
        codex.inbox = Some(inbox());
        let mut events = codex.inbox.as_ref().unwrap().subscribe();
        let mut r = req(NOTIFY, sample("notify-agent-turn-complete.json"));
        r.lane_id = Some("01JLANE7QX".into());
        codex.handle(&r).await;
        let card = match events.recv().await.unwrap() {
            mewndo_inbox::Event::Card(c) => c,
            other => panic!("expected inbox.card, got {other:?}"),
        };
        assert_eq!(card.agent_id, "lane:01JLANE7QX");
    }

    // --- the config.toml merge -----------------------------------------------------------------------------------

    fn exe() -> PathBuf {
        PathBuf::from(r"C:\Program Files\Mewndo\bin\mewndo-hook.exe")
    }

    /// A temp file per test, because step 2 is about editing a file on the user's disk: the function is pure,
    /// so the test writes the text out, runs the merge over what it reads back, and writes the result -- the
    /// same round trip the Connect page does (plot.md rule 4: temp file, then rename).
    fn round_trip_on_disk(name: &str, original: &str) -> (String, String) {
        let dir =
            std::env::temp_dir().join(format!("mewndo-codex-merge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, original).unwrap();

        let before = std::fs::read_to_string(&path).unwrap();
        let merged =
            merge_notify(&before, &exe()).expect("the merge must not refuse a normal config");
        let tmp = dir.join("config.toml.tmp");
        std::fs::write(&tmp, &merged).unwrap();
        std::fs::rename(&tmp, &path).unwrap();

        let on_disk = std::fs::read_to_string(&path).unwrap();
        let removed = remove_notify(&on_disk).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        (on_disk, removed)
    }

    #[test]
    fn the_merge_keeps_every_comment_and_every_other_byte() {
        let original = "\
# My Codex config. Do not lose this comment.
model = \"gpt-5-codex\"          # nor this one, on the end of a line
approval_policy = \"on-request\"

# This comment belongs to the profile below it.
[profiles.work]
model = \"gpt-5\"
# A profile may have its own notify, which is a different key.
notify = [\"C:\\\\tools\\\\work-notify.exe\"]

[shell_environment_policy]
inherit = \"core\"
";
        let (merged, removed) = round_trip_on_disk("comments", original);

        // Nothing the merge did not add is gone.
        for kept in [
            "# My Codex config. Do not lose this comment.",
            "# nor this one, on the end of a line",
            "# This comment belongs to the profile below it.",
            "approval_policy = \"on-request\"",
            "[profiles.work]",
            "# A profile may have its own notify, which is a different key.",
            "notify = [\"C:\\\\tools\\\\work-notify.exe\"]",
            "[shell_environment_policy]",
            "inherit = \"core\"",
        ] {
            assert!(
                merged.contains(kept),
                "the merge lost {kept:?}\n---\n{merged}"
            );
        }
        // The new line is there, escaped as TOML needs it.
        assert!(merged.contains(
            r#"notify = ["C:\\Program Files\\Mewndo\\bin\\mewndo-hook.exe", "codex", "notify"]"#
        ));
        // And it is a *top-level* key: before the first table header, or Codex would read it as the profile's.
        let notify_at = merged.find("mewndo-hook.exe").unwrap();
        assert!(
            notify_at < merged.find("[profiles.work]").unwrap(),
            "\n{merged}"
        );
        // The profile's own notify was not touched: there is still exactly one of it.
        assert_eq!(merged.matches("work-notify.exe").count(), 1);
        // Uninstall gives back the original file, byte for byte.
        assert_eq!(removed, original);
    }

    #[test]
    fn installing_twice_changes_nothing_and_uninstall_is_exact() {
        for original in [
            "",
            "\n",
            "model = \"gpt-5-codex\"\n",
            "model = \"gpt-5-codex\"", // no trailing newline
            "# only a comment\n",
            "[profiles.work]\nmodel = \"gpt-5\"\n", // a table and nothing above it
            "notify = [\"C:\\\\old.exe\"]\n",       // the user already has one
            "notify=[\"C:\\\\old.exe\"] # with a comment\nmodel = \"x\"\n",
            "'notify' = [\"C:\\\\old.exe\"]\n", // quoted key
            "notify = [\n  \"C:\\\\old.exe\",   # why\n  \"--quiet\",\n]\nmodel = \"x\"\n",
        ] {
            let once = merge_notify(original, &exe()).unwrap();
            let twice = merge_notify(&once, &exe()).unwrap();
            assert_eq!(
                once, twice,
                "installing twice must change nothing\n{original:?}"
            );
            assert_eq!(
                remove_notify(&once).unwrap(),
                original,
                "uninstall must give back exactly what was there\n{original:?}"
            );
            // Exactly one top-level notify afterwards, and it is Mewndo's.
            let lines = logical_lines(&once).unwrap();
            let live: Vec<&str> = lines
                .iter()
                .map(|l| once[l.start..l.end].trim())
                .filter(|t| key_assignment(t, "notify").is_some())
                .collect();
            assert_eq!(live.len(), 1, "{original:?} -> {live:?}\n{once}");
            assert!(live[0].contains("mewndo-hook.exe"));
            // Removing from a file with no block is a no-op, so the Connect page may always call it.
            assert_eq!(remove_notify(original).unwrap(), original);
        }
    }

    #[test]
    fn the_merge_leaves_a_notify_that_is_only_text_alone() {
        // A `notify = ...` inside a multi-line string is text. A scanner that did not track strings would
        // rewrite it and corrupt the file.
        let original = "\
instructions = \"\"\"
To wire up a notifier, put a line like
notify = [\"C:\\\\your\\\\notifier.exe\"]
at the top of this file.
\"\"\"
model = \"gpt-5-codex\"
";
        let merged = merge_notify(original, &exe()).unwrap();
        assert_eq!(
            merged.matches("your\\\\notifier.exe").count(),
            1,
            "the text was rewritten\n{merged}"
        );
        assert!(merged.contains("at the top of this file."));
        assert!(merged.contains("mewndo-hook.exe"));
        assert_eq!(remove_notify(&merged).unwrap(), original);
        // The documentation's `notify` was not taken for the real one, so Mewndo's went in fresh.
        assert!(!merged.contains(WAS_PREFIX), "\n{merged}");
    }

    #[test]
    fn crlf_files_stay_crlf() {
        let original = "# a windows file\r\nmodel = \"gpt-5-codex\"\r\n\r\n[profiles.work]\r\nmodel = \"gpt-5\"\r\n";
        let merged = merge_notify(original, &exe()).unwrap();
        assert!(
            !merged.contains('\n') || merged.replace("\r\n", "").matches('\n').count() == 0,
            "a CRLF file must not gain a bare LF\n{merged:?}"
        );
        assert!(merged.contains("mewndo-hook.exe"));
        assert_eq!(remove_notify(&merged).unwrap(), original);
    }

    #[test]
    fn the_merge_refuses_rather_than_corrupt_a_file_it_cannot_read() {
        // Ends inside a multi-line string: the scanner cannot tell code from text, so it does nothing.
        assert_eq!(
            merge_notify("x = \"\"\"never closed\nnotify = [1]\n", &exe()),
            Err(MergeError::Unterminated)
        );
        assert_eq!(
            remove_notify("x = '''open\n"),
            Err(MergeError::Unterminated)
        );
        // A `notify` whose array never closes.
        assert_eq!(
            merge_notify("notify = [\"a\",\n", &exe()),
            Err(MergeError::UnfinishedValue)
        );
        // Too big to touch.
        let huge = "a = 1\n".repeat(MERGE_CAP);
        assert!(matches!(
            merge_notify(&huge, &exe()),
            Err(MergeError::TooBig(_))
        ));
        // Every refusal says what it refused, for the Connect page to show.
        assert!(
            MergeError::Unterminated
                .to_string()
                .contains("Nothing was changed")
        );
        assert!(
            MergeError::TooBig(9)
                .to_string()
                .contains("Nothing was changed")
        );
        assert!(
            MergeError::UnfinishedValue
                .to_string()
                .contains("Nothing was changed")
        );
    }

    #[test]
    fn a_windows_path_is_escaped_as_toml_needs_and_not_by_hand() {
        assert_eq!(
            notify_line(Path::new(
                r"C:\Users\ana\AppData\Local\Mewndo\bin\mewndo-hook.exe"
            )),
            r#"notify = ["C:\\Users\\ana\\AppData\\Local\\Mewndo\\bin\\mewndo-hook.exe", "codex", "notify"]"#
        );
        // A path with a quote or a tab in it cannot break out of the string.
        assert_eq!(toml_string("a\"b\tc\\d"), r#""a\"b\tc\\d""#);
        assert_eq!(toml_string("\u{1}"), r#""\u0001""#);
        // And the snippet the Connect page shows is the same line.
        let snippet = config_snippet(&exe());
        assert!(snippet.contains(&notify_line(&exe())));
        assert!(snippet.contains("§33.10 Part F step 2"));
    }

    #[test]
    fn a_notify_after_a_table_header_is_a_different_key_and_is_not_found() {
        let text = "[profiles.work]\nnotify = [\"x\"]\n";
        let lines = logical_lines(text).unwrap();
        assert_eq!(
            find_notify(text, &lines).unwrap(),
            None,
            "that notify belongs to the profile"
        );
        // So the merge adds a top-level one, above the header, and leaves the profile's alone.
        let merged = merge_notify(text, &exe()).unwrap();
        assert!(merged.find("mewndo-hook").unwrap() < merged.find("[profiles.work]").unwrap());
        assert!(merged.contains("notify = [\"x\"]"));
        assert_eq!(remove_notify(&merged).unwrap(), text);
    }

    #[test]
    fn a_key_that_merely_starts_with_notify_is_not_notify() {
        for line in [
            "notify_me = 1",
            "notifyx=2",
            "x_notify = 3",
            "# notify = 4",
            "notify",
        ] {
            assert!(key_assignment(line, "notify").is_none(), "{line}");
        }
        for line in [
            "notify = 1",
            "notify=1",
            "notify  =  1",
            "\"notify\" = 1",
            "'notify' = 1",
        ] {
            assert!(key_assignment(line, "notify").is_some(), "{line}");
        }
    }

    // --- the shipped integration files ---------------------------------------------------------------------------

    fn integrations_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../integrations/codex")
            .canonicalize()
            .expect("integrations/codex exists (§38.4)")
    }

    #[test]
    fn the_shipped_hooks_json_is_this_files_own_output() {
        let shipped: Value =
            serde_json::from_slice(&std::fs::read(integrations_dir().join("hooks.json")).unwrap())
                .expect("integrations/codex/hooks.json is JSON");
        let built: Value = serde_json::from_str(&hooks_json(Path::new(EXE_PLACEHOLDER))).unwrap();
        assert_eq!(
            shipped, built,
            "the shipped file and hooks_json() must not drift: the Connect page writes the second one"
        );

        // §33.10 Part F step 2: all four events, each pointing at the absolute path of mewndo-hook.exe.
        let hooks = shipped["hooks"].as_object().unwrap();
        for event in ["PreToolUse", "PermissionRequest", "PostToolUse", "Stop"] {
            let command = hooks[event][0]["hooks"][0]["command"].as_str().unwrap();
            assert!(command.contains("mewndo-hook.exe"), "{event}: {command}");
            assert!(command.contains(" codex "), "{event}: {command}");
            assert!(
                command.starts_with('"'),
                "{event}: a path with spaces must be quoted"
            );
            // The event argument is one this handler answers.
            let event_arg = command.rsplit(' ').next().unwrap();
            assert!(
                event_name(event_arg).is_some(),
                "{event} passes {event_arg}, which is unknown"
            );
        }
        assert_eq!(hooks.len(), 4, "four events, no more: §33.10 Part F step 2");
        // §33.9's permission deadline, and the one number here that is not slack.
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 300);

        // The snippet on disk is this file's own output too.
        let snippet = std::fs::read_to_string(integrations_dir().join("config.snippet.toml"))
            .unwrap()
            .replace("\r\n", "\n"); // a Windows checkout (CI) may turn LF into CRLF
        assert_eq!(snippet, config_snippet(Path::new(EXE_PLACEHOLDER)));
        assert!(
            snippet.contains(&toml_string(EXE_PLACEHOLDER)),
            "the placeholder must be visibly not a real path"
        );
        assert!(EXE_PLACEHOLDER.contains("<you>"));
    }

    // --- the unused-today helper still has to be right -----------------------------------------------------------

    #[test]
    fn permission_facts_name_codex() {
        let f = facts(Sig::default(), "npm test".into(), "shop".into());
        assert_eq!(f.agent_kind, "codex");
        assert_eq!(
            (f.command_norm.as_str(), f.project.as_str()),
            ("npm test", "shop")
        );
        // An answer index teaches the habit counter the same thing it would for any agent.
        let card = Card::permission("codex:1", "t", "b", 3, f);
        let answer = mewndo_inbox::choice(card.id, 2, Via::Key);
        assert_eq!(card.taught_by(&answer), Some(Verdict::Deny));
    }
}
