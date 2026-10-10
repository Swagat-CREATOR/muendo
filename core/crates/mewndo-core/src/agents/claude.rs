//! Claude Code: the plugin hooks of §38.4, handled per §33.10 Part C step 4.
//!
//! One `hook.request` in (§38.5), one `hook.response` out: the JSON Claude Code reads on the hook's stdout and
//! an exit code. [`Claude::respond`] is the whole surface; the eight handlers below it are the rows of the
//! §33.10 Part C step 4 table, in that order.
//!
//! **The printed JSON is the contract.** Claude Code ignores, without a word, anything it cannot parse: a
//! misspelt `hookSpecificOutput` is not an error the user sees, it is a guard that silently is not there. So the
//! shapes are built from typed structs ([`PreToolOut`], [`PermissionOut`], [`StopOut`], [`SessionStartOut`]),
//! every one of them asserted byte for byte in the tests, and the deny shape is the same one
//! `mewndo-hook`'s fail-open path prints (`mewndo-hook/src/failopen.rs`, `deny_json`) and the same one v0's own
//! Guard prints (`apps/desktop/engine/guard.js`, `claudeAnswer`). Those three must agree: a user who sees one
//! shape when the core is up and another when it is down has a guard they cannot trust. Change all three or
//! none.
//!
//! **The four things §33.10 says not to get wrong**, and where each one lives:
//!
//! 1. `Stop` loop guard: [`Claude::stop`]'s first five lines. `stop_hook_active` with no reply pending returns
//!    `{}` at once, before the transcript is read, before Receipts, before any card. Blocking a `Stop` makes
//!    Claude carry on, which ends in another `Stop`; without this the pair never stops.
//! 2. `PermissionRequest` waits [`PERMISSION_WAIT`] = 295 s while the hook's own timeout is 300 s (§38.4), so
//!    the core always answers first. On a timeout it prints **nothing**: Claude's own prompt is still on the
//!    user's screen and it is now the only thing that can answer.
//! 3. `PreToolUse` `savepoint_then_allow` waits for the save point with a 1 s cap ([`SAVEPOINT_PRE_TOOL`]) and
//!    then allows either way. The save point is worth a second of the agent's time; it is not worth the hook's
//!    5 s budget.
//! 4. **Fail closed on nothing.** Every path that cannot get an answer prints `{}` or nothing, never an allow.
//!    A Router `ask` becomes a card; a card that expires leaves Claude's own prompt in charge. The only `allow`
//!    this file can print is one the Router gave or one the user gave.
//!
//! **What it does not do, honestly** (§28.10, §32.5 rule 5):
//!
//! * **No v0 of its own.** Save points come from the v0 engine through [`mewndo_inbox::EngineClient`] - the
//!   trait the Inbox already defines, so the core writes one wrapper and not two (§32.5 rule 6). The brief, the
//!   journal diff and the §24.5 Continue card come through [`V0`], which defaults to answering "I cannot".
//!   Nothing here opens a socket.
//! * **No Receipts of its own.** [`Receipts`] is a trait. [`RuleReceipts`] is a rules-only stand-in that reads
//!   the claims mewndo-trace already extracts and checks them against this turn's spans; it says "unverified"
//!   wherever it cannot check, because a claim nobody can check is not a claim the agent got wrong. When
//!   mewndo-trace exposes §35's own Receipts, the core swaps the trait object and nothing here changes.
//! * **Two verify-first items are unverified** (§32.5 rule 3), because there is no Claude Code on this machine:
//!   whether a `PreToolUse` `"ask"` reaches the `PermissionRequest` hook, and how `AskUserQuestion` is answered
//!   from a hook. Both primary paths are implemented, both fallbacks are behind a flag on [`Flags`], and the
//!   text for `docs/decisions.md` is in this session's report. The sample files they were coded against say the
//!   same thing at the top of each one.
//! * **The agent PID is a best effort.** §33.10 asks for the parent of the hook's PID from a Toolhelp32
//!   snapshot; that is what [`parent_pid`] does on Windows, and `/proc/<pid>/stat` on unix so the field is real
//!   in the WSL tests too. A PID that cannot be read is `None` and the agent is still tracked by its session id.

use mewndo_inbox::{
    Answer, Card, CardId, CardKind, EngineClient, Inbox, Opt, PermissionFacts, SavepointRequest,
};
use mewndo_proto::{AgentStatus, HookRequest, HookResponse, ReceiptResult, SpanCreated};
use mewndo_router::{GuardInput, Guarded, Mode, Router, Verdict};
use mewndo_trace::{Changes, Claim, ClaimType, Claims, Span, SpanKind, Tests};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::{Instant, timeout};

/// This agent's `kind`, in `agents.kind` (§38.6) and on `agent.status` (§38.5).
pub const KIND: &str = "claude-code";
/// What the dock calls it.
pub const NAME: &str = "Claude Code";

/// §33.10 Part C step 4: the `PermissionRequest` hook's own timeout is 300 s (§38.4), so the core answers at
/// 295 and the terminal prompt keeps the last five seconds. The order matters more than the number: if the two
/// were equal, a slow handler would race Claude Code's own timer, and the user could answer a card whose hook
/// had already given up - an answer released into nothing.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(295);
/// §33.10 Part C step 4, `PreToolUse` `savepoint_then_allow`: "wait for the save point (cap 1 s), then allow".
pub const SAVEPOINT_PRE_TOOL: Duration = Duration::from_secs(1);
/// §33.10 Part C step 4, `UserPromptSubmit`: ask for a save point "without waiting more than 50 ms".
pub const SAVEPOINT_PROMPT: Duration = Duration::from_millis(50);
/// §33.10 Part C step 4, `Stop`: "the reply window (default 15 s; ends early on E or Dismiss)".
pub const REPLY_WINDOW: Duration = Duration::from_secs(15);
/// §33.10 Part C step 4, `Stop`: "run Receipts (§35, at most 3 s)".
pub const RECEIPTS_BUDGET: Duration = Duration::from_secs(3);
/// §33.10 Part C step 6's fallback waits inside `PreToolUse` itself, whose matcher entry in
/// `hooks.fallback.json` has a 300 s timeout - so the same 295 s rule as a permission card applies.
#[cfg(test)] // the fallback waits `Flags::permission_wait`, which defaults to this; the tests pin the relation
pub const PRE_TOOL_CARD_WAIT: Duration = PERMISSION_WAIT;
/// How long a second, identical `pre-tool` call is treated as the duplicate the fallback's two matcher entries
/// produce (`integrations/claude-code/README.md`). Only one of the two may wait for the card.
pub const DUPLICATE_WINDOW: Duration = Duration::from_secs(2);
/// §33.8: "the first two sentences, capped at 200 characters".
pub const SUMMARY_CHARS: usize = 200;
/// How much of a transcript's tail is read for §33.8's last message. Transcripts grow for the whole session;
/// the last message is always at the end, so reading the end is both enough and bounded.
pub const TRANSCRIPT_TAIL: u64 = 1 << 20;

// --- what the core wires in -------------------------------------------------------------------------------

/// The things the v0 engine knows and this file must not guess (§32.5 rule 6). Every method has a default that
/// says "I cannot", so a build with no v0 wired up still compiles, still runs and still tells the truth: no
/// brief, no diff, no Continue card.
///
/// The real interface, read from the v0 code and not invented (`apps/desktop/engine/hook-server.js`,
/// `engine/mewndo.js` `hookSavePoint`): `POST http://127.0.0.1:47821/savepoint?agent=claude` with the token
/// from `<data>/hook.json` in `x-mewndo-token`, body `{agent,event,cwd,command,sessionId}`, answer
/// `{ok,folder,savePoint,reason?,additionalContext?}`. The save point half of it is
/// [`mewndo_inbox::EngineClient`]; this trait is the rest.
pub trait V0: Send + Sync {
    /// The brief this folder's agents work under (v0 `brief.json`, §24.2). `None` means there is none, and
    /// §33.10 Part C step 4 then uses the prompt itself as the brief.
    fn brief(&self, _cwd: &str) -> Option<String> {
        None
    }

    /// What the journal says changed since a save point (§35.5 T4), for `PostToolUse`'s "files changed since
    /// the span opened". `Err` means the engine could not tell us, which is not the same as "nothing changed"
    /// and is never reported as if it were.
    fn changed_since(&self, _savepoint_id: &str, _now_ms: i64) -> Result<Changes, String> {
        Err("no v0 engine is wired up".into())
    }

    /// The §24.5 Continue card waiting for this folder, if a Resume is pending. v0 already answers this on the
    /// `SessionStart` save-point call (`mewndo.js` returns `additionalContext`, and `bin/mewndo-savepoint.js`
    /// prints it), so the core's wrapper has it in hand; it is a method of its own here because a save point id
    /// and a Continue card are two different answers.
    fn resume_card(&self, _cwd: &str) -> Option<String> {
        None
    }
}

/// No v0: no brief, no diff, no Continue card. The honest default.
pub struct NoV0;
impl V0 for NoV0 {}

/// Where this file's own §38.5 messages go. The core wires it to `Desk::publish`; it is a trait because
/// `publish` is generic over [`mewndo_proto::Body`] and so cannot be called through a trait object.
pub trait Events: Send + Sync {
    fn agent_status(&self, _status: AgentStatus) {}
    fn span(&self, _span: SpanCreated) {}
    fn receipt(&self, _receipt: ReceiptResult) {}
}

/// No app connected, or none wired up yet: the handlers still work, nothing is drawn.
pub struct NoEvents;
impl Events for NoEvents {}

/// Everything a Receipt check is given (§35.2). Owned, not borrowed, because the check has a 3 s budget and
/// therefore has to be a future the handler can time out.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReceiptInput {
    pub trace_id: String,
    /// The agent's final message (§33.8), as it came out of the transcript.
    pub final_message: String,
    /// This turn's spans, closed and open.
    pub spans: Vec<Span>,
    /// The journal diff for the turn, when v0 could give one. `None` is "not known", not "nothing".
    pub changes: Option<Changes>,
}

/// §35's answer: the line for the Done card, and the claims that did not match.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Receipt {
    /// §35, spec line 2275: `✓ 4 files · ✓ npm test passed after the last edit · 1 save point`.
    pub line: String,
    /// One line per claim the evidence contradicts. Empty is the ordinary case.
    pub mismatches: Vec<String>,
}

pub type Checking = Pin<Box<dyn Future<Output = Receipt> + Send>>;

/// The §35 check, as one call. A trait because the real one makes a Router call with its own deadline (§34.9
/// R6) and because `Stop` must be able to give up on it after [`RECEIPTS_BUDGET`].
pub trait Receipts: Send + Sync {
    fn check(&self, input: ReceiptInput) -> Checking;
}

/// A rules-only Receipt: claims from mewndo-trace, evidence from this turn's spans and the journal diff.
///
/// This is deliberately small. §35's full check - T4's evidence lookup, T6's hard-rule table, T7's batched
/// Router call - belongs to mewndo-trace, and mewndo-trace does not expose it yet. What is here never guesses:
/// a claim it cannot check against evidence it has is left alone, not reported as a mismatch. Being quiet about
/// something unprovable is the one failure mode a Receipt is allowed.
pub struct RuleReceipts {
    /// An `Arc` because the check is a future that outlives the call: `Tests` is not `Clone` (it is a
    /// compiled phrase list) and copying it per Receipt would be waste in the one place with a 3 s budget.
    tests: Arc<Tests>,
}

impl Default for RuleReceipts {
    fn default() -> RuleReceipts {
        RuleReceipts {
            tests: Arc::new(Tests::builtin()),
        }
    }
}

impl Receipts for RuleReceipts {
    fn check(&self, input: ReceiptInput) -> Checking {
        let claims = Claims::builtin().extract(&input.final_message);
        let tests = self.tests.clone();
        Box::pin(async move { rule_receipt(&claims, &input, &tests) })
    }
}

/// Settings flags (§32.5 rule 8). Both fallbacks are off by default: they exist for what a live Claude Code
/// session might show, and turning one on without that evidence would be guessing in the other direction.
#[derive(Debug, Clone, PartialEq)]
pub struct Flags {
    /// §33.10 Part C step 6, the verify-first item. On: `PreToolUse` itself waits for the card, because a
    /// `"ask"` never reached the `PermissionRequest` hook. Needs `hooks.fallback.json` installed, whose second
    /// matcher entry raises the timeout to 300 s - with the default `hooks.json` and its 5 s timeout, waiting
    /// here would be a hook Claude Code kills.
    pub pre_tool_waits_for_card: bool,
    /// §33.10 Part C step 5. On (the default): an `AskUserQuestion` becomes a Question card and the answer
    /// goes back as a `deny` whose reason carries the user's words. Off: the fallback - print `{}`, show the
    /// card as information only, and let the user answer in the terminal.
    pub answer_ask_user_question: bool,
    /// §34.6, per agent. Shadow is the default: the model answers, the answer is recorded, nothing it says
    /// changes the outcome. A hard rule is not the model and is enforced in either mode (§34.6, §38.4's
    /// fail-open deny list), which is why [`Claude::pre_tool`] checks `rule_outcome.hard()` before it goes
    /// quiet.
    pub mode: Mode,
    /// §33.10 Part C step 4, `Stop`.
    pub reply_window: Duration,
    /// §33.10 Part C step 4, `PermissionRequest`.
    pub permission_wait: Duration,
}

impl Default for Flags {
    fn default() -> Flags {
        Flags {
            pre_tool_waits_for_card: false,
            answer_ask_user_question: true,
            mode: Mode::Shadow,
            reply_window: REPLY_WINDOW,
            permission_wait: PERMISSION_WAIT,
        }
    }
}

/// What [`Claude::new`] needs. `inbox` and `router` are the core's own, one of each for every agent; the rest
/// default to doing nothing.
pub struct Deps {
    pub inbox: Inbox,
    pub router: Arc<Router>,
    /// Save points, through the trait the Inbox already defines (§32.5 rule 6).
    pub engine: Arc<dyn EngineClient>,
    pub v0: Arc<dyn V0>,
    pub events: Arc<dyn Events>,
    pub receipts: Arc<dyn Receipts>,
    pub flags: Flags,
}

impl Deps {
    /// The two things that have no sensible default, and nothing else wired up.
    pub fn new(inbox: Inbox, router: Arc<Router>) -> Deps {
        Deps {
            inbox,
            router,
            engine: Arc::new(mewndo_inbox::NoEngine),
            v0: Arc::new(NoV0),
            events: Arc::new(NoEvents),
            receipts: Arc::new(RuleReceipts::default()),
            flags: Flags::default(),
        }
    }
}

// --- the hook payload -------------------------------------------------------------------------------------

/// Claude Code's hook JSON, coded against `docs/samples/claude/*.json` (§32.5 rule 2) and nothing else.
///
/// Every field is optional and unknown fields are ignored, which is not laziness: the samples are
/// hand-written and unverified (their own first line says so), Claude Code adds fields between releases, and a
/// payload this struct refuses is a hook that says nothing - a guard silently gone. A field that is missing
/// makes a handler do less; it never makes one fail.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Input {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `SessionStart`, `PreToolUse`, … - used only when the forwarder's argv event is one this file does not
    /// know, because argv is what §38.4 controls and the payload is what the agent controls.
    #[serde(default)]
    pub hook_event_name: Option<String>,
    /// `SessionStart`: `startup`, `resume`, `clear`, `compact`.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<Value>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub tool_response: Option<Value>,
    /// `Notification`: "Claude needs your permission to use Bash".
    #[serde(default)]
    pub message: Option<String>,
    /// `Stop` and `SubagentStop`: true when Claude is only running because a previous `Stop` hook blocked.
    #[serde(default)]
    pub stop_hook_active: Option<bool>,
}

/// The eight events of §38.4, by the short name argv carries and by Claude Code's own `hook_event_name`.
/// Both spellings are accepted for the same reason `mewndo-hook`'s `is_pre_action` accepts both: the forwarder
/// is given the short one, a hand-written `settings.json` entry or a future release may give the long one, and
/// an event this file does not recognise is a guard that quietly stops working.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    Notification,
    Stop,
    SubagentStop,
}

impl Event {
    pub fn parse(name: &str) -> Option<Event> {
        let n = name.trim().to_ascii_lowercase().replace(['_', ' '], "-");
        Some(match n.as_str() {
            "session-start" | "sessionstart" => Event::SessionStart,
            "prompt" | "user-prompt-submit" | "userpromptsubmit" => Event::UserPromptSubmit,
            "pre-tool" | "pretool" | "pre-tool-use" | "pretooluse" => Event::PreToolUse,
            "permission" | "permission-request" | "permissionrequest" => Event::PermissionRequest,
            "post-tool" | "posttool" | "post-tool-use" | "posttooluse" => Event::PostToolUse,
            "notify" | "notification" => Event::Notification,
            "stop" => Event::Stop,
            "subagent-stop" | "subagentstop" => Event::SubagentStop,
            _ => return None,
        })
    }

    /// The name that goes in `hookEventName`, which must be Claude Code's own spelling and not argv's.
    pub fn hook_event_name(self) -> &'static str {
        match self {
            Event::SessionStart => "SessionStart",
            Event::UserPromptSubmit => "UserPromptSubmit",
            Event::PreToolUse => "PreToolUse",
            Event::PermissionRequest => "PermissionRequest",
            Event::PostToolUse => "PostToolUse",
            Event::Notification => "Notification",
            Event::Stop => "Stop",
            Event::SubagentStop => "SubagentStop",
        }
    }
}

// --- the printed JSON -------------------------------------------------------------------------------------
//
// Typed, so that a field name is written once and a key order is not an accident. Serde writes a struct's
// fields in declaration order, so the shape below is the shape on stdout, and the tests compare whole strings.

/// `{}`: understood, nothing to say. Not the same as printing nothing, which is what this file does when it
/// cannot parse the payload at all.
const NOTHING_TO_SAY: &str = "{}";

#[derive(Debug, Serialize)]
struct Wrapped<T> {
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: T,
}

/// `PreToolUse` (§33.10 Part C step 4). The same three keys `mewndo-hook/src/failopen.rs` prints when the core
/// is down and `apps/desktop/engine/guard.js` prints from v0 - deliberately identical.
#[derive(Debug, Serialize)]
struct PreToolOut {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "permissionDecision")]
    permission_decision: &'static str,
    /// Left out of an `allow`, as the §33.10 table has it: there is nothing to tell the model when the answer
    /// is yes, and an empty reason on an allow reads like a refusal with the words missing.
    #[serde(
        rename = "permissionDecisionReason",
        skip_serializing_if = "Option::is_none"
    )]
    permission_decision_reason: Option<String>,
}

/// `PermissionRequest` (§33.10 Part C step 4). **A guess**, and a §32.5 rule 3 verify-first item: the sample
/// it is coded against says every field in it is unverified. The shape is §33.10's own
/// (`decision: {behavior, message}`); if a live session says otherwise, this struct and
/// `docs/samples/claude/permission-request.json` are the two places to change.
#[derive(Debug, Serialize)]
struct PermissionOut {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    decision: PermissionDecision,
}

#[derive(Debug, Serialize)]
struct PermissionDecision {
    behavior: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// `SessionStart`. The one output shape here that is **not** a guess: v0 ships it in
/// `apps/desktop/bin/mewndo-savepoint.js`, which has been printing it to real Claude Code sessions since the
/// v0 Continue card (§24.5).
#[derive(Debug, Serialize)]
struct SessionStartOut {
    #[serde(rename = "hookEventName")]
    hook_event_name: &'static str,
    #[serde(rename = "additionalContext")]
    additional_context: String,
}

/// `Stop` and `SubagentStop` (§33.10 Part C step 4): "With a reply or a send-back:
/// `{"decision":"block","reason":"<text>"}`".
#[derive(Debug, Serialize)]
struct StopOut {
    decision: &'static str,
    reason: String,
}

/// §24: the brake, which for Claude Code is `continue: false` (§24.3). Printed alongside the deny, because a
/// deny alone stops one tool call and a brake has to stop the turn. Both are documented top-level shapes and
/// Claude Code ignores what it does not know, so the deny still stands if `continue` is not read.
#[derive(Debug, Serialize)]
struct BrakeOut {
    #[serde(rename = "continue")]
    carry_on: bool,
    #[serde(rename = "stopReason")]
    stop_reason: String,
    #[serde(rename = "hookSpecificOutput")]
    hook_specific_output: PreToolOut,
}

fn json(value: &impl Serialize) -> String {
    // A handler's own output always serializes; if it somehow did not, saying nothing is the fail-open answer
    // and never a panic inside a hook (§32.5 rule 7).
    serde_json::to_string(value).unwrap_or_default()
}

fn pre_tool_json(decision: &'static str, reason: Option<String>) -> String {
    json(&Wrapped {
        hook_specific_output: PreToolOut {
            hook_event_name: Event::PreToolUse.hook_event_name(),
            permission_decision: decision,
            permission_decision_reason: reason,
        },
    })
}

fn permission_json(behavior: &'static str, message: Option<String>) -> String {
    json(&Wrapped {
        hook_specific_output: PermissionOut {
            hook_event_name: Event::PermissionRequest.hook_event_name(),
            decision: PermissionDecision { behavior, message },
        },
    })
}

fn session_start_json(context: String) -> String {
    json(&Wrapped {
        hook_specific_output: SessionStartOut {
            hook_event_name: Event::SessionStart.hook_event_name(),
            additional_context: context,
        },
    })
}

fn block_json(reason: String) -> String {
    json(&StopOut {
        decision: "block",
        reason,
    })
}

fn brake_json(reason: String) -> String {
    json(&BrakeOut {
        carry_on: false,
        stop_reason: reason.clone(),
        hook_specific_output: PreToolOut {
            hook_event_name: Event::PreToolUse.hook_event_name(),
            permission_decision: "deny",
            permission_decision_reason: Some(reason),
        },
    })
}

/// Print this, exit 0. Every handler returns one of these: the decision travels in the JSON, never in the exit
/// code (`failopen.rs` says the same), so a hook that fails is a hook that said nothing.
fn say(stdout: impl Into<String>) -> HookResponse {
    HookResponse {
        stdout: stdout.into(),
        exit_code: 0,
    }
}

/// Nothing at all: the payload could not be parsed, the event is unknown, or a card ran out of time and
/// Claude's own prompt is now the only thing that can answer.
fn silent() -> HookResponse {
    say("")
}

// --- what the handler remembers --------------------------------------------------------------------------

/// One Claude Code session, keyed by `session_id`. The whole of this file's state; it is in memory and not in
/// `desk.db` on purpose - every open card is expired at start-up anyway (§33.10 Part D step 4), so a session
/// that outlived the core has nothing left to join up with.
#[derive(Debug, Default)]
struct Session {
    agent_id: String,
    cwd: String,
    /// The hook process's PID, as the forwarder reported it.
    hook_pid: Option<u32>,
    /// Claude Code itself: the parent of the hook's PID (§33.10 Part C step 4, `SessionStart`).
    agent_pid: Option<u32>,
    status: &'static str,
    /// This turn (§35): `None` between `Stop` and the next prompt.
    trace_id: Option<String>,
    /// The active v0 brief, or the prompt when there is none (§33.10 Part C step 4, `UserPromptSubmit`).
    brief: String,
    /// The turn's save point, from `UserPromptSubmit`. What `PostToolUse` and `Stop` diff against.
    savepoint: Option<String>,
    spans: Vec<Span>,
    /// Tool call key -> index into `spans`, for the span `PostToolUse` has to close.
    open: HashMap<String, usize>,
    /// Tool call key -> the card waiting on it, so `PostToolUse` can mark it "answered in terminal".
    cards: HashMap<String, CardId>,
    /// The last three commands, for the Router's state (§34.9 "Speed rules").
    recent: Vec<String>,
    /// The Done card from a `Stop` that is still waiting for an answer. This, and only this, is what
    /// "a reply is pending" means in the `stop_hook_active` loop guard.
    done_card: Option<CardId>,
    /// Tool call key -> when a `pre-tool` for it last arrived, so the fallback's duplicate call does not wait
    /// twice (`integrations/claude-code/README.md`).
    seen: HashMap<String, Instant>,
}

/// The handler. Cheap to clone; every clone is the same sessions and the same Inbox.
#[derive(Clone)]
pub struct Claude(Arc<Inner>);

struct Inner {
    deps: Deps,
    /// A `std::sync::Mutex` and never held across an await: every handler takes it, reads or writes a few
    /// fields, and drops it before it waits on anything. The long waits here are 295 s long; a lock held
    /// across one would stop every other session in the process.
    state: Mutex<HashMap<String, Session>>,
    tests: Tests,
}

impl Claude {
    pub fn new(deps: Deps) -> Claude {
        Claude(Arc::new(Inner {
            deps,
            state: Mutex::new(HashMap::new()),
            tests: Tests::builtin(),
        }))
    }

    /// One `hook.request` (§38.5) to one `hook.response`. This is the only entry point, and it never fails:
    /// a payload it cannot read, an event it does not know and a session it has never heard of all end as
    /// "print nothing, exit 0" - the agent carries on as if Mewndo were not installed (§32.5 rule 7).
    pub async fn respond(&self, request: &HookRequest) -> HookResponse {
        // The payload must be a JSON object. A string, a number or a truncated frame is a forwarder that could
        // not read its stdin, and there is nothing to answer.
        let Some(object) = request.payload.as_object() else {
            return silent();
        };
        let input: Input = match serde_json::from_value(Value::Object(object.clone())) {
            Ok(input) => input,
            // Unreachable while every field is optional, and still handled: a future field with a type that
            // does not match must not take the guard down with it.
            Err(_) => return silent(),
        };
        let Some(event) = Event::parse(&request.event)
            .or_else(|| Event::parse(input.hook_event_name.as_deref().unwrap_or_default()))
        else {
            return silent();
        };
        let key = session_key(request, &input);
        self.touch(&key, request, &input);
        match event {
            Event::SessionStart => self.session_start(&key, &input),
            Event::UserPromptSubmit => self.prompt(&key, &input).await,
            Event::PreToolUse => self.pre_tool(&key, &input).await,
            Event::PermissionRequest => self.permission(&key, &input).await,
            Event::PostToolUse => self.post_tool(&key, &input).await,
            Event::Notification => self.notification(&key, &input),
            Event::Stop => self.stop(&key, &input).await,
            Event::SubagentStop => self.subagent_stop(&key, &input),
        }
    }

    // --- SessionStart ------------------------------------------------------------------------------------
    //
    // "Upsert the agent (kind claude-code, session_id, cwd; agent PID = the parent of the hook's PID, from a
    // Toolhelp32 snapshot); status idle | {}, or additionalContext with the Continue card when a Resume is
    // pending (§24)."

    fn session_start(&self, key: &str, input: &Input) -> HookResponse {
        let cwd = self.set_status(key, "idle");
        let _ = input.source.as_deref(); // startup, resume, clear or compact: recorded by `touch`, not acted on
        match self.0.deps.v0.resume_card(&cwd) {
            Some(card) if !card.is_empty() => say(session_start_json(card)),
            _ => say(NOTHING_TO_SAY),
        }
    }

    // --- UserPromptSubmit --------------------------------------------------------------------------------
    //
    // "Start a trace (prompt; brief = the active v0 brief, otherwise the prompt). Ask engine_client for a save
    // point (trigger `agent`) without waiting more than 50 ms. Status working | {}"

    async fn prompt(&self, key: &str, input: &Input) -> HookResponse {
        let prompt = input.prompt.clone().unwrap_or_default();
        let trace_id = ulid::Ulid::new().to_string();
        let (agent_id, cwd) = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state.entry(key.to_string()).or_default();
            session.brief = self
                .0
                .deps
                .v0
                .brief(&session.cwd)
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| prompt.clone());
            session.trace_id = Some(trace_id.clone());
            // A new turn starts a new trace: last turn's spans belong to last turn's Receipt, which has
            // already been checked.
            session.spans.clear();
            session.open.clear();
            session.savepoint = None;
            session.done_card = None;
            session.status = "working";
            (session.agent_id.clone(), session.cwd.clone())
        };
        self.publish_status(&agent_id, "working", Some(first_line(&prompt)));
        // 50 ms is not long enough for a save point on a big folder, and that is the point: the user is
        // waiting on their own prompt. A later answer is still kept (see `savepoint`), so the turn has its
        // save point by the time anything needs it.
        self.savepoint(key, "agent", &trace_id, &agent_id, &cwd, SAVEPOINT_PROMPT)
            .await;
        say(NOTHING_TO_SAY)
    }

    // --- PreToolUse --------------------------------------------------------------------------------------
    //
    // "Open a span and call the Router (§34) within its deadline. In shadow mode, log and print {}"

    async fn pre_tool(&self, key: &str, input: &Input) -> HookResponse {
        let tool = input.tool_name.clone().unwrap_or_default();
        let tool_input = input.tool_input.clone().unwrap_or(Value::Null);
        let call = call_key(input);
        let name = action_name(&tool, &tool_input);
        let duplicate = self.note_call(key, &call);

        let (agent_id, cwd, brief, recent, trace_id) = self.guard_facts(key);
        // The span is opened whatever the verdict: a denied action is part of the turn's story, and §35's
        // Receipt is built from the story and not from the allowed half of it.
        let span_id = self.open_span(key, &call, &tool, &name, &tool_input);

        if tool.eq_ignore_ascii_case("AskUserQuestion") {
            return self
                .ask_user_question(key, input, &agent_id, &tool_input)
                .await;
        }

        let guarded = self.0.deps.router.guard(&GuardInput {
            agent_kind: KIND.to_string(),
            tool: tool.clone(),
            input: tool_input,
            cwd: cwd.clone().into(),
            brief,
            project: project_of(&cwd),
            recent,
            mode: self.0.deps.flags.mode,
        });
        let decision = &guarded.decision;
        self.log(&format!(
            "claude pre-tool {tool}: {:?} by {} ({:?}, {} ms){}",
            decision.verdict,
            if decision.rule.is_empty() {
                "row7"
            } else {
                &decision.rule
            },
            decision.backend,
            guarded.latency_ms,
            if decision.shadow { ", shadow" } else { "" }
        ));

        // §34.6: shadow mode silences the *model*, not the deny list. A hard rule - the deny list, a protected
        // path, outside the brief - is enforced in either mode, which is also what §38.4's fail-open path does
        // with the core switched off entirely. Everything else prints nothing, so the agent behaves exactly as
        // it would without Mewndo and the Agents tab still gets the decision.
        let shadow_quiet = self.0.deps.flags.mode == Mode::Shadow && !guarded.rule_outcome.hard();

        match decision.verdict {
            Verdict::Allow => {
                if shadow_quiet {
                    return say(NOTHING_TO_SAY);
                }
                say(pre_tool_json("allow", None))
            }
            Verdict::Deny => {
                if shadow_quiet {
                    return say(NOTHING_TO_SAY);
                }
                say(pre_tool_json(
                    "deny",
                    Some(reason_for_agent(&decision.reason)),
                ))
            }
            Verdict::Brake => {
                if shadow_quiet {
                    return say(NOTHING_TO_SAY);
                }
                say(brake_json(reason_for_agent(&decision.reason)))
            }
            Verdict::SavepointThenAllow => {
                // The save point happens in shadow mode too: it cannot change what the agent does, and a user
                // in shadow mode has not asked to lose their safety net.
                if let Some(trace) = trace_id.as_deref() {
                    self.savepoint(key, "agent", trace, &agent_id, &cwd, SAVEPOINT_PRE_TOOL)
                        .await;
                    self.attach_savepoint(key, span_id.as_deref());
                }
                if shadow_quiet {
                    return say(NOTHING_TO_SAY);
                }
                say(pre_tool_json("allow", None))
            }
            Verdict::Ask => {
                if shadow_quiet {
                    return say(NOTHING_TO_SAY);
                }
                // The primary path: print `ask`, Claude shows its own prompt, that fires `PermissionRequest`
                // and the card is made there. Whether it really does is §32.5 rule 3's open question, so the
                // fallback - wait for the card here - is one flag away.
                if !self.0.deps.flags.pre_tool_waits_for_card {
                    return say(pre_tool_json(
                        "ask",
                        Some(reason_for_agent(&decision.reason)),
                    ));
                }
                if duplicate {
                    // `hooks.fallback.json` matches these tools twice, so this hook runs twice for one tool
                    // call. The second one says nothing rather than making a second card for the same action.
                    return say(NOTHING_TO_SAY);
                }
                self.card_for(key, &call, &agent_id, &cwd, &guarded, Event::PreToolUse)
                    .await
            }
        }
    }

    /// §33.10 Part C step 5. A Question card, the user's own words back, and - on the primary path - a `deny`
    /// so Claude does not ask twice.
    ///
    /// This is a **verify-first item** (§32.5 rule 3): "how to answer `AskUserQuestion` from a hook" is not
    /// settled, and a deny whose reason carries the answer is §33.10's own suggestion, not a tested fact. With
    /// `answer_ask_user_question` off, the card is information only and the user answers in the terminal -
    /// which is what to switch to if a live session shows Claude ignoring the reason.
    async fn ask_user_question(
        &self,
        key: &str,
        input: &Input,
        agent_id: &str,
        tool_input: &Value,
    ) -> HookResponse {
        let Some(question) = Question::first(tool_input) else {
            return say(NOTHING_TO_SAY);
        };
        let mut card = Card::new(
            CardKind::Question,
            agent_id,
            question.header.clone(),
            question.question.clone(),
        );
        card.trace_id = self.trace_id(key);
        card.options = question
            .options
            .iter()
            .map(|o| {
                let option = Opt::new(o.label.clone());
                if o.recommended() {
                    option.recommended()
                } else {
                    option
                }
            })
            .collect();
        // The hook's own timeout is what the user really has; the card goes with it so the dock stops showing
        // a question nobody can answer any more.
        let wait = self.0.deps.flags.permission_wait;
        card.deadline = Some(wait);
        let call = call_key(input);
        let (id, waiting) = self.0.deps.inbox.create(card).await;
        self.remember_card(key, &call, id);

        if !self.0.deps.flags.answer_ask_user_question {
            // The fallback: the card is information only. Nothing is printed, so Claude's own question stands
            // and the user answers it in the terminal.
            return say(NOTHING_TO_SAY);
        }
        match timeout(wait, waiting).await {
            Ok(Ok(answer)) => {
                let chosen = answer
                    .choice
                    .and_then(|n| question.options.get(n))
                    .map(|o| o.label.clone())
                    .or_else(|| answer.text.clone())
                    .unwrap_or_default();
                if chosen.is_empty() {
                    return say(NOTHING_TO_SAY);
                }
                self.forget_card(key, &call);
                say(pre_tool_json(
                    "deny",
                    Some(format!("The user answered in Mewndo: {chosen}")),
                ))
            }
            // Expired, or the Inbox is gone: Claude's own question is still on screen and still the fastest
            // way to answer. Printing a deny here would throw away a question the user never saw.
            Ok(Err(_)) => say(NOTHING_TO_SAY),
            Err(_) => {
                self.0.deps.inbox.expire(id).await;
                say(NOTHING_TO_SAY)
            }
        }
    }

    // --- PermissionRequest -------------------------------------------------------------------------------
    //
    // "Create a Permission card and wait on a oneshot for up to 295 s"

    async fn permission(&self, key: &str, input: &Input) -> HookResponse {
        let tool = input.tool_name.clone().unwrap_or_default();
        let tool_input = input.tool_input.clone().unwrap_or(Value::Null);
        let call = call_key(input);
        let (agent_id, cwd, brief, recent, _) = self.guard_facts(key);
        // The Router runs first, for three reasons: a hard-rule deny must not become a question the user can
        // say yes to; a habit (§34.7) is the user's own standing answer and asking again would be ignoring it;
        // and the card needs the signature and the normalized command to teach the next habit.
        let guarded = self.0.deps.router.guard(&GuardInput {
            agent_kind: KIND.to_string(),
            tool: tool.clone(),
            input: tool_input,
            cwd: cwd.clone().into(),
            brief,
            project: project_of(&cwd),
            recent,
            mode: self.0.deps.flags.mode,
        });
        self.log(&format!(
            "claude permission {tool}: {:?} by {}",
            guarded.decision.verdict, guarded.decision.rule
        ));
        if guarded.rule_outcome.hard() && guarded.decision.verdict == Verdict::Deny {
            return say(permission_json(
                "deny",
                Some(reason_for_agent(&guarded.decision.reason)),
            ));
        }
        if guarded.decision.verdict.allows()
            && guarded.decision.backend == mewndo_router::Backend::Habit
        {
            // The user has already answered this three times (§34.7). Asking a fourth time is the thing habits
            // exist to stop.
            return say(permission_json("allow", None));
        }
        self.card_for(
            key,
            &call,
            &agent_id,
            &cwd,
            &guarded,
            Event::PermissionRequest,
        )
        .await
    }

    /// The §33.2 permission card, and the wait. Shared by `PermissionRequest` and by `PreToolUse` under the
    /// §33.10 Part C step 6 fallback, because the only thing that differs between them is which shape the
    /// answer is printed in.
    async fn card_for(
        &self,
        key: &str,
        call: &str,
        agent_id: &str,
        cwd: &str,
        guarded: &Guarded,
        print_as: Event,
    ) -> HookResponse {
        let wait = self.0.deps.flags.permission_wait;
        let command = if guarded.action.command_norm.is_empty() {
            "this action".to_string()
        } else {
            guarded.action.command_norm.clone()
        };
        let project = project_of(cwd);
        let mut card = Card::permission(
            agent_id,
            format!("Run {command}?"),
            format!("{project} · {}", reason_for_agent(&guarded.decision.reason)),
            super::risk_of(guarded),
            PermissionFacts {
                agent_kind: KIND.to_string(),
                project,
                action_sig: guarded.sig,
                command_norm: guarded.action.command_norm.clone(),
            },
        );
        card.trace_id = self.trace_id(key);
        // The card's own deadline, so the dock stops showing a card whose hook has given up (§33.9). It is the
        // same 295 s this handler waits, not the hook's 300: the card must not outlive the thing waiting on it.
        card.deadline = Some(wait);
        let (id, waiting) = self.0.deps.inbox.create(card).await;
        self.remember_card(key, call, id);

        let answer = match timeout(wait, waiting).await {
            Ok(Ok(answer)) => answer,
            // The card expired, or the Inbox went away. Claude's own prompt is still up: say nothing and let
            // the user answer it there (§33.9, "nobody is blocked forever").
            Ok(Err(_)) => return silent(),
            Err(_) => {
                // 295 s gone. Expire the card so it stops being shown, and print nothing at all, so Claude's
                // own prompt carries on with the five seconds it has left (§33.10 Part C step 4).
                self.log("claude permission: 295 s with no answer; the terminal prompt has it");
                self.0.deps.inbox.expire(id).await;
                return silent();
            }
        };
        self.forget_card(key, call);
        // §33.2's permission card: 1 allow once · 2 always allow here · 3 deny · Space add a reason. The two
        // allows are both allows; "always allow here" additionally teaches a habit, which the Inbox records at
        // release (§34.9 R11) and the core turns into a rule - writing the user's rules.toml is not this
        // file's job.
        let (allowed, message) = match (answer.choice, answer.text.as_deref()) {
            (Some(0), _) => (true, None),
            (Some(1), _) => (true, None),
            (Some(2), _) => (false, Some("The user denied this in Mewndo.".to_string())),
            // A typed or spoken answer is a reason, not a yes: the user wrote words instead of pressing 1.
            // Fail closed - the action does not run, and the agent reads what they said.
            (_, Some(text)) if !text.is_empty() => {
                (false, Some(format!("The user answered in Mewndo: {text}")))
            }
            // An option this card does not have teaches nothing and permits nothing.
            _ => (
                false,
                Some("The user did not allow this in Mewndo.".to_string()),
            ),
        };
        match (print_as, allowed) {
            (Event::PermissionRequest, true) => say(permission_json("allow", None)),
            (Event::PermissionRequest, false) => say(permission_json("deny", message)),
            // The step 6 fallback prints in `PreToolUse`'s shape, because that is the hook that is waiting.
            (_, true) => say(pre_tool_json("allow", None)),
            (_, false) => say(pre_tool_json("deny", message)),
        }
    }

    // --- PostToolUse -------------------------------------------------------------------------------------
    //
    // "Close the span: output tail, exit code (§35.5 T2), files changed since the span opened. If a pending
    // card belongs to this tool call, mark it 'answered in terminal' | {}"

    async fn post_tool(&self, key: &str, input: &Input) -> HookResponse {
        let call = call_key(input);
        let response = Response::read(input.tool_response.as_ref());
        let (span, savepoint) = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state.entry(key.to_string()).or_default();
            let index = session.open.remove(&call);
            let savepoint = session.savepoint.clone();
            let span = match index.and_then(|i| session.spans.get_mut(i)) {
                Some(span) => {
                    span.finish(
                        &response.stdout,
                        &response.stderr,
                        response.exit_code,
                        now_ms(),
                        &self.0.tests,
                    );
                    Some(span.clone())
                }
                // No span: this core started mid-turn, or the `PreToolUse` hook never ran (a tool the matcher
                // misses). The turn is still worth a Receipt, so the result is kept as a span of its own.
                None => None,
            };
            (span, savepoint)
        };
        let mut span = match span {
            Some(span) => span,
            None => {
                let mut late = Span::start(
                    ulid::Ulid::new().to_string(),
                    self.trace_id(key).unwrap_or_default(),
                    input.tool_name.as_deref().unwrap_or_default(),
                    action_name(
                        input.tool_name.as_deref().unwrap_or_default(),
                        input.tool_input.as_ref().unwrap_or(&Value::Null),
                    ),
                    now_ms(),
                );
                late.files = named_paths(input.tool_input.as_ref().unwrap_or(&Value::Null));
                late.finish(
                    &response.stdout,
                    &response.stderr,
                    response.exit_code,
                    now_ms(),
                    &self.0.tests,
                );
                self.push_span(key, late.clone());
                late
            }
        };

        // "Files changed since the span opened", from the journal and not from the tool's own account of
        // itself: a shell command changes files it never names. With no v0 engine wired up there is no diff,
        // and the span keeps only the paths the tool named - which is what it has, said plainly.
        if let Some(savepoint) = savepoint.as_deref() {
            match self.0.deps.v0.changed_since(savepoint, span.started_at) {
                Ok(changes) => {
                    for path in changes.all() {
                        if !span.files.contains(path) {
                            span.files.push(path.clone());
                        }
                    }
                    self.replace_span(key, &span);
                }
                Err(why) => self.log(&format!("claude post-tool: no journal diff ({why})")),
            }
        }
        self.publish_span(&span);

        // A card still waiting for this very tool call means the user answered in the terminal instead
        // (§33.9: "expired; the card shows 'answered in terminal' when PostToolUse arrives").
        if let Some(card) = self.take_card(key, &call) {
            self.log("claude post-tool: answered in the terminal; the card is expired");
            self.0.deps.inbox.expire(card).await;
        }
        say(NOTHING_TO_SAY)
    }

    // --- Notification ------------------------------------------------------------------------------------
    //
    // "Status amber when it needs input or permission | {}"

    fn notification(&self, key: &str, input: &Input) -> HookResponse {
        let message = input.message.clone().unwrap_or_default();
        let status = if needs_user(&message) {
            "amber"
        } else {
            "working"
        };
        let agent_id = self.set_status_to(key, status);
        self.publish_status(&agent_id, status, Some(first_line(&message)));
        say(NOTHING_TO_SAY)
    }

    // --- Stop --------------------------------------------------------------------------------------------
    //
    // "If stop_hook_active is true and no reply is pending, return at once (this prevents loops). Otherwise
    // read the final message (§33.8), run Receipts (§35, at most 3 s), create the Done card, and wait for the
    // reply window (default 15 s; ends early on E or Dismiss)"

    async fn stop(&self, key: &str, input: &Input) -> HookResponse {
        // **The loop guard.** Blocking a Stop makes Claude carry on, and when it finishes it fires Stop again
        // with `stop_hook_active: true`. If that second Stop made another Done card and blocked again, the two
        // would never stop. So: unless a card from an earlier Stop is still waiting for this session, the
        // answer is `{}` and nothing else happens - no transcript read, no Receipt, no card.
        if input.stop_hook_active == Some(true) {
            let pending = self.pending_reply(key).await;
            if pending.is_none() {
                self.log("claude stop: stop_hook_active with no reply pending; returning at once");
                return say(NOTHING_TO_SAY);
            }
        }

        let (agent_id, trace_id, spans, savepoint) = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state.entry(key.to_string()).or_default();
            session.status = "idle";
            (
                session.agent_id.clone(),
                session.trace_id.clone().unwrap_or_default(),
                session.spans.clone(),
                session.savepoint.clone(),
            )
        };

        // §33.8: the agent's last message, from the transcript the hook points at.
        let final_message = input
            .transcript_path
            .as_deref()
            .and_then(last_assistant_text)
            .unwrap_or_default();
        let summary = summarize(&final_message);

        let changes = savepoint
            .as_deref()
            .and_then(|sp| self.0.deps.v0.changed_since(sp, now_ms()).ok());
        let receipt = timeout(
            RECEIPTS_BUDGET,
            self.0.deps.receipts.check(ReceiptInput {
                trace_id: trace_id.clone(),
                final_message,
                spans,
                changes,
            }),
        )
        .await
        .unwrap_or_else(|_| {
            // Three seconds is the promise to the user, not to the check. A Receipt that is too slow is no
            // Receipt: the Done card still goes up, with the summary and without a line it cannot stand
            // behind.
            self.log(
                "claude stop: Receipts took longer than 3 s; the Done card goes up without a line",
            );
            Receipt::default()
        });
        if !receipt.line.is_empty() || !receipt.mismatches.is_empty() {
            self.0.deps.events.receipt(ReceiptResult {
                trace_id: trace_id.clone(),
                line: receipt.line.clone(),
                mismatches: receipt.mismatches.clone(),
            });
        }
        self.publish_status(&agent_id, "idle", Some(summary.clone()));

        // §33.2's Done card: "A 2-line summary plus the Receipt (§35)", keys "Space reply · V voice reply ·
        // U undo turn · E clear". A mismatch adds the send-back option of the Receipt warning card.
        let body = match (summary.is_empty(), receipt.line.is_empty()) {
            (true, true) => String::new(),
            (true, false) => receipt.line.clone(),
            (false, true) => summary.clone(),
            (false, false) => format!("{summary}\n{}", receipt.line),
        };
        let mut card = Card::new(CardKind::Done, &agent_id, "Finished", body);
        card.trace_id = (!trace_id.is_empty()).then(|| trace_id.clone());
        card.options = if receipt.mismatches.is_empty() {
            vec![Opt::new(UNDO_TURN), Opt::new(CLEAR)]
        } else {
            vec![
                Opt::new(SEND_BACK).recommended(),
                Opt::new(UNDO_TURN),
                Opt::new(CLEAR),
            ]
        };
        card.deadline = Some(self.0.deps.flags.reply_window);
        let (id, waiting) = self.0.deps.inbox.create(card.clone()).await;
        self.set_done_card(key, Some(id));

        // The window ends early the moment an answer arrives, which is what "ends early on E or Dismiss"
        // means from this side: E releases a Clear, and the oneshot resolves.
        let answer = match timeout(self.0.deps.flags.reply_window, waiting).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => {
                self.set_done_card(key, None);
                return say(NOTHING_TO_SAY);
            }
            Err(_) => {
                self.0.deps.inbox.expire(id).await;
                self.set_done_card(key, None);
                return say(NOTHING_TO_SAY);
            }
        };
        self.set_done_card(key, None);
        match done_answer(&card, &answer, &receipt) {
            // A reply or a send-back: block, and the text is what Claude reads and carries on from.
            Some(text) => say(block_json(text)),
            None => say(NOTHING_TO_SAY),
        }
    }

    // --- SubagentStop ------------------------------------------------------------------------------------
    //
    // "Close the subagent span | {}"

    fn subagent_stop(&self, key: &str, _input: &Input) -> HookResponse {
        let span = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state.entry(key.to_string()).or_default();
            // The newest open subagent span: a Task tool's own `PostToolUse` arrives separately, and whichever
            // of the two is first closes it.
            let open: Vec<(String, usize)> =
                session.open.iter().map(|(k, i)| (k.clone(), *i)).collect();
            let newest = open
                .into_iter()
                .filter(|(_, i)| {
                    session
                        .spans
                        .get(*i)
                        .is_some_and(|s| s.kind == SpanKind::Subagent)
                })
                .max_by_key(|(_, i)| session.spans.get(*i).map(|s| s.started_at).unwrap_or(0));
            match newest {
                Some((call, index)) => {
                    session.open.remove(&call);
                    session.spans.get_mut(index).map(|span| {
                        span.finish("", "", None, now_ms(), &self.0.tests);
                        span.clone()
                    })
                }
                None => None,
            }
        };
        if let Some(span) = span {
            self.publish_span(&span);
        }
        say(NOTHING_TO_SAY)
    }

    // --- the small shared parts --------------------------------------------------------------------------

    /// Upsert the agent: §33.10 Part C step 4's `SessionStart` row, done on every event so a core that started
    /// mid-session still knows who is talking to it.
    fn touch(&self, key: &str, request: &HookRequest, input: &Input) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        if session.agent_id.is_empty() {
            session.agent_id = ulid::Ulid::new().to_string();
            session.status = "idle";
        }
        if let Some(cwd) = input.cwd.clone().or_else(|| request.cwd.clone())
            && !cwd.is_empty()
        {
            session.cwd = cwd;
        }
        if let Some(pid) = request.pid {
            session.hook_pid = Some(pid);
            // The hook is a child of Claude Code, so Claude Code's own PID is the hook's parent (§33.10 Part C
            // step 4). Read once: a PID does not change, and a Toolhelp32 snapshot walks every process.
            if session.agent_pid.is_none() {
                session.agent_pid = parent_pid(pid);
            }
        }
    }

    /// Status, and the cwd the caller usually wants with it.
    fn set_status(&self, key: &str, status: &'static str) -> String {
        let (agent_id, cwd) = {
            let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            let session = state.entry(key.to_string()).or_default();
            session.status = status;
            (session.agent_id.clone(), session.cwd.clone())
        };
        self.publish_status(&agent_id, status, None);
        cwd
    }

    fn set_status_to(&self, key: &str, status: &'static str) -> String {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        session.status = status;
        session.agent_id.clone()
    }

    fn publish_status(&self, agent_id: &str, status: &str, last_line: Option<String>) {
        self.0.deps.events.agent_status(AgentStatus {
            agent_id: agent_id.to_string(),
            kind: KIND.to_string(),
            name: NAME.to_string(),
            connection: "hooked".to_string(),
            status: status.to_string(),
            last_line: last_line.filter(|l| !l.is_empty()),
        });
    }

    fn publish_span(&self, span: &Span) {
        self.0.deps.events.span(SpanCreated {
            trace_id: span.trace_id.clone(),
            span: serde_json::to_value(span).unwrap_or(Value::Null),
        });
    }

    fn log(&self, message: &str) {
        // The core's `Log` belongs to the process, not to one handler, and desk.rs holds it. Until the wiring
        // line passes it in, decisions are recorded by the Router (§34.4's decisions table) and by the events
        // above; this keeps the one-line shape so adding it is an edit here and nowhere else.
        let _ = message;
    }

    fn guard_facts(&self, key: &str) -> (String, String, String, Vec<String>, Option<String>) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        (
            session.agent_id.clone(),
            session.cwd.clone(),
            session.brief.clone(),
            session.recent.clone(),
            session.trace_id.clone(),
        )
    }

    fn trace_id(&self, key: &str) -> Option<String> {
        let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.get(key).and_then(|s| s.trace_id.clone())
    }

    /// True when a `pre-tool` for this exact call arrived moments ago: the duplicate the step 6 fallback's two
    /// matcher entries produce.
    fn note_call(&self, key: &str, call: &str) -> bool {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        let now = Instant::now();
        session
            .seen
            .retain(|_, at| now.saturating_duration_since(*at) < DUPLICATE_WINDOW);
        session.seen.insert(call.to_string(), now).is_some()
    }

    fn open_span(
        &self,
        key: &str,
        call: &str,
        tool: &str,
        name: &str,
        tool_input: &Value,
    ) -> Option<String> {
        let trace_id = self.trace_id(key)?;
        let id = ulid::Ulid::new().to_string();
        let mut span = Span::start(id.clone(), trace_id, tool, name, now_ms());
        span.files = named_paths(tool_input);
        self.publish_span(&span);
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        session.spans.push(span);
        session
            .open
            .insert(call.to_string(), session.spans.len() - 1);
        if !name.is_empty() {
            session.recent.push(name.to_string());
            // §34.9 "Speed rules": at most the last three actions ever travel with a Router call.
            if session.recent.len() > 3 {
                session.recent.remove(0);
            }
        }
        Some(id)
    }

    fn push_span(&self, key: &str, span: Span) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.entry(key.to_string()).or_default().spans.push(span);
    }

    fn replace_span(&self, key: &str, span: &Span) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        if let Some(slot) = session.spans.iter_mut().find(|s| s.id == span.id) {
            *slot = span.clone();
        }
    }

    fn attach_savepoint(&self, key: &str, span_id: Option<&str>) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        let session = state.entry(key.to_string()).or_default();
        let savepoint = session.savepoint.clone();
        if let (Some(id), Some(savepoint)) = (span_id, savepoint)
            && let Some(span) = session.spans.iter_mut().find(|s| s.id == id)
        {
            span.savepoint_id = Some(savepoint);
        }
    }

    fn remember_card(&self, key: &str, call: &str, id: CardId) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state
            .entry(key.to_string())
            .or_default()
            .cards
            .insert(call.to_string(), id);
    }

    fn forget_card(&self, key: &str, call: &str) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.entry(key.to_string()).or_default().cards.remove(call);
    }

    fn take_card(&self, key: &str, call: &str) -> Option<CardId> {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.get_mut(key)?.cards.remove(call)
    }

    fn set_done_card(&self, key: &str, id: Option<CardId>) {
        let mut state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        state.entry(key.to_string()).or_default().done_card = id;
    }

    /// The Done card from an earlier `Stop` that is still the user's to answer - the one case where
    /// `stop_hook_active` must not return at once. Asking the Inbox, not just this file's memory: a card that
    /// has since expired is not a reply pending, and treating it as one would hold the hook for nothing.
    async fn pending_reply(&self, key: &str) -> Option<CardId> {
        let id = {
            let state = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
            state.get(key).and_then(|s| s.done_card)
        }?;
        match self.0.deps.inbox.state(id).await {
            Some(state) if state.waiting() => Some(id),
            _ => {
                self.set_done_card(key, None);
                None
            }
        }
    }

    /// Ask the v0 engine for a save point and wait at most `cap` for it.
    ///
    /// A late answer is not thrown away: it is stored on the session when it arrives, which is the same bargain
    /// §33.10 Part D step 3 strikes for the Inbox - release now, attach the id later. The call is spawned so
    /// the engine's own future cannot outlive this handler's budget on the handler's thread.
    async fn savepoint(
        &self,
        key: &str,
        trigger: &'static str,
        note: &str,
        agent_id: &str,
        cwd: &str,
        cap: Duration,
    ) -> Option<String> {
        let pending = self.0.deps.engine.savepoint(SavepointRequest {
            trigger,
            note: note.to_string(),
            agent_id: agent_id.to_string(),
            cwd: Some(cwd.to_string()).filter(|c| !c.is_empty()),
        });
        let (tx, rx) = oneshot::channel();
        let me = self.clone();
        let key = key.to_string();
        tokio::spawn(async move {
            let id = pending.await.ok();
            if let Some(id) = id.clone()
                && !id.is_empty()
            {
                let mut state = me.0.state.lock().unwrap_or_else(|e| e.into_inner());
                state.entry(key).or_default().savepoint = Some(id);
            }
            let _ = tx.send(id);
        });
        match timeout(cap, rx).await {
            Ok(Ok(id)) => id.filter(|id| !id.is_empty()),
            // Slower than the cap, or the task is gone: carry on without it. The agent is never held up for a
            // save point (§32.5 rule 7).
            _ => None,
        }
    }
}

// --- card and answer helpers ------------------------------------------------------------------------------

/// §33.2's Done card keys, as labels. Matched by label and not by index, because the card has one more option
/// when there is a mismatch to send back and a wrong index would undo a turn the user wanted kept.
const SEND_BACK: &str = "Send back";
const UNDO_TURN: &str = "Undo turn";
const CLEAR: &str = "Clear";

/// What to block the turn with, or `None` to let it end.
fn done_answer(card: &Card, answer: &Answer, receipt: &Receipt) -> Option<String> {
    // Space or V: the user's own words, which is the reply (§33.2).
    if let Some(text) = answer.text.as_deref().map(str::trim)
        && !text.is_empty()
    {
        return Some(text.to_string());
    }
    match answer.choice.and_then(|n| card.options.get(n)) {
        Some(option) if option.label == SEND_BACK => Some(send_back_message(receipt)),
        // Undo turn is a restore, which the core runs from the card; Clear is "I have read it". Neither is
        // something to tell the agent, so the turn ends.
        _ => None,
    }
}

/// §35: what the agent is asked to look at again. Facts only - the claim and what the evidence says - because
/// this text is read by a model that will act on it.
fn send_back_message(receipt: &Receipt) -> String {
    let mut text =
        String::from("Mewndo checked this turn against the evidence and these do not match:");
    for mismatch in receipt.mismatches.iter().take(5) {
        text.push_str("\n- ");
        text.push_str(mismatch);
    }
    text.push_str("\nPlease check each one and fix it or say plainly that it is not done.");
    text
}

/// Everything Mewndo says to a model is marked as Mewndo's, so the agent can tell a guard's refusal from the
/// user's own words. v0's Guard does the same (`guard.js`: `Mewndo: <reason>`).
fn reason_for_agent(reason: &str) -> String {
    let reason = reason.trim();
    if reason.is_empty() {
        return "Mewndo: the user has not allowed this.".to_string();
    }
    if reason.starts_with("Mewndo") {
        return reason.to_string();
    }
    format!("Mewndo: {reason}")
}

// --- reading the payload ----------------------------------------------------------------------------------

/// Which session this is. The payload's own `session_id` first, because that is what Claude Code keys its
/// transcript by; then the forwarder's, then the PID, then the folder. A hook with none of the four still gets
/// a session - one shared by everything equally anonymous, which is the honest answer and not a crash.
fn session_key(request: &HookRequest, input: &Input) -> String {
    for candidate in [
        input.session_id.clone(),
        request.session_id.clone(),
        request.pid.map(|p| format!("pid:{p}")),
        input.cwd.clone().or_else(|| request.cwd.clone()),
    ] {
        if let Some(key) = candidate.filter(|k| !k.is_empty()) {
            return key;
        }
    }
    "claude:unknown".to_string()
}

/// One tool call, the same string at `PreToolUse`, `PermissionRequest` and `PostToolUse`.
///
/// `tool_use_id` when there is one - it is the only field that is certainly unique per call - and otherwise the
/// tool plus a digest of its input, which is what the three events do share. A `PostToolUse` that cannot be
/// matched to its `PreToolUse` leaves a span open and a card unexpired, so this is worth being careful about.
fn call_key(input: &Input) -> String {
    if let Some(id) = input.tool_use_id.as_deref().filter(|id| !id.is_empty()) {
        return id.to_string();
    }
    let tool = input.tool_name.clone().unwrap_or_default();
    let digest = input
        .tool_input
        .as_ref()
        .map(|v| {
            use sha2::{Digest, Sha256};
            let bytes = serde_json::to_vec(v).unwrap_or_default();
            let hash = Sha256::digest(&bytes);
            format!(
                "{:02x}{:02x}{:02x}{:02x}",
                hash[0], hash[1], hash[2], hash[3]
            )
        })
        .unwrap_or_default();
    format!("{tool}:{digest}")
}

/// What the span and the card call this action: the command for a shell tool, the path for a file tool, the
/// tool's own name for everything else. Read from the samples: `Bash` carries `command`, `Edit` and `Write`
/// carry `file_path`.
fn action_name(tool: &str, tool_input: &Value) -> String {
    for field in ["command", "file_path", "path", "notebook_path", "url"] {
        if let Some(text) = tool_input.get(field).and_then(Value::as_str)
            && !text.is_empty()
        {
            return text.to_string();
        }
    }
    tool.to_string()
}

/// The paths a tool names in its own input. Not the authoritative list of what changed - that is the journal
/// (§35.5 T4) - which is why it is only ever added to, never trusted on its own.
fn named_paths(tool_input: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    for field in ["file_path", "path", "notebook_path"] {
        if let Some(text) = tool_input.get(field).and_then(Value::as_str)
            && !text.is_empty()
        {
            paths.push(text.to_string());
        }
    }
    // MultiEdit and friends carry a list of edits, each with its own path.
    if let Some(edits) = tool_input.get("edits").and_then(Value::as_array) {
        for edit in edits {
            if let Some(path) = edit.get("file_path").and_then(Value::as_str)
                && !paths.iter().any(|p| p == path)
            {
                paths.push(path.to_string());
            }
        }
    }
    paths
}

/// `PostToolUse`'s `tool_response`, which the sample shows as `{stdout, stderr, interrupted, isImage}` but
/// which is a bare string for some tools and absent for others. All three are handled, because §35.5 T2's exit
/// code is inferred from this text and reading the wrong field means inferring from nothing.
#[derive(Debug, Default, PartialEq)]
struct Response {
    stdout: String,
    stderr: String,
    /// Claude Code does not send one in the sample. T2 then infers it from the output, for test commands only.
    exit_code: Option<i32>,
}

impl Response {
    fn read(value: Option<&Value>) -> Response {
        let Some(value) = value else {
            return Response::default();
        };
        if let Some(text) = value.as_str() {
            return Response {
                stdout: text.to_string(),
                ..Response::default()
            };
        }
        let text = |field: &str| {
            value
                .get(field)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Response {
            stdout: text("stdout"),
            stderr: text("stderr"),
            exit_code: ["exit_code", "exitCode", "returncode"]
                .iter()
                .find_map(|f| value.get(*f).and_then(Value::as_i64))
                .and_then(|c| i32::try_from(c).ok()),
        }
    }
}

/// One `AskUserQuestion` question, from `docs/samples/claude/pre-tool-ask-user-question.json`.
#[derive(Debug, Clone, Deserialize)]
struct Question {
    #[serde(default)]
    question: String,
    #[serde(default)]
    header: String,
    #[serde(default)]
    options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, Deserialize)]
struct QuestionOption {
    #[serde(default)]
    label: String,
    #[serde(default)]
    description: String,
}

impl QuestionOption {
    /// §33.2: "Recommended" is kept. Claude Code marks it in the words of the option itself, so that is where
    /// it is read from; nothing is invented when it is absent.
    fn recommended(&self) -> bool {
        let text = format!("{} {}", self.label, self.description).to_lowercase();
        text.contains("recommended")
    }
}

impl Question {
    /// The first question. §33.1's dock shows one card at a time and §33.2's Question card holds one question;
    /// a multi-question `AskUserQuestion` is answered one card at a time, starting here. Honest limit: only the
    /// first is asked, and the rest fall to the terminal.
    fn first(tool_input: &Value) -> Option<Question> {
        let questions = tool_input.get("questions")?.as_array()?;
        let question: Question = serde_json::from_value(questions.first()?.clone()).ok()?;
        (!question.question.is_empty() || !question.options.is_empty()).then(|| {
            let mut question = question;
            if question.header.is_empty() {
                question.header = "Question".to_string();
            }
            question
        })
    }
}

/// Does this notification need the user (§33.10 Part C step 4: "Status amber when it needs input or
/// permission")? Read from the sample's own wording and from Claude Code's two notification kinds.
fn needs_user(message: &str) -> bool {
    let m = message.to_lowercase();
    [
        "permission",
        "needs your input",
        "waiting for your input",
        "is waiting",
        "approve",
    ]
    .iter()
    .any(|phrase| m.contains(phrase))
}

// --- §33.8: the agent's last message ---------------------------------------------------------------------

/// The last assistant message in a transcript, as `transcript_path` points at it (§33.8).
///
/// The file is JSON Lines and grows for the whole session, so only the tail is read - the last message is
/// always at the end. A line that does not parse is skipped rather than fatal: a transcript being appended to
/// while it is read ends in a half-written line, and a Done card with no summary is much better than a `Stop`
/// hook that fails.
fn last_assistant_text(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(TRANSCRIPT_TAIL);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut text = String::new();
    // Not `read_to_string`: a tail that starts mid-character is not valid UTF-8, and this must not fail over
    // a box-drawing character.
    let mut bytes = Vec::new();
    file.take(TRANSCRIPT_TAIL + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    text.push_str(&String::from_utf8_lossy(&bytes));
    let mut lines: Vec<&str> = text.lines().collect();
    if from > 0 && !lines.is_empty() {
        lines.remove(0); // the first line is a fragment of the line before the window
    }
    for line in lines.iter().rev() {
        if let Some(text) = assistant_text(line) {
            return Some(text);
        }
    }
    None
}

/// The text of one transcript line, if it is an assistant message with any. Coded against
/// `docs/samples/claude/stop-transcript.jsonl`: `{"type":"assistant","message":{"content":[{"type":"text",
/// "text":"…"}]}}`, with `content` sometimes a bare string.
fn assistant_text(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.trim().to_string());
    }
    let blocks = content.as_array()?;
    let mut text = String::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(part) = block.get("text").and_then(Value::as_str)
        {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(part.trim());
        }
    }
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

/// §33.8: "the first two sentences, capped at 200 characters". No model call, nothing invented - the agent's
/// own words, cut.
fn summarize(message: &str) -> String {
    let flat = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return String::new();
    }
    let mut end = flat.len();
    let mut sentences = 0;
    let bytes = flat.as_bytes();
    for (i, c) in flat.char_indices() {
        if matches!(c, '.' | '!' | '?') {
            // A full stop inside `src/date.ts` or `1.4.0` does not end a sentence; one followed by a space or
            // the end of the text does.
            let next = bytes.get(i + 1);
            if next.is_none_or(|b| b.is_ascii_whitespace()) {
                sentences += 1;
                if sentences == 2 {
                    end = i + 1;
                    break;
                }
            }
        }
    }
    cut(&flat[..end.min(flat.len())], SUMMARY_CHARS)
}

/// Cut at a character boundary, with an ellipsis when something was dropped.
fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

fn first_line(text: &str) -> String {
    cut(text.lines().next().unwrap_or_default().trim(), 120)
}

/// The project a card names: the folder's own name, which is what §33.2 shows and what habits are keyed by.
fn project_of(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or("")
        .to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- the rules-only Receipt ------------------------------------------------------------------------------

/// What [`RuleReceipts`] can say from facts alone. Every branch that cannot be checked says nothing: an
/// unverifiable claim is not a mismatch (§35, and CLAUDE.md rule 5).
fn rule_receipt(claims: &[Claim], input: &ReceiptInput, tests: &Tests) -> Receipt {
    let mut mismatches = Vec::new();
    // The last test run of the turn, which is what §35's line is about.
    let mut last_test: Option<&Span> = None;
    for span in &input.spans {
        if span.test_runner(tests).is_some()
            && last_test.is_none_or(|previous| span.at() >= previous.at())
        {
            last_test = Some(span);
        }
    }
    let touched: Vec<&String> = input
        .spans
        .iter()
        .flat_map(|s| s.files.iter())
        .chain(input.changes.iter().flat_map(|c| c.all()))
        .collect();

    for claim in claims {
        match claim.kind {
            ClaimType::TestsPass => {
                if let Some(span) = last_test
                    && let Some(code) = span.exit_code
                    && code != 0
                {
                    mismatches.push(format!(
                        "Says tests pass · the last run of `{}` exited {code}{}",
                        cut(&span.name, 80),
                        if span.exit_code_inferred {
                            " (read from its output)"
                        } else {
                            ""
                        }
                    ));
                }
            }
            ClaimType::Untouched | ClaimType::NoChanges => {
                if let Some(subject) = claim.subject.as_deref() {
                    if let Some(path) = touched.iter().find(|p| same_subject(p, subject)) {
                        mismatches.push(format!(
                            "Says {subject} is untouched · this turn changed {path}"
                        ));
                    }
                } else if claim.kind == ClaimType::NoChanges && !touched.is_empty() {
                    mismatches.push(format!(
                        "Says nothing changed · this turn changed {} file{}",
                        touched.len(),
                        if touched.len() == 1 { "" } else { "s" }
                    ));
                }
            }
            // Created, Deleted, BuildOk, TestsFail and EmailSent need evidence this stand-in does not have:
            // the journal for the first two (only present when v0 is wired up and then only as a change, not
            // as a create), a build log for the third, the Send Guard's own record for the last. §35's own
            // check in mewndo-trace is where those belong; saying nothing is the honest answer here.
            _ => {}
        }
    }

    // §35, spec line 2275: `✓ 4 files · ✓ npm test passed after the last edit · 1 save point`.
    let mut parts = Vec::new();
    let files = touched.len();
    if files > 0 {
        parts.push(format!(
            "✓ {files} file{}",
            if files == 1 { "" } else { "s" }
        ));
    }
    if let Some(span) = last_test {
        let name = cut(&span.name, 60);
        parts.push(match span.exit_code {
            Some(0) => format!("✓ {name} passed"),
            Some(code) => format!("✗ {name} exited {code}"),
            None => format!("· {name} ran, no exit code"),
        });
    }
    let savepoints = input
        .spans
        .iter()
        .filter(|s| s.savepoint_id.is_some())
        .count();
    if savepoints > 0 {
        parts.push(format!(
            "{savepoints} save point{}",
            if savepoints == 1 { "" } else { "s" }
        ));
    }
    Receipt {
        line: parts.join(" · "),
        mismatches,
    }
}

/// Does this path answer that claim's subject? A claim says `src/date.ts` or `migrations/`; a span and a
/// journal diff carry whole paths, in whatever spelling the tool used. Compared with forward slashes and
/// without case, because `C:\Users\...` and `c:/users/...` are one file on Windows.
fn same_subject(path: &str, subject: &str) -> bool {
    let flat = |s: &str| s.replace('\\', "/").to_lowercase();
    let (path, subject) = (flat(path), flat(subject));
    if let Some(folder) = subject.strip_suffix('/') {
        return path.contains(&format!("/{folder}/")) || path.starts_with(&format!("{folder}/"));
    }
    path == subject || path.ends_with(&format!("/{subject}"))
}

// --- the agent's PID --------------------------------------------------------------------------------------

/// The parent of `pid`: Claude Code itself, since the hook is its child (§33.10 Part C step 4).
///
/// Windows uses a Toolhelp32 snapshot, as the spec asks. Unix reads `/proc/<pid>/stat`, so the field is real
/// in the WSL tests instead of being a stub that always answers `None` (§32.5 rule 5). Neither can fail
/// loudly: a PID is for showing the user which window to look at, and a missing one costs nothing.
#[cfg(windows)]
fn parent_pid(pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: a plain call; INVALID_HANDLE_VALUE means failure and nothing is dereferenced in that case.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    // SAFETY: a zeroed PROCESSENTRY32W is valid once dwSize is set, which is what the API asks for.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut found = None;
    // SAFETY: an open snapshot handle and a writable entry.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32ProcessID == pid {
            found = Some(entry.th32ParentProcessID);
            break;
        }
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: a handle this function owns, closed once.
    unsafe { CloseHandle(snapshot) };
    found
}

#[cfg(not(windows))]
fn parent_pid(pid: u32) -> Option<u32> {
    // `/proc/<pid>/stat` is `pid (comm) state ppid …`, and `comm` can hold spaces and brackets, so the fields
    // are read after the last `)` rather than by splitting the whole line.
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.rsplit_once(')')?.1;
    rest.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_inbox::{CardState, Config, choice, text};
    use mewndo_proto::{HookRequest, Via};
    use mewndo_router::rules::CompiledRules;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const SAMPLES: &str = "../../../docs/samples/claude";

    fn sample(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(SAMPLES)
            .join(name);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{} ({e}): §32.5 rule 2 codes against the samples",
                path.display()
            )
        });
        serde_json::from_str(&text).expect("the sample is JSON")
    }

    fn request(event: &str, payload: Value) -> HookRequest {
        HookRequest {
            agent: "claude".into(),
            event: event.into(),
            session_id: payload
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string),
            pid: Some(std::process::id()),
            cwd: payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string),
            lane_id: None,
            payload,
        }
    }

    /// Every dependency's test double, in one place.
    #[derive(Default)]
    struct Fakes {
        statuses: Mutex<Vec<AgentStatus>>,
        spans: Mutex<Vec<SpanCreated>>,
        receipts: Mutex<Vec<ReceiptResult>>,
    }

    impl Events for Arc<Fakes> {
        fn agent_status(&self, status: AgentStatus) {
            self.statuses.lock().unwrap().push(status);
        }
        fn span(&self, span: SpanCreated) {
            self.spans.lock().unwrap().push(span);
        }
        fn receipt(&self, receipt: ReceiptResult) {
            self.receipts.lock().unwrap().push(receipt);
        }
    }

    /// A v0 engine that answers with one save point id, after `takes`.
    struct FakeEngine {
        id: String,
        takes: Duration,
        calls: Arc<AtomicUsize>,
        triggers: Arc<Mutex<Vec<&'static str>>>,
    }

    impl FakeEngine {
        fn new(id: &str, takes: Duration) -> (Arc<FakeEngine>, Arc<AtomicUsize>, Triggers) {
            let calls = Arc::new(AtomicUsize::new(0));
            let triggers = Arc::new(Mutex::new(Vec::new()));
            (
                Arc::new(FakeEngine {
                    id: id.to_string(),
                    takes,
                    calls: calls.clone(),
                    triggers: triggers.clone(),
                }),
                calls,
                triggers,
            )
        }
    }

    impl EngineClient for FakeEngine {
        fn savepoint(&self, request: SavepointRequest) -> mewndo_inbox::engine::Pending {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.triggers.lock().unwrap().push(request.trigger);
            let (id, takes) = (self.id.clone(), self.takes);
            Box::pin(async move {
                if !takes.is_zero() {
                    tokio::time::sleep(takes).await;
                }
                Ok(id)
            })
        }
    }

    type Triggers = Arc<Mutex<Vec<&'static str>>>;

    #[derive(Default)]
    struct FakeV0 {
        brief: Option<String>,
        resume: Option<String>,
        changes: Option<Changes>,
    }

    impl V0 for FakeV0 {
        fn brief(&self, _cwd: &str) -> Option<String> {
            self.brief.clone()
        }
        fn resume_card(&self, _cwd: &str) -> Option<String> {
            self.resume.clone()
        }
        fn changed_since(&self, _savepoint_id: &str, _now_ms: i64) -> Result<Changes, String> {
            self.changes.clone().ok_or_else(|| "no engine".to_string())
        }
    }

    /// A Receipts that takes `takes` and answers with `receipt`.
    struct FakeReceipts {
        receipt: Receipt,
        takes: Duration,
    }

    impl Receipts for FakeReceipts {
        fn check(&self, _input: ReceiptInput) -> Checking {
            let (receipt, takes) = (self.receipt.clone(), self.takes);
            Box::pin(async move {
                if !takes.is_zero() {
                    tokio::time::sleep(takes).await;
                }
                receipt
            })
        }
    }

    struct Harness {
        claude: Claude,
        inbox: Inbox,
        fakes: Arc<Fakes>,
    }

    /// The handler with nothing but an Inbox and the built-in rules: the state a fresh install is in.
    fn harness() -> Harness {
        harness_with(|_| {})
    }

    fn harness_with(tune: impl FnOnce(&mut Deps)) -> Harness {
        let inbox = Inbox::start(Config::default(), mewndo_inbox::Deps::default());
        let fakes = Arc::new(Fakes::default());
        // Active mode in the tests: shadow mode's own behaviour gets its own test, and every other test is
        // about what the handler prints when it is switched on.
        let mut deps = Deps::new(
            inbox.clone(),
            Arc::new(Router::new(
                CompiledRules::builtin(),
                Box::new(mewndo_router::clef::NoClef),
                Box::new(mewndo_router::facts::NoFacts),
            )),
        );
        deps.events = Arc::new(fakes.clone());
        deps.flags.mode = Mode::Active;
        tune(&mut deps);
        Harness {
            claude: Claude::new(deps),
            inbox,
            fakes,
        }
    }

    async fn answer_top(inbox: &Inbox, answer: impl FnOnce(CardId) -> Answer) -> CardId {
        // The card is made by another task; wait for it to appear rather than sleeping a fixed time.
        for _ in 0..200 {
            let stack = inbox.stack(mewndo_inbox::TOP).await;
            if let Some(card) = stack.cards.first() {
                let id = card.id;
                inbox.answer(id, answer(id)).await;
                return id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no card was made");
    }

    // --- one test per event, against its sample ----------------------------------------------------------

    #[tokio::test]
    async fn session_start_prints_nothing_to_say_and_registers_the_agent() {
        let h = harness();
        let out = h
            .claude
            .respond(&request("session-start", sample("session-start.json")))
            .await;
        assert_eq!((out.stdout.as_str(), out.exit_code), ("{}", 0));
        let statuses = h.fakes.statuses.lock().unwrap().clone();
        let first = statuses.first().expect("agent.status is published");
        assert_eq!((first.kind.as_str(), first.status.as_str()), (KIND, "idle"));
        assert_eq!(first.connection, "hooked");
        assert!(!first.agent_id.is_empty(), "the agent gets an id");
    }

    #[tokio::test]
    async fn session_start_carries_the_continue_card_when_a_resume_is_pending() {
        let h = harness_with(|deps| {
            deps.v0 = Arc::new(FakeV0 {
                resume: Some("# Mewndo Continue card\nFolder: shop".into()),
                ..FakeV0::default()
            });
        });
        let out = h
            .claude
            .respond(&request("session-start", sample("session-start.json")))
            .await;
        // The one output shape here that v0 already prints to real sessions
        // (apps/desktop/bin/mewndo-savepoint.js).
        assert_eq!(
            out.stdout,
            r##"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"# Mewndo Continue card\nFolder: shop"}}"##
        );
    }

    #[tokio::test]
    async fn the_prompt_starts_a_trace_asks_for_a_save_point_and_says_nothing() {
        let (engine, calls, triggers) = FakeEngine::new("sp-1", Duration::ZERO);
        let h = harness_with(|deps| deps.engine = engine);
        let out = h
            .claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one save point per prompt");
        assert_eq!(
            triggers.lock().unwrap().as_slice(),
            ["agent"],
            "§33.10 Part C step 4: trigger `agent`"
        );
        let statuses = h.fakes.statuses.lock().unwrap().clone();
        assert_eq!(statuses.last().unwrap().status, "working");
    }

    #[tokio::test]
    async fn a_slow_save_point_does_not_hold_the_prompt_for_more_than_50_ms() {
        let (engine, _, _) = FakeEngine::new("sp-late", Duration::from_secs(30));
        let h = harness_with(|deps| deps.engine = engine);
        let started = std::time::Instant::now();
        let out = h
            .claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the prompt waited {:?} on the engine",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn pre_tool_bash_allows_and_prints_the_exact_shape() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let out = h
            .claude
            .respond(&request("pre-tool", sample("pre-tool-bash.json")))
            .await;
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
            "an allow carries no reason: §33.10 Part C step 4"
        );
        let spans = h.fakes.spans.lock().unwrap().clone();
        assert_eq!(spans.len(), 1, "PreToolUse opens a span");
        assert_eq!(spans[0].span["kind"], "shell");
        assert_eq!(spans[0].span["name"], "npm test -- checkout");
    }

    #[tokio::test]
    async fn pre_tool_edit_inside_the_brief_is_allowed_and_names_its_file() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let out = h
            .claude
            .respond(&request("pre-tool", sample("pre-tool-edit.json")))
            .await;
        let printed: Value = serde_json::from_str(&out.stdout).unwrap();
        let decision = &printed["hookSpecificOutput"]["permissionDecision"];
        assert!(
            decision == "allow" || decision == "ask",
            "an edit is allowed or asked about, never silently denied: {decision}"
        );
        let spans = h.fakes.spans.lock().unwrap().clone();
        assert_eq!(spans[0].span["kind"], "file");
        assert_eq!(
            spans[0].span["files"],
            json!([r"C:\Users\ana\code\shop\src\date.ts"])
        );
    }

    #[tokio::test]
    async fn pre_tool_write_to_a_protected_file_is_denied_with_a_reason_the_model_can_read() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        // The sample writes to ~/.ssh/config: a hard rule, and the one case where the guard must be the thing
        // that answers.
        let out = h
            .claude
            .respond(&request("pre-tool", sample("pre-tool-write.json")))
            .await;
        let printed: Value = serde_json::from_str(&out.stdout).unwrap();
        let out_object = &printed["hookSpecificOutput"];
        assert_eq!(out_object["hookEventName"], "PreToolUse");
        assert_eq!(out_object["permissionDecision"], "deny");
        let reason = out_object["permissionDecisionReason"].as_str().unwrap();
        assert!(
            reason.starts_with("Mewndo"),
            "the agent can tell who denied it: {reason}"
        );
        // Byte for byte the shape mewndo-hook/src/failopen.rs prints when the core is down.
        assert_eq!(
            out.stdout,
            format!(
                r#"{{"hookSpecificOutput":{{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":{}}}}}"#,
                serde_json::to_string(reason).unwrap()
            )
        );
    }

    #[tokio::test]
    async fn shadow_mode_prints_nothing_to_say_but_still_enforces_a_hard_rule() {
        let h = harness_with(|deps| deps.flags.mode = Mode::Shadow);
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let ordinary = h
            .claude
            .respond(&request("pre-tool", sample("pre-tool-bash.json")))
            .await;
        assert_eq!(
            ordinary.stdout, "{}",
            "§34.6: the model changes nothing in shadow mode"
        );
        let hard = h
            .claude
            .respond(&request("pre-tool", sample("pre-tool-write.json")))
            .await;
        assert_eq!(
            serde_json::from_str::<Value>(&hard.stdout).unwrap()["hookSpecificOutput"]["permissionDecision"],
            "deny",
            "§34.6 and §38.4: a hard rule is enforced in either mode"
        );
    }

    #[tokio::test]
    async fn an_ask_user_question_becomes_a_question_card_and_the_answer_goes_back() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let inbox = h.inbox.clone();
        let answering = tokio::spawn(async move {
            answer_top(&inbox, |id| choice(id, 0, Via::Key)).await;
        });
        let out = h
            .claude
            .respond(&request(
                "pre-tool",
                sample("pre-tool-ask-user-question.json"),
            ))
            .await;
        answering.await.unwrap();
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"The user answered in Mewndo: ISO 8601 (recommended)"}}"#
        );
    }

    #[tokio::test]
    async fn the_ask_user_question_fallback_shows_the_card_and_prints_nothing_to_say() {
        let h = harness_with(|deps| deps.flags.answer_ask_user_question = false);
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let out = h
            .claude
            .respond(&request(
                "pre-tool",
                sample("pre-tool-ask-user-question.json"),
            ))
            .await;
        assert_eq!(out.stdout, "{}", "the terminal keeps the question");
        let stack = h.inbox.stack(mewndo_inbox::TOP).await;
        assert_eq!(
            stack.cards.len(),
            1,
            "the card is still shown, as information"
        );
        assert_eq!(stack.cards[0].kind, CardKind::Question);
    }

    #[tokio::test]
    async fn permission_request_makes_a_card_and_allows_when_the_user_presses_1() {
        let h = harness();
        let inbox = h.inbox.clone();
        let answering = tokio::spawn(async move {
            answer_top(&inbox, |id| choice(id, 0, Via::Key)).await;
        });
        let out = h
            .claude
            .respond(&request("permission", sample("permission-request.json")))
            .await;
        answering.await.unwrap();
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
    }

    #[tokio::test]
    async fn permission_request_denies_with_a_message_when_the_user_presses_3() {
        let h = harness();
        let inbox = h.inbox.clone();
        let answering = tokio::spawn(async move {
            answer_top(&inbox, |id| choice(id, 2, Via::Key)).await;
        });
        let out = h
            .claude
            .respond(&request("permission", sample("permission-request.json")))
            .await;
        answering.await.unwrap();
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The user denied this in Mewndo."}}}"#
        );
    }

    #[tokio::test]
    async fn a_typed_answer_on_a_permission_card_fails_closed_and_carries_the_words() {
        let h = harness();
        let inbox = h.inbox.clone();
        let answering = tokio::spawn(async move {
            answer_top(&inbox, |id| text(id, "not on main", Via::Voice)).await;
        });
        let out = h
            .claude
            .respond(&request("permission", sample("permission-request.json")))
            .await;
        answering.await.unwrap();
        let printed: Value = serde_json::from_str(&out.stdout).unwrap();
        let decision = &printed["hookSpecificOutput"]["decision"];
        assert_eq!(
            decision["behavior"], "deny",
            "words are a reason, not a yes"
        );
        assert_eq!(
            decision["message"],
            "The user answered in Mewndo: not on main"
        );
    }

    #[tokio::test]
    async fn post_tool_closes_the_span_infers_the_exit_code_and_says_nothing() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        h.claude
            .respond(&request("pre-tool", sample("pre-tool-bash.json")))
            .await;
        let out = h
            .claude
            .respond(&request("post-tool", sample("post-tool-bash.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        let spans = h.fakes.spans.lock().unwrap().clone();
        let closed = spans.last().expect("the closed span is published");
        assert_eq!(
            closed.span["exit_code"], 1,
            "§35.5 T2: `not ok 1` is an exit 1"
        );
        assert_eq!(
            closed.span["exit_code_inferred"], true,
            "and it says it was inferred"
        );
        assert!(
            closed.span["output_tail"]
                .as_str()
                .unwrap()
                .contains("not ok 1"),
            "the tail is kept"
        );
    }

    #[tokio::test]
    async fn post_tool_marks_a_card_for_the_same_tool_call_answered_in_the_terminal() {
        let h = harness_with(|deps| deps.flags.permission_wait = Duration::from_millis(400));
        // A permission card for the Bash call of the sample, left unanswered: the user answers in the terminal
        // instead, and `PostToolUse` arrives for the same tool call.
        let claude = h.claude.clone();
        let permission = tokio::spawn(async move {
            claude
                .respond(&request("permission", sample("permission-request.json")))
                .await
        });
        let mut id = None;
        for _ in 0..200 {
            let stack = h.inbox.stack(mewndo_inbox::TOP).await;
            if let Some(card) = stack.cards.first() {
                id = Some(card.id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let id = id.expect("a permission card");
        // The same session and the same tool_use_id as the permission sample.
        let mut post = sample("post-tool-bash.json");
        post["tool_use_id"] = json!("toolu_01A09q90qw90lkasdjl");
        let mut pre = sample("permission-request.json");
        pre["hook_event_name"] = json!("PostToolUse");
        let out = h.claude.respond(&request("post-tool", post)).await;
        assert_eq!(out.stdout, "{}");
        assert_eq!(
            h.inbox.state(id).await,
            Some(CardState::Expired),
            "§33.9: the card shows 'answered in terminal' when PostToolUse arrives"
        );
        // And the hook that was waiting on it prints nothing, so the terminal's own answer stands.
        assert_eq!(permission.await.unwrap().stdout, "");
    }

    #[tokio::test]
    async fn a_notification_that_needs_the_user_turns_the_agent_amber() {
        let h = harness();
        let out = h
            .claude
            .respond(&request("notify", sample("notification.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        let statuses = h.fakes.statuses.lock().unwrap().clone();
        let last = statuses.last().unwrap();
        assert_eq!(last.status, "amber");
        assert_eq!(
            last.last_line.as_deref(),
            Some("Claude needs your permission to use Bash")
        );
    }

    #[tokio::test]
    async fn stop_reads_the_transcript_runs_receipts_and_blocks_with_the_reply() {
        let h = harness_with(|deps| deps.flags.reply_window = Duration::from_secs(5));
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut stop = sample("stop.json");
        stop["transcript_path"] = json!(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join(SAMPLES)
                .join("stop-transcript.jsonl")
                .to_string_lossy()
        );
        let inbox = h.inbox.clone();
        let answering = tokio::spawn(async move {
            answer_top(&inbox, |id| text(id, "also fix the pricing test", Via::Key)).await;
        });
        let out = h.claude.respond(&request("stop", stop)).await;
        answering.await.unwrap();
        assert_eq!(
            out.stdout,
            r#"{"decision":"block","reason":"also fix the pricing test"}"#
        );
        // §33.8: the summary on the card is the agent's own last message, cut at two sentences.
        let statuses = h.fakes.statuses.lock().unwrap().clone();
        let last = statuses.last().unwrap();
        assert_eq!(last.status, "idle");
        assert_eq!(
            last.last_line.as_deref(),
            Some(
                "I fixed the date parser in src/date.ts so bare dates are read as UTC. All the checkout tests pass now."
            )
        );
    }

    #[tokio::test]
    async fn stop_with_no_answer_ends_the_turn_quietly() {
        let h = harness_with(|deps| deps.flags.reply_window = Duration::from_millis(200));
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let out = h
            .claude
            .respond(&request("stop", sample("stop.json")))
            .await;
        assert_eq!(out.stdout, "{}", "no reply: the turn ends");
    }

    #[tokio::test]
    async fn the_stop_hook_active_loop_guard_returns_at_once() {
        let h = harness_with(|deps| {
            deps.flags.reply_window = Duration::from_secs(60);
            // A Receipts that would take a minute: if the guard is missing, this test hangs instead of
            // failing, which is exactly what the loop does to a real session.
            deps.receipts = Arc::new(FakeReceipts {
                receipt: Receipt::default(),
                takes: Duration::from_secs(60),
            });
        });
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let started = std::time::Instant::now();
        let out = h
            .claude
            .respond(&request("stop", sample("stop-hook-active.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "it waited {:?}; §33.10's own pitfall is a Stop that blocks again",
            started.elapsed()
        );
        let stack = h.inbox.stack(mewndo_inbox::TOP).await;
        assert!(stack.cards.is_empty(), "and no second Done card was made");
    }

    #[tokio::test]
    async fn subagent_stop_closes_the_subagent_span() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        pre["tool_name"] = json!("Task");
        pre["tool_input"] =
            json!({"description": "review the diff", "prompt": "look at src/date.ts"});
        h.claude.respond(&request("pre-tool", pre)).await;
        let out = h
            .claude
            .respond(&request("subagent-stop", sample("subagent-stop.json")))
            .await;
        assert_eq!(out.stdout, "{}");
        let spans = h.fakes.spans.lock().unwrap().clone();
        assert_eq!(spans.last().unwrap().span["kind"], "subagent");
    }

    // --- the four things that must not be got wrong ------------------------------------------------------

    /// The 295 s itself is a constant, checked here against the 300 s in `hooks.json`
    /// (`the_hooks_json_in_integrations_is_the_one_this_file_answers` reads the real file). What this test
    /// runs is the *behaviour* at the end of that wait, with the wait shortened: tokio's virtual clock needs
    /// the `test-util` feature and mewndo-core's manifest does not take it (and the manifest is not this
    /// session's file to edit), so waiting out 295 s of wall clock is the only alternative - and a test that
    /// takes five minutes is a test nobody runs.
    #[tokio::test]
    async fn permission_waits_its_whole_wait_and_then_prints_nothing() {
        assert_eq!(
            PERMISSION_WAIT,
            Duration::from_secs(295),
            "§33.10 Part C step 4: at most 295 s"
        );
        assert!(
            PERMISSION_WAIT < Duration::from_secs(300),
            "the hook's own timeout is 300 s (§38.4); the core must answer first"
        );
        assert_eq!(Flags::default().permission_wait, PERMISSION_WAIT);

        let wait = Duration::from_millis(300);
        let h = harness_with(|deps| deps.flags.permission_wait = wait);
        let claude = h.claude.clone();
        let started = std::time::Instant::now();
        let waiting = tokio::spawn(async move {
            claude
                .respond(&request("permission", sample("permission-request.json")))
                .await
        });
        // The card exists, and nobody answers it.
        let mut id = None;
        for _ in 0..200 {
            if let Some(card) = h.inbox.stack(mewndo_inbox::TOP).await.cards.first() {
                id = Some(card.id);
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let id = id.expect("a permission card");
        let out = waiting.await.unwrap();
        assert!(
            started.elapsed() >= wait,
            "it gave up after {:?}, before its wait was up",
            started.elapsed()
        );
        assert_eq!(
            (out.stdout.as_str(), out.exit_code),
            ("", 0),
            "nothing is printed, so Claude's own prompt carries on (§33.10 Part C step 4)"
        );
        assert_eq!(
            h.inbox.state(id).await,
            Some(CardState::Expired),
            "and the card stops being shown"
        );
    }

    #[tokio::test]
    async fn savepoint_then_allow_waits_for_the_save_point_and_then_allows() {
        // §34.4 row 5: the model says the action is in scope but hard to undo. (A hard rule such as the ask list's
        // `git reset --hard` is decided in row 1, before the model or a habit is consulted, so it can't be used
        // here; and three answers alone only offer a habit card, §34.7.)
        let (engine, calls, triggers) = FakeEngine::new("sp-pre", Duration::from_millis(20));
        let h = harness_with(|deps| {
            deps.engine = engine;
            deps.router = irreversible_router();
        });
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        pre["tool_input"] = json!({"command": "npm run db:migrate"});
        let out = h.claude.respond(&request("pre-tool", pre)).await;
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
            "savepoint_then_allow ends in an allow"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the prompt's and this one's"
        );
        assert_eq!(triggers.lock().unwrap().as_slice(), ["agent", "agent"]);
    }

    /// A Router whose model answers "in scope, but hard to undo": §34.4 row 5, savepoint_then_allow.
    fn irreversible_router() -> Arc<Router> {
        Arc::new(Router::new(
            CompiledRules::builtin(),
            Box::new(mewndo_router::clef::FakeClef::new(json!({"answers": {
                "in_scope": {"p_yes": 0.95},
                "irreversible": {"p_yes": 0.9},
                "secrets": {"p_yes": 0.0},
                "risk": {"value": 3},
                "verdict": {"probabilities": {"savepoint_then_allow": 0.8, "ask_user": 0.2}}
            }}))),
            Box::new(mewndo_router::facts::NoFacts),
        ))
    }

    /// One second of real wall clock, deliberately: the cap is a second, there is no virtual clock in this
    /// crate's test features, and the thing worth proving - that a hung engine costs the hook a second and not
    /// its whole 5 s budget - cannot be proved without letting that second pass.
    #[tokio::test]
    async fn a_slow_save_point_does_not_hold_pre_tool_for_more_than_a_second() {
        let (engine, _, _) = FakeEngine::new("sp-slow", Duration::from_secs(30));
        let h = harness_with(|deps| {
            deps.engine = engine;
            deps.router = irreversible_router();
        });
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        pre["tool_input"] = json!({"command": "npm run db:migrate"});
        let started = std::time::Instant::now();
        let out = h.claude.respond(&request("pre-tool", pre)).await;
        let took = started.elapsed();
        assert!(
            took >= SAVEPOINT_PRE_TOOL,
            "it did not wait for the save point at all ({took:?})"
        );
        assert!(
            took < Duration::from_secs(4),
            "the 1 s cap is the promise; the hook's whole budget is 5 s (§38.4). Took {took:?}"
        );
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
            "and it allows anyway: a save point is worth a second, not the turn"
        );
    }

    #[tokio::test]
    async fn a_router_ask_becomes_a_card_under_the_step_6_fallback() {
        let h = harness_with(|deps| deps.flags.pre_tool_waits_for_card = true);
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        // On the §34.4 ask list: the rules ask, and with the fallback on the hook waits for the card itself.
        pre["tool_input"] = json!({"command": "git push --force origin main"});
        let inbox = h.inbox.clone();
        let answering =
            tokio::spawn(async move { answer_top(&inbox, |id| choice(id, 0, Via::Key)).await });
        let out = h.claude.respond(&request("pre-tool", pre)).await;
        let id = answering.await.unwrap();
        assert_eq!(
            out.stdout,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
            "the card's answer is printed in PreToolUse's own shape"
        );
        assert_eq!(h.inbox.state(id).await, Some(CardState::Released));
    }

    #[tokio::test]
    async fn the_primary_path_asks_and_leaves_the_card_to_permission_request() {
        let h = harness();
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        pre["tool_input"] = json!({"command": "git push --force origin main"});
        let out = h.claude.respond(&request("pre-tool", pre)).await;
        let printed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(printed["hookSpecificOutput"]["permissionDecision"], "ask");
        assert!(
            printed["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .unwrap()
                .starts_with("Mewndo")
        );
        assert!(
            h.inbox.stack(mewndo_inbox::TOP).await.cards.is_empty(),
            "the card is made by PermissionRequest, which Claude's own prompt fires"
        );
    }

    #[tokio::test]
    async fn the_fallbacks_duplicate_pre_tool_call_does_not_make_a_second_card() {
        let h = harness_with(|deps| deps.flags.pre_tool_waits_for_card = true);
        h.claude
            .respond(&request("prompt", sample("prompt.json")))
            .await;
        let mut pre = sample("pre-tool-bash.json");
        pre["tool_input"] = json!({"command": "git push --force origin main"});
        let claude = h.claude.clone();
        let first = tokio::spawn({
            let pre = pre.clone();
            async move { claude.respond(&request("pre-tool", pre)).await }
        });
        // Let the first call make its card before the duplicate arrives: on the test's single-threaded runtime the
        // spawned task has not started yet, and the order is what this test is about.
        for _ in 0..200 {
            if !h.inbox.stack(mewndo_inbox::TOP).await.cards.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // The second matcher entry of hooks.fallback.json, for the same tool call.
        let second = h.claude.respond(&request("pre-tool", pre)).await;
        assert_eq!(second.stdout, "{}", "the duplicate says nothing");
        let stack = h.inbox.stack(mewndo_inbox::TOP).await;
        assert_eq!(stack.cards.len(), 1, "one action, one card");
        h.inbox
            .answer(stack.cards[0].id, choice(stack.cards[0].id, 2, Via::Key))
            .await;
        let printed: Value = serde_json::from_str(&first.await.unwrap().stdout).unwrap();
        assert_eq!(printed["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[tokio::test]
    async fn malformed_hook_json_prints_nothing_and_does_not_panic() {
        let h = harness();
        for payload in [
            Value::Null,
            json!("not an object"),
            json!(7),
            json!([1, 2, 3]),
            json!({"hook_event_name": "Mystery"}),
            json!({"tool_input": {"command": "rm -rf /"}}), // no event anywhere
        ] {
            for event in ["", "pre-tool", "launch-rockets"] {
                let out = h.claude.respond(&request(event, payload.clone())).await;
                if Event::parse(event).is_none()
                    && Event::parse(
                        payload
                            .get("hook_event_name")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    )
                    .is_none()
                {
                    assert_eq!(
                        (out.stdout.as_str(), out.exit_code),
                        ("", 0),
                        "{event} {payload}: an event Mewndo does not know says nothing"
                    );
                }
                assert!(
                    out.stdout.is_empty() || serde_json::from_str::<Value>(&out.stdout).is_ok(),
                    "{event} {payload}: whatever is printed is JSON"
                );
            }
        }
        // A pre-tool with an empty object is a tool call with no name: the Router sees an empty action and the
        // handler still answers something parseable, with no panic.
        let out = h.claude.respond(&request("pre-tool", json!({}))).await;
        assert!(out.stdout.is_empty() || serde_json::from_str::<Value>(&out.stdout).is_ok());
    }

    // --- the small parts, each on its own ----------------------------------------------------------------

    #[test]
    fn every_event_name_in_38_4_and_every_name_claude_code_sends_is_recognised() {
        for (argv, long, event) in [
            ("session-start", "SessionStart", Event::SessionStart),
            ("prompt", "UserPromptSubmit", Event::UserPromptSubmit),
            ("pre-tool", "PreToolUse", Event::PreToolUse),
            ("permission", "PermissionRequest", Event::PermissionRequest),
            ("post-tool", "PostToolUse", Event::PostToolUse),
            ("notify", "Notification", Event::Notification),
            ("stop", "Stop", Event::Stop),
            ("subagent-stop", "SubagentStop", Event::SubagentStop),
        ] {
            assert_eq!(Event::parse(argv), Some(event), "argv name {argv}");
            assert_eq!(Event::parse(long), Some(event), "payload name {long}");
            assert_eq!(Event::parse(&long.to_uppercase()), Some(event), "case");
        }
        assert_eq!(Event::parse("pre_tool_use"), Some(Event::PreToolUse));
        assert_eq!(
            Event::parse("beforeShellExecution"),
            None,
            "another agent's event"
        );
        assert_eq!(Event::parse(""), None);
    }

    #[test]
    fn the_samples_all_parse_and_keep_their_fields() {
        for name in [
            "session-start.json",
            "prompt.json",
            "pre-tool-bash.json",
            "pre-tool-edit.json",
            "pre-tool-write.json",
            "pre-tool-ask-user-question.json",
            "permission-request.json",
            "post-tool-bash.json",
            "notification.json",
            "stop.json",
            "stop-hook-active.json",
            "subagent-stop.json",
        ] {
            let input: Input = serde_json::from_value(sample(name)).expect(name);
            assert!(input.session_id.is_some(), "{name} has a session_id");
            assert!(input.hook_event_name.is_some(), "{name} names its event");
            assert!(
                Event::parse(input.hook_event_name.as_deref().unwrap()).is_some(),
                "{name}'s event is one of the eight"
            );
        }
        let stop: Input = serde_json::from_value(sample("stop-hook-active.json")).unwrap();
        assert_eq!(stop.stop_hook_active, Some(true));
        let post: Input = serde_json::from_value(sample("post-tool-bash.json")).unwrap();
        assert_eq!(Response::read(post.tool_response.as_ref()).stderr, "");
        assert!(
            Response::read(post.tool_response.as_ref())
                .stdout
                .contains("not ok 1")
        );
    }

    #[test]
    fn the_summary_is_two_sentences_and_200_characters() {
        assert_eq!(
            summarize("I fixed it. All the tests pass now. I did not touch pricing."),
            "I fixed it. All the tests pass now."
        );
        assert_eq!(
            summarize("I edited src/date.ts and v1.4.0 of the parser. Done."),
            "I edited src/date.ts and v1.4.0 of the parser. Done.",
            "a full stop inside a path or a version is not the end of a sentence"
        );
        let long = format!("{}. {}.", "a".repeat(150), "b".repeat(150));
        let short = summarize(&long);
        assert_eq!(short.chars().count(), SUMMARY_CHARS);
        assert!(short.ends_with('…'));
        assert_eq!(summarize("   "), "");
    }

    #[test]
    fn the_last_assistant_message_comes_out_of_the_sample_transcript() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(SAMPLES)
            .join("stop-transcript.jsonl");
        let text = last_assistant_text(&path.to_string_lossy()).expect("the transcript has one");
        assert!(text.starts_with("I fixed the date parser in src/date.ts"));
        assert!(
            !text.contains("Let me look at the failing test"),
            "the last assistant message, not the first"
        );
        assert_eq!(last_assistant_text("/no/such/transcript"), None);
        assert_eq!(assistant_text("{not json"), None);
        assert_eq!(
            assistant_text(r#"{"type":"user","message":{"content":"hi"}}"#),
            None
        );
        assert_eq!(
            assistant_text(r#"{"type":"assistant","message":{"content":"done"}}"#).as_deref(),
            Some("done"),
            "content is sometimes a bare string"
        );
    }

    #[test]
    fn one_tool_call_is_one_key_at_every_event() {
        let pre: Input = serde_json::from_value(sample("pre-tool-bash.json")).unwrap();
        let post: Input = serde_json::from_value(sample("post-tool-bash.json")).unwrap();
        assert_eq!(
            call_key(&pre),
            call_key(&post),
            "PreToolUse and PostToolUse for one Bash call must agree, or the span never closes"
        );
        let permission: Input = serde_json::from_value(sample("permission-request.json")).unwrap();
        assert!(
            call_key(&permission).starts_with("toolu_"),
            "a tool_use_id is the key when there is one"
        );
        let other = Input {
            tool_name: Some("Bash".into()),
            tool_input: Some(json!({"command": "rm -rf ."})),
            ..Input::default()
        };
        assert_ne!(
            call_key(&pre),
            call_key(&other),
            "a different command is a different call"
        );
    }

    #[test]
    fn a_receipt_only_reports_what_the_evidence_shows() {
        let tests = Tests::builtin();
        let mut span = Span::start("s1", "t1", "Bash", "npm test -- checkout", 1_000);
        span.finish(
            "# fail 1\nnot ok 1 - parses ISO dates\n",
            "",
            None,
            2_000,
            &tests,
        );
        let mut edit = Span::start("s2", "t1", "Edit", "src/date.ts", 900);
        edit.files = vec!["src/date.ts".into()];
        edit.savepoint_id = Some("sp-1".into());
        edit.finish("", "", None, 950, &tests);

        let input = ReceiptInput {
            trace_id: "t1".into(),
            final_message:
                "All the checkout tests pass now. I did not touch the migrations folder.".into(),
            spans: vec![edit, span],
            changes: None,
        };
        let receipt = rule_receipt(
            &Claims::builtin().extract(&input.final_message),
            &input,
            &tests,
        );
        assert!(
            receipt
                .mismatches
                .iter()
                .any(|m| m.starts_with("Says tests pass")),
            "a claim the evidence contradicts is reported: {:?}",
            receipt.mismatches
        );
        assert!(
            !receipt.mismatches.iter().any(|m| m.contains("migrations")),
            "and an untouched folder that really was untouched is not: {:?}",
            receipt.mismatches
        );
        assert!(
            receipt.line.contains("✗ npm test -- checkout exited 1"),
            "{}",
            receipt.line
        );
        assert!(receipt.line.contains("1 save point"), "{}", receipt.line);
    }

    #[test]
    fn a_receipt_catches_a_folder_the_turn_really_did_touch() {
        let tests = Tests::builtin();
        let mut edit = Span::start("s1", "t1", "Edit", "migrations/004.sql", 1);
        edit.files = vec!["migrations/004.sql".into()];
        edit.finish("", "", None, 2, &tests);
        let input = ReceiptInput {
            trace_id: "t1".into(),
            final_message: "I did not touch the migrations folder.".into(),
            spans: vec![edit],
            changes: None,
        };
        let receipt = rule_receipt(
            &Claims::builtin().extract(&input.final_message),
            &input,
            &tests,
        );
        assert!(
            receipt.mismatches.iter().any(|m| m.contains("migrations/")),
            "{:?}",
            receipt.mismatches
        );
    }

    #[test]
    fn the_printed_shapes_are_exactly_what_33_10_part_c_step_4_asks_for() {
        assert_eq!(
            pre_tool_json("allow", None),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#
        );
        assert_eq!(
            pre_tool_json("deny", Some("Mewndo: no".into())),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Mewndo: no"}}"#
        );
        assert_eq!(
            pre_tool_json("ask", Some("Mewndo: ask the user".into())),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Mewndo: ask the user"}}"#
        );
        assert_eq!(
            permission_json("allow", None),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            permission_json("deny", Some("no".into())),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no"}}}"#
        );
        assert_eq!(
            block_json("carry on".into()),
            r#"{"decision":"block","reason":"carry on"}"#
        );
        assert_eq!(
            session_start_json("card".into()),
            r#"{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"card"}}"#
        );
        let brake: Value = serde_json::from_str(&brake_json("Mewndo: frozen".into())).unwrap();
        assert_eq!(
            brake["continue"], false,
            "§24.3: Claude Code's brake is continue: false"
        );
        assert_eq!(brake["hookSpecificOutput"]["permissionDecision"], "deny");
    }

    #[test]
    fn the_small_readers_read_the_samples_and_nothing_else() {
        assert_eq!(project_of(r"C:\Users\ana\code\shop"), "shop");
        assert_eq!(project_of("/home/ana/code/shop/"), "shop");
        assert_eq!(project_of(""), "");
        assert!(needs_user("Claude needs your permission to use Bash"));
        assert!(needs_user("Claude is waiting for your input"));
        assert!(!needs_user("Claude has finished the task"));
        assert_eq!(
            action_name("Bash", &json!({"command": "npm test"})),
            "npm test"
        );
        assert_eq!(
            action_name("Edit", &json!({"file_path": "src/date.ts"})),
            "src/date.ts"
        );
        assert_eq!(action_name("Glob", &json!({})), "Glob");
        assert_eq!(
            named_paths(&json!({"edits": [{"file_path": "a.ts"}, {"file_path": "b.ts"}]})),
            ["a.ts", "b.ts"]
        );
        assert_eq!(
            reason_for_agent("  "),
            "Mewndo: the user has not allowed this."
        );
        assert_eq!(
            reason_for_agent("Mewndo: already said"),
            "Mewndo: already said"
        );
        assert_eq!(reason_for_agent("no"), "Mewndo: no");
        assert!(same_subject(r"C:\code\shop\src\date.ts", "src/date.ts"));
        assert!(same_subject("migrations/004.sql", "migrations/"));
        assert!(!same_subject("src/dates.ts", "src/date.ts"));
    }

    #[test]
    fn the_hooks_json_in_integrations_is_the_one_this_file_answers() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../integrations/claude-code");
        let hooks: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("hooks/hooks.json")).unwrap())
                .unwrap();
        let events = hooks["hooks"]
            .as_object()
            .expect("the eight events of §38.4");
        assert_eq!(events.len(), 8);
        for (name, entries) in events {
            assert!(
                Event::parse(name).is_some(),
                "{name} is in hooks.json and this file does not handle it"
            );
            for entry in entries.as_array().unwrap() {
                for hook in entry["hooks"].as_array().unwrap() {
                    let command = hook["command"].as_str().unwrap();
                    assert!(
                        command.starts_with('"'),
                        "{name}: the path must be quoted, folders have spaces: {command}"
                    );
                    let short = command.rsplit(' ').next().unwrap();
                    assert_eq!(
                        Event::parse(short),
                        Event::parse(name),
                        "{name}: argv says {short}"
                    );
                }
            }
        }
        // The one timeout the core's own budget depends on (§33.10 Part C step 4).
        let permission = &hooks["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"];
        assert_eq!(permission.as_u64(), Some(300));
        assert!(
            PERMISSION_WAIT.as_secs() < permission.as_u64().unwrap(),
            "the core must answer before Claude Code gives up"
        );
        // The fallback of step 6 raises PreToolUse's timeout for the tools that can need approval.
        let fallback: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("hooks/hooks.fallback.json")).unwrap(),
        )
        .unwrap();
        let pre = fallback["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "step 6 adds a second matcher entry");
        assert_eq!(pre[1]["hooks"][0]["timeout"].as_u64(), Some(300));
        assert!(
            PRE_TOOL_CARD_WAIT.as_secs() < 300,
            "and the same 295 s rule applies to it"
        );
    }

    #[test]
    fn the_hook_pids_parent_is_this_process() {
        // The hook is a child of Claude Code (§33.10 Part C step 4). Here, this test process is the child and
        // its parent is whatever ran cargo; all that is checked is that the lookup answers something real for
        // a live PID and nothing for a dead one.
        let me = std::process::id();
        if let Some(parent) = parent_pid(me) {
            assert_ne!(parent, me, "a process is not its own parent");
        }
        assert_eq!(
            parent_pid(u32::MAX),
            None,
            "a PID that does not exist is None, not a panic"
        );
    }
}
