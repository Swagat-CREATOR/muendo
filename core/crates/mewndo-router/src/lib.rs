// The Clef Router (spec §34): the thing that decides, before every risky agent step, whether it happens.
//
// Three deciders, in this order, because that is the order of their costs (§28.1 rule 3, §34.1):
//   1. Rules      microseconds, on this machine, never wrong about a disk format        rules.rs
//   2. Clef       tens of milliseconds plus a round trip to a data centre               clef.rs, answers.rs
//   3. The user   seconds to minutes, through the Inbox                                 the caller's job
// Every step down that list is slower, so a step is only taken when the one above it did not decide. The
// model is never asked about something the rules already settled, and the user is never asked about something
// the model was sure of.
//
// This crate is a library with no runtime: no threads, no sockets, no database. The core (§38.1) owns those
// and calls in. That is what makes `decide` (decide.rs) a pure function that a JSON fixture can test.
//
// What it does not do, honestly (§28.10):
//   - no HTTP: clef.rs is a trait with a stub and a fake. The real warm connection is the core's job.
//   - no rules hot reload: §34.9 R1's `notify` + `ArcSwap` swap is deferred; see rules.rs.
//   - no writing to the user's rules.toml: habits are counted and offered, not persisted; see habits.rs.
//   - no database: §34.4's facts come from a trait the core implements; see facts.rs.

pub mod answers;
pub mod cache;
pub mod clef;
pub mod decide;
pub mod facts;
pub mod habits;
pub mod normalize;
pub mod router;
pub mod rules;
pub mod scope;
pub mod sig;
pub mod triage;
pub mod voice;

// Re-exports: the handful of names a caller needs without knowing which module they live in. Every module
// above exists, so these are live. (They were held back while the crate was being written, because the
// workspace globs `crates/*` and a `pub use` of a type that does not exist yet fails every other crate's
// build too.)
pub use answers::{Answer, Answers, Question, QuestionType};
pub use decide::{Decision, decide};
pub use facts::{ActionFacts, Facts, RuleOutcome};
pub use normalize::{Action, Kind, normalize};
pub use router::{GuardInput, Guarded, Router};
pub use rules::{CompiledRules, RulesFile};
pub use scope::Scope;
pub use sig::Sig;

use serde::{Deserialize, Serialize};

/// What actually happens to the action. This is the final answer, the one the hook acts on.
///
/// It is deliberately *not* the same set as [`ChoiceVerdict`], which is the vocabulary the model picks from:
/// the model may say `skip_duplicate`, but what the agent is told is a deny with a reason (§34.4 row 4).
/// Keeping the two apart means a model word can never reach the hook unexamined.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The action runs.
    Allow,
    /// A save point is written first, then the action runs (§34.4 row 5).
    SavepointThenAllow,
    /// The hook waits for the Inbox card.
    Ask,
    /// The action does not run; the agent is told why.
    Deny,
    /// The session is frozen (§24).
    Brake,
}

impl Verdict {
    /// True when the action goes ahead. Used by the auto-approve counter (§34.5) and by habits, which only
    /// learn from answers that let work continue or stop it, never from a freeze.
    pub fn allows(self) -> bool {
        matches!(self, Verdict::Allow | Verdict::SavepointThenAllow)
    }
}

/// The six options the §34.3 `verdict` question offers the model. The strings are the wire format and must
/// match the gateway's option list exactly (cloud/gateway/src/gateway.js), because the gateway normalizes the
/// model's probability map against them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceVerdict {
    Allow,
    SavepointThenAllow,
    AskUser,
    SkipDuplicate,
    Deny,
    Brake,
}

impl ChoiceVerdict {
    pub const ALL: [ChoiceVerdict; 6] = [
        ChoiceVerdict::Allow,
        ChoiceVerdict::SavepointThenAllow,
        ChoiceVerdict::AskUser,
        ChoiceVerdict::SkipDuplicate,
        ChoiceVerdict::Deny,
        ChoiceVerdict::Brake,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ChoiceVerdict::Allow => "allow",
            ChoiceVerdict::SavepointThenAllow => "savepoint_then_allow",
            ChoiceVerdict::AskUser => "ask_user",
            ChoiceVerdict::SkipDuplicate => "skip_duplicate",
            ChoiceVerdict::Deny => "deny",
            ChoiceVerdict::Brake => "brake",
        }
    }

    pub fn parse(s: &str) -> Option<ChoiceVerdict> {
        ChoiceVerdict::ALL.into_iter().find(|c| c.as_str() == s)
    }
}

/// Which decider produced the answer. Logged on every decision (§34.4) so the Agents tab can show how often
/// the model was even reached, and so `cargo test` can assert that the kill switch really stopped the calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Backend {
    /// No model was used: a rule decided, the deadline passed, the router is off, or shadow mode.
    #[default]
    Rules,
    WorkersAi,
    Kaggle,
    /// A decision from the last 5 minutes for the same brief and action (§34.8).
    Cache,
    /// The user's own standing answer, learned from three identical replies (§34.7).
    Habit,
}

/// Shadow or active, per agent (§34.6). Every agent starts in shadow: the model answers, the answer is
/// stored next to what really happened, and nothing the model says changes the outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Shadow,
    Active,
}

/// What the call is for. Picks the deadline (§34.8) and the gateway's routing order (§37.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    /// The hook path: the tightest deadline, never the loosest (the gateway's default too).
    #[default]
    Guard,
    Voice,
    Triage,
    Receipt,
}

impl CallKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CallKind::Guard => "guard",
            CallKind::Voice => "voice",
            CallKind::Triage => "triage",
            CallKind::Receipt => "receipt",
        }
    }

    /// §34.8, the hackathon profile: the PC calls the gateway over the internet, so these are far wider than
    /// §29.4's same-data-centre numbers. Past the deadline the rules decide and the call is wasted, so the
    /// deadline is also the promise to the agent about how long it may be blocked.
    pub fn deadline(self) -> std::time::Duration {
        std::time::Duration::from_millis(match self {
            CallKind::Guard => 300,
            CallKind::Voice => 400,
            CallKind::Triage => 1500,
            CallKind::Receipt => 3000,
        })
    }
}
