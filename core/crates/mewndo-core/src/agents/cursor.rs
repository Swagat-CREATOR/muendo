// Cursor: beforeShellExecution, beforeMCPExecution, afterAgentResponse, stop (spec §33.10 Part F, §33.6).
//
//   shell      beforeShellExecution  Router -> allow, deny, or **wait for the card** and then allow or deny
//   mcp        beforeMCPExecution    the same
//   response   afterAgentResponse    recorded; never any output
//   stop       stop                  a Done card with a 15 s reply window; a reply becomes followup_message
//
// **Cursor is the one agent where Mewndo blocks on its own card.** §33.10 Part F step 5: "Cursor's own 'ask'
// opens a prompt that Mewndo can't answer. So for Cursor, when the Router says ask, the hook waits for the
// Inbox card itself and returns allow or deny." Every other agent can be told "ask" and will raise its own
// prompt; Cursor's prompt appears somewhere Mewndo has no way to answer, so a `"permission": "ask"` would
// strand the user in front of a question they cannot reach from the card they are looking at. The handler
// therefore holds the hook open, waits on the card's `oneshot`, and turns the answer into allow or deny.
//
// That makes the waiting path the dangerous part of this file, so it is bounded three ways:
//
//  1. [`ASK_WAIT`] -- this handler's own deadline, deliberately shorter than any hook timeout Cursor might
//     have, so Mewndo gives up before Cursor does.
//  2. The card's own deadline (§33.9), passed to the Inbox, which expires the card and drops the sender.
//  3. The `oneshot` erroring the instant the card becomes unanswerable, which is mewndo-inbox's "nobody is
//     blocked forever" in the type.
//
// **And on every one of those three endings the answer is silence, never an allow.** The Router said ask, not
// allow; printing allow because nobody answered would be Mewndo approving an action on the user's behalf
// because it got bored. Silence means Cursor falls back to its own flow -- which is §32.5 rule 7, fail open,
// and the honest cost of the design: a timed-out ask is a question the user never saw.
//
// **What this file cannot do, honestly (§28.10, §32.5 rule 5).**
//
//  1. *Every field name it reads is a guess*, including the output names. There was no Cursor install to
//     capture from, so `docs/samples/cursor/` is hand-written and its README lists each guessed name and what
//     goes wrong if it is wrong. §32.5 rule 2 forbids exactly this and there was no alternative. A payload
//     that matches none of the candidate spellings produces no output and exit 0.
//  2. *Cursor's hook timeout field is unverified* -- a §32.5 rule 3 verify-first item in so many words. The
//     `timeout_ms` in `integrations/cursor/hooks.json` is a guess, which is why [`ASK_WAIT`] exists: this
//     handler does not rely on the config value being read at all.
//  3. *No real run.* Part F's "Done when" wants one; the harness half is here and the real half is not. In
//     particular nobody has seen Cursor honour a `permission` deny or send a `followup_message`.
//
// The deny shape is not this file's invention: the hook forwarder prints the same one from its deny cache
// when the core is down (`core/crates/mewndo-hook/src/failopen.rs::deny_json`). Both print at the same
// Cursor. Change the two together.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "§33.10 Part F builds the handler; desk.rs wires `hook.request` to it in Part A's `respond`. \
                  Until that one line lands nothing here has a caller."
    )
)]

use mewndo_inbox::{Answer, Card, CardKind, Inbox, Opt};
use mewndo_proto::{HookRequest, HookResponse};
use mewndo_router::{GuardInput, Mode, Router, Verdict};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// `argv[2]` for each event, as `integrations/cursor/hooks.json` spells it. §33.10 Part F step 4 fixes
/// `cursor shell`, and `mewndo-hook`'s `failopen::is_pre_action` already knows that name, so it is not free
/// to change.
pub const SHELL: &str = "shell";
pub const MCP: &str = "mcp";
pub const RESPONSE: &str = "response";
pub const STOP: &str = "stop";

/// How long the hook waits for the card before giving up and saying nothing (limit 1 above).
///
/// 25 s, chosen to be comfortably under the 30 s this handler asks for in `hooks.json` and under any plausible
/// default Cursor might have. It is not §33.9's 300 s permission deadline: 300 s only works for an agent whose
/// own prompt stays live while Mewndo thinks, and holding a Cursor hook open for five minutes would look like
/// a hung editor. A user who is not at their machine does not get asked; they get Cursor's own flow.
pub const ASK_WAIT: Duration = Duration::from_secs(25);

/// §33.2's reply window on a Done card: "the `Stop` hook waits up to 15 s (settable 0-120 s)".
pub const REPLY_WINDOW: Duration = Duration::from_secs(15);
/// The settable range of the reply window (§33.6, Claude Code row; the same setting serves Cursor).
pub const REPLY_WINDOW_MAX: Duration = Duration::from_secs(120);

// --- the guessed field names, all in one place --------------------------------------------------------------------

/// The shell command `beforeShellExecution` is about.
pub const COMMAND_KEYS: &[&str] = &["command", "cmd", "shell_command", "commandLine"];
/// The folder it would run in.
pub const CWD_KEYS: &[&str] = &["cwd", "workdir", "working_directory", "workingDirectory"];
/// Which MCP tool `beforeMCPExecution` is about, and its arguments.
pub const TOOL_NAME_KEYS: &[&str] = &["tool_name", "toolName", "tool", "name"];
pub const TOOL_INPUT_KEYS: &[&str] = &["tool_input", "toolInput", "arguments", "input", "params"];
/// Which MCP server asked, for the card to say.
pub const SERVER_KEYS: &[&str] = &["server_name", "serverName", "server", "url"];
/// What Cursor said, on `afterAgentResponse`.
pub const TEXT_KEYS: &[&str] = &["text", "message", "response", "content"];
/// The conversation, which is the agent as far as the Agents tab is concerned, and the turn inside it.
pub const CONVERSATION_KEYS: &[&str] =
    &["conversation_id", "conversationId", "chat_id", "thread_id"];
pub const GENERATION_KEYS: &[&str] = &["generation_id", "generationId", "turn_id", "request_id"];
/// The folders Cursor has open, used only to scope an action whose payload named no folder.
pub const ROOTS_KEYS: &[&str] = &["workspace_roots", "workspaceRoots", "roots"];

// --- what the handler is allowed to print ------------------------------------------------------------------------

/// Cursor's answer to a `before*` hook. §33.10 Part F step 5 and §33.6 name `allow` and `deny`; `ask` exists
/// in Cursor and is the one value this handler never prints, because Mewndo cannot answer the prompt it opens.
///
/// `agent_message` is spelled to match `mewndo-hook/src/failopen.rs::deny_json("cursor", …)`, which Part B
/// already landed, rather than to a second guess of my own. If a captured sample says `agentMessage`, both
/// files change together.
fn permission_json(permission: &str, message: Option<&str>) -> String {
    let mut body = serde_json::Map::new();
    body.insert("permission".into(), Value::String(permission.into()));
    if let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) {
        body.insert("agent_message".into(), Value::String(message.into()));
    }
    Value::Object(body).to_string()
}

/// §33.10 Part F step 6, quoted verbatim: "A reply is returned as `{"followup_message": "<reply>"}`."
fn followup_json(reply: &str) -> String {
    serde_json::json!({ "followup_message": reply }).to_string()
}

/// Silence: exactly what Cursor sees when Mewndo is not installed (§32.5 rule 7).
fn silent() -> HookResponse {
    HookResponse {
        stdout: String::new(),
        exit_code: 0,
    }
}

fn out(stdout: String) -> HookResponse {
    HookResponse {
        stdout,
        exit_code: 0,
    }
}

// --- what the core supplies --------------------------------------------------------------------------------------

/// The session facts the Router needs that a hook payload does not carry (§34.1). Same shape and same honest
/// defaults as `agents/codex.rs`: no brief means the scope is the working folder, and `Mode::Shadow` is
/// §34.6's "every agent starts in shadow", so a half-wired core cannot start blocking things.
#[derive(Debug, Clone, Default)]
pub struct Session {
    pub brief: String,
    pub project: String,
    pub recent: Vec<String>,
    pub mode: Mode,
}

/// The handler. `inbox` is an `Option` because a core with no Inbox must still guard actions -- without one,
/// an ask cannot be put to the user, so it becomes silence and Cursor's own flow runs.
pub struct Cursor {
    pub router: Arc<Router>,
    pub inbox: Option<Inbox>,
    pub session: Session,
    /// Overridable so a test does not wait 25 s, and so Settings can shorten it.
    pub ask_wait: Duration,
    /// §33.2's 0-120 s. Zero means no reply window: `stop` makes its card and returns at once.
    pub reply_window: Duration,
}

impl Cursor {
    pub fn new(router: Arc<Router>, inbox: Option<Inbox>) -> Cursor {
        Cursor {
            router,
            inbox,
            session: Session::default(),
            ask_wait: ASK_WAIT,
            reply_window: REPLY_WINDOW,
        }
    }

    /// One hook event in, one thing to print out. Never panics; never prints an allow the Router did not give.
    pub async fn handle(&self, req: &HookRequest) -> HookResponse {
        match event_name(&req.event) {
            Some(SHELL) => self.guard(req, Pre::Shell).await,
            Some(MCP) => self.guard(req, Pre::Mcp).await,
            // Recorded against the trace (§35); there is nothing to say back to a response that has already
            // been written.
            Some(RESPONSE) => silent(),
            Some(STOP) => self.stop(req).await,
            _ => silent(),
        }
    }

    /// `beforeShellExecution` and `beforeMCPExecution`.
    async fn guard(&self, req: &HookRequest, pre: Pre) -> HookResponse {
        let Some(input) = self.action(req, pre) else {
            // The guessed field names did not match, so Mewndo does not know what Cursor is about to do.
            return silent();
        };
        let guarded = self.router.guard(&input);
        let reason = guarded.decision.reason.clone();
        match guarded.decision.verdict {
            // The Router allowed it, so this is an allow the Router *did* give.
            Verdict::Allow | Verdict::SavepointThenAllow => out(permission_json("allow", None)),
            Verdict::Deny | Verdict::Brake => out(permission_json("deny", Some(&reason))),
            // Part F step 5: the hook waits for the card itself.
            Verdict::Ask => self.ask(req, &input, &guarded, &reason).await,
        }
    }

    /// Part F step 5, the whole of it: make the permission card, wait for it, and answer Cursor allow or deny.
    ///
    /// Three ways this ends without an answer -- no Inbox, the wait running out, the card becoming
    /// unanswerable -- and all three are silence. Printing `"permission": "ask"` would hand the user a prompt
    /// Mewndo cannot reach; printing `"allow"` would be Mewndo approving the action itself.
    async fn ask(
        &self,
        req: &HookRequest,
        input: &GuardInput,
        guarded: &mewndo_router::Guarded,
        reason: &str,
    ) -> HookResponse {
        let Some(inbox) = self.inbox.as_ref() else {
            return silent();
        };
        let card = self.permission_card(req, input, guarded, reason);
        let options = card.options.clone();
        let (_, waiting) = inbox.create(card).await;

        match tokio::time::timeout(self.ask_wait, waiting).await {
            Ok(Ok(answer)) => match verdict_of(&options, &answer) {
                Some(Verdict::Deny) | Some(Verdict::Brake) => {
                    out(permission_json("deny", Some(&denied_by_user(&answer))))
                }
                Some(v) if v.allows() => out(permission_json("allow", None)),
                // An answer that teaches nothing -- a typed reason, "add a reason", an option index the card
                // does not have. It is not an allow, so it is not printed as one.
                _ => silent(),
            },
            // The card expired, the Inbox shut down, or the user never came back. Fail open (§32.5 rule 7).
            Ok(Err(_)) | Err(_) => silent(),
        }
    }

    /// §33.2's permission card, with §34.7's facts attached so the third identical answer can become a habit.
    fn permission_card(
        &self,
        req: &HookRequest,
        input: &GuardInput,
        guarded: &mewndo_router::Guarded,
        reason: &str,
    ) -> Card {
        let title = match guarded.action.command_norm.is_empty() {
            false => one_line(&guarded.action.command_norm),
            true => format!("Cursor wants to use {}", input.tool),
        };
        let mut card = Card::permission(
            agent_id(req),
            title,
            reason,
            super::risk_of(guarded),
            mewndo_inbox::PermissionFacts {
                agent_kind: "cursor".to_string(),
                project: self.session.project.clone(),
                action_sig: guarded.sig,
                command_norm: guarded.action.command_norm.clone(),
            },
        );
        card.trace_id = first_str(&req.payload, GENERATION_KEYS).map(str::to_string);
        // §33.9's "nobody is blocked forever", from the card's side: the card expires when this hook has
        // stopped waiting, so the user cannot answer a question whose answer can no longer be delivered.
        card.deadline = Some(self.ask_wait);
        card
    }

    /// `stop`: a Done card, and a reply inside the window becomes `followup_message` (Part F steps 6 and 7).
    ///
    /// This is the one place Mewndo can message Cursor after a turn, which is why §33.6's Cursor row promises
    /// it: "the `stop` hook returns `followup_message` with the reply, and Cursor sends it as the next
    /// message".
    async fn stop(&self, req: &HookRequest) -> HookResponse {
        let Some(inbox) = self.inbox.as_ref() else {
            return silent();
        };
        let (_, waiting) = inbox.create(self.done_card(req)).await;
        if self.reply_window.is_zero() {
            return silent();
        }
        match tokio::time::timeout(self.reply_window, waiting).await {
            // Typed or spoken text (§33.5) is the reply. A bare option index on a Done card is "seen", not
            // something to send Cursor.
            Ok(Ok(answer)) => match answer
                .text
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                Some(reply) => out(followup_json(reply)),
                None => silent(),
            },
            // The window closed with no reply. Not an error: §33.2 says the window closes and that is that.
            Ok(Err(_)) | Err(_) => silent(),
        }
    }

    /// The Done card. `Space` types a reply and `1` dismisses, so the options say which is which.
    fn done_card(&self, req: &HookRequest) -> Card {
        let mut card = Card::new(
            CardKind::Done,
            agent_id(req),
            "Cursor finished",
            first_str(&req.payload, TEXT_KEYS)
                .unwrap_or("Cursor finished its turn. Reply here and it will be sent as your next message.")
                .trim(),
        );
        card.risk = 1;
        card.options = vec![Opt::new("Seen"), Opt::new("Reply")];
        card.trace_id = first_str(&req.payload, GENERATION_KEYS).map(str::to_string);
        card.deadline = Some(self.reply_window);
        card
    }

    /// The Router call for one `before*` event, or None when the payload could not be read.
    fn action(&self, req: &HookRequest, pre: Pre) -> Option<GuardInput> {
        let hook_cwd = req.cwd.as_deref().unwrap_or_default();
        let cwd = PathBuf::from(
            first_str(&req.payload, CWD_KEYS)
                .or_else(|| {
                    first_val(&req.payload, ROOTS_KEYS)
                        .and_then(Value::as_array)
                        .and_then(|a| a.iter().find_map(Value::as_str))
                })
                .unwrap_or(hook_cwd),
        );
        let (tool, input) = match pre {
            // A shell command is a shell command: `tool = "shell"` is what `mewndo_router::normalize`
            // recognizes, and the command is lifted to the `command` key it reads.
            Pre::Shell => {
                let command = first_str(&req.payload, COMMAND_KEYS)?;
                (SHELL.to_string(), serde_json::json!({ "command": command }))
            }
            // An MCP tool keeps its own name, so `normalize` classifies it as `Kind::Mcp` and §34.2's
            // recipient rules apply.
            Pre::Mcp => {
                let tool = first_str(&req.payload, TOOL_NAME_KEYS)?;
                let input = first_val(&req.payload, TOOL_INPUT_KEYS)
                    .cloned()
                    .unwrap_or(Value::Null);
                (mcp_tool_name(&req.payload, tool), input)
            }
        };
        Some(GuardInput {
            agent_kind: "cursor".into(),
            tool,
            input,
            cwd,
            brief: self.session.brief.clone(),
            project: self.session.project.clone(),
            recent: self.session.recent.clone(),
            mode: self.session.mode,
        })
    }
}

/// Which `before*` event this is. Two variants rather than a string, so a new event cannot fall into the
/// wrong branch by spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pre {
    Shell,
    Mcp,
}

/// `mcp__<server>__<tool>`, which is the spelling `mewndo_router::normalize` keys `Kind::Mcp` off and the
/// same one Claude Code uses, so one set of rules covers both agents' MCP calls. A tool that already carries
/// the prefix is left alone.
fn mcp_tool_name(payload: &Value, tool: &str) -> String {
    if tool.starts_with("mcp__") {
        return tool.to_string();
    }
    match first_str(payload, SERVER_KEYS) {
        Some(server) => format!("mcp__{}__{tool}", slug(server)),
        None => format!("mcp__cursor__{tool}"),
    }
}

/// A server name or URL as one safe token: `http://127.0.0.1:7391/mcp` -> `127_0_0_1_7391_mcp`.
fn slug(s: &str) -> String {
    let trimmed = s
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let out: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "cursor".to_string()
    } else {
        out
    }
}

/// What the chosen option means, through the card's own options so that "always allow here" and "allow once"
/// both mean allow -- which is mewndo-inbox's rule, not a second copy of it here.
fn verdict_of(options: &[Opt], answer: &Answer) -> Option<Verdict> {
    options.get(answer.choice?).and_then(|o| o.answer)
}

/// What Cursor's model is told when the user says no. §33.6's Claude row words it "The user answered in
/// Mewndo: …"; the same wording here, so a transcript reads the same whichever agent it came from.
fn denied_by_user(answer: &Answer) -> String {
    match answer
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(reason) => format!("The user answered in Mewndo: no. {reason}"),
        None => "The user answered in Mewndo: no. Ask them what to do instead.".to_string(),
    }
}

/// The agent this event belongs to, and the whole of §33.10 Part F step 8's `MEWNDO_LANE_ID` handling.
///
/// A lane id beats a conversation id. When the core started Cursor inside a Mewndo lane (§33.7, Part G) the
/// forwarder inherits `MEWNDO_LANE_ID` from that lane's environment (`mewndo-pty/src/launch.rs`) and puts it
/// on `hook.request`. The lane is the agent session, so keying on it puts the lane's terminal output and its
/// hook events on one agent in the Agents tab.
///
/// Without a lane, Cursor's own conversation id -- one conversation is one agent, which is what makes two
/// chats in one editor two rows. Without that, the forwarder's pid.
pub fn agent_id(req: &HookRequest) -> String {
    if let Some(lane) = req
        .lane_id
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        return format!("lane:{lane}");
    }
    if let Some(conversation) = first_str(&req.payload, CONVERSATION_KEYS) {
        return format!("cursor:{conversation}");
    }
    if let Some(session) = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return format!("cursor:{session}");
    }
    match req.pid {
        Some(pid) => format!("cursor:pid-{pid}"),
        None => "cursor:unknown".to_string(),
    }
}

/// The event this is, accepting both the short argv name and Cursor's own event name, because a user who
/// edits `hooks.json` by hand may write either. Unknown names are None, never a default.
fn event_name(event: &str) -> Option<&'static str> {
    match event.trim().to_ascii_lowercase().as_str() {
        "shell" | "beforeshellexecution" => Some(SHELL),
        "mcp" | "beforemcpexecution" => Some(MCP),
        "response" | "afteragentresponse" => Some(RESPONSE),
        "stop" => Some(STOP),
        _ => None,
    }
}

/// A string under the first of `keys` the object has. Nothing that is not a string is coerced: §32.5 rule 2's
/// point is that a payload we do not understand is left alone, not reinterpreted.
fn first_str<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .filter(|s| !s.trim().is_empty())
}

fn first_val<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(*k))
}

/// A card title is one line. A pasted stack trace is not.
fn one_line(s: &str) -> String {
    let mut out: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 90 {
        out = out.chars().take(89).collect::<String>() + "\u{2026}";
    }
    out
}

// === the file the Connect page installs ===========================================================================

/// The path the shipped `integrations/cursor/hooks.json` carries, and the exact string the Connect page
/// replaces with the real install path. A visible `<you>` cannot be mistaken for a working path.
pub const EXE_PLACEHOLDER: &str = r"C:\Users\<you>\AppData\Local\Mewndo\bin\mewndo-hook.exe";

/// How long `hooks.json` asks Cursor to wait, in milliseconds.
///
/// **The field name is a guess and the number is deliberately not load-bearing.** §32.5 rule 3 lists
/// "Cursor's hook timeout field" as unsettled, so this handler's own [`ASK_WAIT`] is shorter than this and
/// does the real bounding. If Cursor ignores the field entirely, an ask still ends in 25 s with silence
/// rather than a hung editor.
pub const HOOK_TIMEOUT_MS: u64 = 30_000;

/// `integrations/cursor/hooks.json`, built from a real path, in exactly the shape §33.10 Part F step 4 gives:
/// `{"version": 1, "hooks": {"beforeShellExecution": [{"command": "\"<abs>\" cursor shell"}], …}}`.
///
/// The Connect page calls this instead of string-replacing in the shipped file, so a path with a space or a
/// quote is escaped by `serde_json` rather than by hand. The shipped file is this function's output for
/// [`EXE_PLACEHOLDER`], and a test asserts they are the same JSON.
pub fn hooks_json(exe: &std::path::Path) -> String {
    let run = |event: &str| {
        serde_json::json!([{
            "command": format!("\"{}\" cursor {event}", exe.to_string_lossy()),
            // GUESS; see HOOK_TIMEOUT_MS. Sent because a hook that waits for a person needs more than a
            // default meant for a script, and harmless if Cursor does not read it.
            "timeout_ms": HOOK_TIMEOUT_MS,
        }])
    };
    serde_json::to_string_pretty(&serde_json::json!({
        "version": 1,
        "hooks": {
            "beforeShellExecution": run(SHELL),
            "beforeMCPExecution": run(MCP),
            "afterAgentResponse": run(RESPONSE),
            "stop": run(STOP),
        }
    }))
    .expect("a tree of strings and numbers always serializes")
        + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::Via;
    use mewndo_router::CompiledRules;
    use std::path::Path;

    // --- the samples ---------------------------------------------------------------------------------------------

    fn samples_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/samples/cursor")
            .canonicalize()
            .expect(
                "docs/samples/cursor exists; it is this handler's only record of Cursor's shape",
            )
    }

    fn sample(name: &str) -> Value {
        let path = samples_dir().join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

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
        assert!(seen >= 5, "expected the five Cursor samples, found {seen}");
        // The README has to name the output fields too, because those are the guesses that can be silently
        // ignored by Cursor rather than noisily wrong.
        let readme = std::fs::read_to_string(dir.join("README.md")).unwrap();
        for key in [
            "permission",
            "agent_message",
            "followup_message",
            "timeout_ms",
        ] {
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

    fn inbox() -> Inbox {
        Inbox::start(
            mewndo_inbox::Config {
                // Short, not zero: §33.4's grace is real and the release still has to go through it.
                grace: Duration::from_millis(10),
                ..Default::default()
            },
            mewndo_inbox::Deps::default(),
        )
    }

    /// A handler with an Inbox and short waits, so the waiting tests take milliseconds.
    fn handler() -> Cursor {
        let mut cursor = Cursor::new(router(), Some(inbox()));
        cursor.session.mode = Mode::Active;
        cursor.session.project = "shop".into();
        cursor.ask_wait = Duration::from_secs(5);
        cursor.reply_window = Duration::from_secs(5);
        cursor
    }

    fn req(event: &str, payload: Value) -> HookRequest {
        HookRequest {
            agent: "cursor".into(),
            event: event.into(),
            session_id: None,
            pid: Some(5151),
            cwd: Some("/work/shop".into()),
            lane_id: None,
            payload,
        }
    }

    /// The first `inbox.card` the Inbox publishes, with its id, so a test can answer it.
    async fn next_card(
        events: &mut tokio::sync::broadcast::Receiver<mewndo_inbox::Event>,
    ) -> mewndo_proto::InboxCard {
        loop {
            match events.recv().await.expect("the Inbox is alive") {
                mewndo_inbox::Event::Card(c) => return c,
                _ => continue,
            }
        }
    }

    // --- each event against its sample ---------------------------------------------------------------------------

    #[tokio::test]
    async fn before_shell_execution_reads_its_sample() {
        let payload = sample("before-shell-execution.json");
        let cursor = handler();
        let input = cursor
            .action(&req(SHELL, payload.clone()), Pre::Shell)
            .unwrap();
        assert_eq!(input.tool, "shell");
        assert_eq!(input.input["command"], "git push --force origin main");
        assert_eq!(input.cwd, PathBuf::from(r"C:\Users\ana\code\shop"));
        assert_eq!(input.agent_kind, "cursor");

        // `git push --force` is on §34.9 R1's ask list, which for Cursor means the hook waits for a card --
        // that path has its own tests below. Here: the Router really does say ask.
        assert_eq!(cursor.router.guard(&input).decision.verdict, Verdict::Ask);
    }

    #[tokio::test]
    async fn before_mcp_execution_reads_its_sample_and_denies_a_protected_path() {
        let payload = sample("before-mcp-execution.json");
        let cursor = handler();
        let input = cursor.action(&req(MCP, payload.clone()), Pre::Mcp).unwrap();
        // The tool keeps its own name, prefixed so the router classifies it as MCP and §34.2 applies.
        assert_eq!(
            input.tool, "mcp__filesystem__write_file",
            "server_name wins over url (SERVER_KEYS)"
        );
        assert_eq!(input.input["path"], r"C:\Users\ana\.ssh\config");

        // The sample writes into ~/.ssh, which is on the protected list, so this is a hard deny.
        let out = cursor.handle(&req(MCP, payload)).await;
        let json: Value = serde_json::from_str(&out.stdout).expect("a deny is JSON");
        assert_eq!(json["permission"], "deny");
        assert!(
            json["agent_message"].as_str().unwrap().len() > 10,
            "a deny carries a reason"
        );
        assert_eq!(out.exit_code, 0);
        // The shape is the forwarder's shape (failopen.rs::deny_json("cursor", …)); change both or neither.
        assert_eq!(json.as_object().unwrap().len(), 2);
        assert!(json.get("hookSpecificOutput").is_none());
    }

    #[tokio::test]
    async fn after_agent_response_reads_its_sample_and_says_nothing() {
        let payload = sample("after-agent-response.json");
        assert!(
            first_str(&payload, TEXT_KEYS)
                .unwrap()
                .contains("ISO strings")
        );
        assert_eq!(handler().handle(&req(RESPONSE, payload)).await, silent());
    }

    #[tokio::test]
    async fn an_allowed_command_gets_the_allow_the_router_gave() {
        let cursor = handler();
        let payload = serde_json::json!({
            "conversation_id": "conv_1",
            "cwd": "/work/shop",
            "command": "npm test -- checkout",
        });
        let out = cursor.handle(&req(SHELL, payload)).await;
        let json: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(json["permission"], "allow");
        // Nothing else: an allow has no message to carry.
        assert_eq!(json.as_object().unwrap().len(), 1);
    }

    // --- the Cursor stop followup_message ------------------------------------------------------------------------

    #[tokio::test]
    async fn stop_creates_a_done_card_and_a_reply_becomes_followup_message() {
        let cursor = handler();
        let inbox = cursor.inbox.clone().unwrap();
        let mut events = inbox.subscribe();
        let payload = sample("stop.json");

        let waiting = tokio::spawn({
            let r = req(STOP, payload.clone());
            let cursor = Cursor {
                router: cursor.router.clone(),
                inbox: Some(inbox.clone()),
                session: cursor.session.clone(),
                ask_wait: cursor.ask_wait,
                reply_window: cursor.reply_window,
            };
            async move { cursor.handle(&r).await }
        });

        let card = next_card(&mut events).await;
        assert_eq!(card.kind, "done");
        assert_eq!(card.agent_id, "cursor:conv_01K6Y2M4Q8ZT3NB7V0JX");
        assert_eq!(card.options, vec!["Seen".to_string(), "Reply".to_string()]);

        // The user types a reply (§33.5's Space, or V through Wispr Flow).
        let id = card.id.parse().unwrap();
        inbox
            .answer(
                id,
                mewndo_inbox::text(id, "also convert the checkout page", Via::Key),
            )
            .await;

        let out = waiting.await.unwrap();
        // §33.10 Part F step 6, verbatim.
        assert_eq!(
            out.stdout,
            r#"{"followup_message":"also convert the checkout page"}"#
        );
        assert_eq!(out.exit_code, 0);
        let json: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(json["followup_message"], "also convert the checkout page");
        assert_eq!(json.as_object().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_stop_with_no_reply_says_nothing_when_the_window_closes() {
        let mut cursor = handler();
        cursor.reply_window = Duration::from_millis(60);
        let out = cursor.handle(&req(STOP, sample("stop.json"))).await;
        assert_eq!(out, silent(), "the window closed; §33.2 says that is that");

        // "Seen" is an answer, but not a reply: there is nothing to send Cursor.
        let cursor = handler();
        let inbox = cursor.inbox.clone().unwrap();
        let mut events = inbox.subscribe();
        let handle = tokio::spawn({
            let (r, inbox, session) = (
                req(STOP, sample("stop.json")),
                inbox.clone(),
                cursor.session.clone(),
            );
            let c = Cursor {
                router: cursor.router.clone(),
                inbox: Some(inbox),
                session,
                ask_wait: cursor.ask_wait,
                reply_window: cursor.reply_window,
            };
            async move { c.handle(&r).await }
        });
        let card = next_card(&mut events).await;
        let id = card.id.parse().unwrap();
        inbox
            .answer(id, mewndo_inbox::choice(id, 0, Via::Key))
            .await;
        assert_eq!(handle.await.unwrap(), silent());

        // A reply window of zero is "no reply window": the card is made and the hook returns at once.
        let mut cursor = handler();
        cursor.reply_window = Duration::ZERO;
        let mut events = cursor.inbox.as_ref().unwrap().subscribe();
        assert_eq!(
            cursor.handle(&req(STOP, sample("stop.json"))).await,
            silent()
        );
        assert_eq!(next_card(&mut events).await.kind, "done");
        // And the settable range §33.2 gives.
        assert!(REPLY_WINDOW <= REPLY_WINDOW_MAX && REPLY_WINDOW == Duration::from_secs(15));
    }

    // --- the Cursor ask: waiting for a card, and returning allow and deny ----------------------------------------

    /// Run one `beforeShellExecution` that the Router asks about, answer its card with option `choice`, and
    /// give back what Cursor would have been told.
    async fn ask_and_answer(choice: usize, reason: Option<&str>) -> HookResponse {
        let cursor = handler();
        let inbox = cursor.inbox.clone().unwrap();
        let mut events = inbox.subscribe();
        let payload = sample("before-shell-execution.json");

        let waiting = tokio::spawn({
            let (r, inbox, session) = (req(SHELL, payload), inbox.clone(), cursor.session.clone());
            let c = Cursor {
                router: cursor.router.clone(),
                inbox: Some(inbox),
                session,
                ask_wait: cursor.ask_wait,
                reply_window: cursor.reply_window,
            };
            async move { c.handle(&r).await }
        });

        let card = next_card(&mut events).await;
        assert_eq!(
            card.kind, "permission",
            "an ask must put a permission card up"
        );
        assert!(card.title.contains("git push"), "{}", card.title);
        // §33.2's three options, with "add a reason" after them.
        assert_eq!(
            card.options[..3],
            ["Allow once", "Always allow here", "Deny"]
        );

        let id: mewndo_inbox::CardId = card.id.parse().unwrap();
        let answer = match reason {
            Some(text) => Answer {
                card_id: card.id.clone(),
                choice: Some(choice),
                text: Some(text.to_string()),
                via: Via::Key,
            },
            None => mewndo_inbox::choice(id, choice, Via::Key),
        };
        inbox.answer(id, answer).await;
        waiting.await.unwrap()
    }

    #[tokio::test]
    async fn the_cursor_ask_waits_for_the_card_and_returns_allow() {
        // Option 0, "Allow once".
        let json: Value = serde_json::from_str(&ask_and_answer(0, None).await.stdout).unwrap();
        assert_eq!(json["permission"], "allow");
        assert_eq!(json.as_object().unwrap().len(), 1);

        // Option 1, "Always allow here", means allow too -- mewndo-inbox's rule, not a second copy of it.
        let json: Value = serde_json::from_str(&ask_and_answer(1, None).await.stdout).unwrap();
        assert_eq!(json["permission"], "allow");
    }

    #[tokio::test]
    async fn the_cursor_ask_waits_for_the_card_and_returns_deny() {
        // Option 2, "Deny".
        let out = ask_and_answer(2, None).await;
        let json: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(json["permission"], "deny");
        assert!(
            json["agent_message"]
                .as_str()
                .unwrap()
                .starts_with("The user answered in Mewndo: no."),
            "{}",
            json["agent_message"]
        );
        assert_eq!(out.exit_code, 0);

        // A typed reason travels with the deny, so Cursor's model is told what to do instead.
        let out = ask_and_answer(2, Some("push to a branch instead")).await;
        let json: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(json["permission"], "deny");
        assert!(
            json["agent_message"]
                .as_str()
                .unwrap()
                .contains("push to a branch instead")
        );

        // Option 3 is "Add a reason", which teaches nothing and is not an answer: silence, not an allow.
        assert_eq!(ask_and_answer(3, Some("hmm")).await, silent());
    }

    #[tokio::test]
    async fn an_ask_that_is_never_answered_ends_in_silence_and_never_an_allow() {
        // The wait runs out.
        let mut cursor = handler();
        cursor.ask_wait = Duration::from_millis(60);
        let out = cursor
            .handle(&req(SHELL, sample("before-shell-execution.json")))
            .await;
        assert_eq!(out, silent(), "a timed-out ask must not become an allow");

        // There is no Inbox at all: the same answer, because Cursor's own flow is the fallback.
        let mut cursor = Cursor::new(router(), None);
        cursor.session.mode = Mode::Active;
        let out = cursor
            .handle(&req(SHELL, sample("before-shell-execution.json")))
            .await;
        assert_eq!(out, silent());

        // The card carries the handler's own deadline, so the user cannot answer a question whose answer can
        // no longer be delivered (§33.9).
        let cursor = handler();
        let input = cursor
            .action(
                &req(SHELL, sample("before-shell-execution.json")),
                Pre::Shell,
            )
            .unwrap();
        let guarded = cursor.router.guard(&input);
        let card = cursor.permission_card(
            &req(SHELL, sample("before-shell-execution.json")),
            &input,
            &guarded,
            "r",
        );
        assert_eq!(card.deadline, Some(cursor.ask_wait));
        assert_eq!(card.risk, 4, "a force push is destructive by the rules");
        assert_eq!(card.permission.as_ref().unwrap().agent_kind, "cursor");
        assert_eq!(card.permission.as_ref().unwrap().project, "shop");
        assert!(
            ASK_WAIT < Duration::from_millis(HOOK_TIMEOUT_MS),
            "Mewndo must give up before Cursor does"
        );
    }

    // --- malformed input: no output, no panic --------------------------------------------------------------------

    #[tokio::test]
    async fn malformed_input_produces_no_output_and_no_panic() {
        let cursor = handler();
        let junk = [
            sample("malformed.json"),
            Value::Null,
            Value::Bool(false),
            // What the forwarder sends when stdin was not JSON (mewndo-hook/src/lib.rs::payload_of).
            Value::String("{\"command\":\"rm -rf /\"".into()),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!({"command": ""}),
            serde_json::json!({"command": 17}),
            serde_json::json!({"command": {"argv": ["rm", "-rf", "/"]}}),
            serde_json::json!({"tool_name": null, "tool_input": {}}),
            serde_json::json!({"conversation_id": ["not", "a", "string"]}),
            serde_json::json!({"command": "x".repeat(100_000)}),
        ];
        for payload in junk {
            for event in [
                SHELL,
                MCP,
                RESPONSE,
                STOP,
                "",
                "beforeShellExecution",
                "nonsense",
            ] {
                let out = cursor.handle(&req(event, payload.clone())).await;
                assert_eq!(
                    out.exit_code, 0,
                    "{event} on {payload:?} must fail open (§32.5 rule 7)"
                );
                assert!(
                    !out.stdout.contains("\"allow\""),
                    "{event} on {payload:?} printed an allow: {:?}",
                    out.stdout
                );
                if !out.stdout.is_empty() {
                    serde_json::from_str::<Value>(&out.stdout).unwrap_or_else(|e| {
                        panic!("{event} printed non-JSON {:?}: {e}", out.stdout)
                    });
                }
            }
        }
        // A command that is not a string is not read, so no action is guarded at all.
        assert!(
            cursor
                .action(&req(SHELL, serde_json::json!({"command": 1})), Pre::Shell)
                .is_none()
        );
        assert!(
            cursor
                .action(&req(MCP, serde_json::json!({})), Pre::Mcp)
                .is_none()
        );
    }

    #[tokio::test]
    async fn an_ask_is_never_printed_because_mewndo_cannot_answer_the_prompt_it_opens() {
        let cursor = handler();
        let payloads = [
            sample("before-shell-execution.json"),
            sample("before-mcp-execution.json"),
            sample("malformed.json"),
            Value::Null,
        ];
        // ask_wait is short enough that the unanswered ask resolves inside the test.
        let mut cursor = Cursor {
            router: cursor.router.clone(),
            inbox: cursor.inbox.clone(),
            session: cursor.session.clone(),
            ask_wait: Duration::from_millis(40),
            reply_window: Duration::from_millis(40),
        };
        cursor.session.mode = Mode::Active;
        for event in [SHELL, MCP, RESPONSE, STOP] {
            for payload in &payloads {
                let out = cursor.handle(&req(event, payload.clone())).await;
                assert!(
                    !out.stdout.contains("\"ask\""),
                    "{event} printed an ask Mewndo cannot answer: {:?}",
                    out.stdout
                );
            }
        }
    }

    // --- MEWNDO_LANE_ID ------------------------------------------------------------------------------------------

    #[test]
    fn the_lane_id_from_the_forwarders_environment_names_the_agent() {
        let mut r = req(STOP, sample("stop.json"));
        assert_eq!(agent_id(&r), "cursor:conv_01K6Y2M4Q8ZT3NB7V0JX");

        r.lane_id = Some("01JLANE7QX".into());
        assert_eq!(agent_id(&r), "lane:01JLANE7QX");
        assert_eq!(
            mewndo_pty::LANE_ID_ENV,
            "MEWNDO_LANE_ID",
            "the name the forwarder reads"
        );

        r.lane_id = Some(" ".into());
        assert_eq!(agent_id(&r), "cursor:conv_01K6Y2M4Q8ZT3NB7V0JX");
        r.payload = Value::Null;
        assert_eq!(agent_id(&r), "cursor:pid-5151");
        r.session_id = Some("s9".into());
        assert_eq!(agent_id(&r), "cursor:s9");
        r.session_id = None;
        r.pid = None;
        assert_eq!(agent_id(&r), "cursor:unknown");
    }

    // --- the shipped integration file ----------------------------------------------------------------------------

    #[test]
    fn the_shipped_hooks_json_is_this_files_own_output_and_has_part_f_step_4s_shape() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../integrations/cursor")
            .canonicalize()
            .expect("integrations/cursor exists (§38.4)");
        let shipped: Value =
            serde_json::from_slice(&std::fs::read(dir.join("hooks.json")).unwrap())
                .expect("integrations/cursor/hooks.json is JSON");
        assert_eq!(
            shipped,
            serde_json::from_str::<Value>(&hooks_json(Path::new(EXE_PLACEHOLDER))).unwrap(),
            "the shipped file and hooks_json() must not drift: the Connect page writes the second one"
        );

        // §33.10 Part F step 4, field for field.
        assert_eq!(shipped["version"], 1);
        let hooks = shipped["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), 4);
        for (event, arg) in [
            ("beforeShellExecution", SHELL),
            ("beforeMCPExecution", MCP),
            ("afterAgentResponse", RESPONSE),
            ("stop", STOP),
        ] {
            let command = hooks[event][0]["command"]
                .as_str()
                .unwrap_or_else(|| panic!("{event}"));
            assert_eq!(
                command,
                format!("\"{EXE_PLACEHOLDER}\" cursor {arg}"),
                "{event} must be exactly the spec's `\"<abs>\" cursor {arg}`"
            );
            assert!(
                event_name(arg).is_some(),
                "{event} passes {arg}, which is unknown"
            );
        }
        assert!(
            EXE_PLACEHOLDER.contains("<you>"),
            "the placeholder must be visibly not a real path"
        );
    }

    #[test]
    fn an_mcp_server_name_becomes_one_safe_token() {
        assert_eq!(slug("http://127.0.0.1:7391/mcp"), "127_0_0_1_7391_mcp");
        assert_eq!(slug("filesystem"), "filesystem");
        assert_eq!(slug("  My Server!  "), "my_server");
        assert_eq!(
            slug("***"),
            "cursor",
            "a name with nothing usable in it still names something"
        );
        assert_eq!(
            mcp_tool_name(
                &serde_json::json!({"server_name": "filesystem"}),
                "write_file"
            ),
            "mcp__filesystem__write_file"
        );
        assert_eq!(
            mcp_tool_name(&Value::Null, "write_file"),
            "mcp__cursor__write_file"
        );
        assert_eq!(
            mcp_tool_name(&Value::Null, "mcp__x__y"),
            "mcp__x__y",
            "an already-prefixed name is left alone"
        );
    }
}
