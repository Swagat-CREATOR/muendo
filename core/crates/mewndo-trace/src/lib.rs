//! Receipts (spec §35): check what an agent SAYS it did against what the evidence shows it did.
//!
//! One **trace** is one agent turn, from the user's prompt to `Stop`. One **span** is one thing done inside it:
//! a shell command with its exit code and output tail, a file edit with its save point, a subagent, an MCP call
//! or a computer-use step. At `Stop`, mewndo-core calls [`Receipts::check`] with the trace and gets back a
//! [`Receipt`]: a line for the Done card, or a list of mismatches for a warning card and a "send back" message.
//!
//! The order of the check matters more than any single part of it (§35.2):
//!
//! | Step | What | Budget |
//! |---|---|---|
//! | T5 | Claim extraction from the final message, rules only ([`claims`]) | under 5 ms |
//! | T4, T6 | Evidence lookup and the hard-rule table ([`rules`]) | under 5 ms |
//! | T7 | Whatever the rules cannot settle, as one batched Router call ([`soft`]) | 3 s, then rules only |
//! | T8, T9 | The Receipt line, and the send-back message ([`receipt`]) | - |
//!
//! Everything before T7 is pure CPU work over data the caller already has, so the whole rule pass settles in
//! well under 10 ms and a turn with no soft claims never waits for a model at all. That is the point: the Claude
//! Code `Stop` hook holds its reply window open for this check, so a slow check is a slow agent.
//!
//! ## What this crate does not own
//!
//! * **Storage.** The real spans live in SQLite (§38.6) and the real file diff comes from the v0 engine. Both
//!   are traits here ([`SpanStore`], [`EngineClient`], [`Disk`]) with in-memory fakes, so the rules are tested
//!   without a database and this crate needs no C compiler (docs/decisions.md, "desk.db").
//! * **The network.** T7 builds the Router request and reads its answers; the deadline, the hedge and the warm
//!   connection stay in the one place that owns them (§34.9 R6). If no answers arrive, every soft claim stays
//!   "unverified" - the rule-based fallback CLAUDE.md rule 3 asks for.
//!
//! ## T10, OTLP export: not built, and why
//!
//! §35.5 T10 maps traces and spans to OTLP spans behind an optional `otlp` feature, off by default. It is a
//! **documented gap**, not a stub: building it means adding `opentelemetry` and `opentelemetry-otlp` (and a
//! gRPC or HTTP stack under them) to the workspace's pinned set for a feature nobody turns on, and every one of
//! those crates would then be compiled, locked and audited for a shipped build that never calls them. Receipts
//! are worth nothing to the user until T1 to T9 are right. The shape it needs is already here: [`Span`] carries
//! the three attributes T10 names (`mewndo.agent` from [`Trace::agent`], `mewndo.kind` from [`Span::kind`] and
//! `mewndo.exit_code` from [`Span::exit_code`]), and nothing in a span holds Show Me data, which T10 forbids
//! exporting. When a user actually runs an observability tool, add the feature then.
#![forbid(unsafe_code)]

pub mod claims;
pub mod runner;
pub mod span;
pub mod store;

pub use claims::{Claim, Claims, MAX_CLAIMS};
pub use runner::{Runner, Tests};
pub use span::{Span, SpanKind};
pub use store::{
    Changes, Diffs, Disk, EngineClient, MemoryDisk, MemoryStore, RealDisk, SpanStore, StaticEngine,
};

use serde::{Deserialize, Serialize};

/// The claim types §35.5 T5 recognizes. The `path`-carrying ones keep their subject in [`Claim::subject`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimType {
    TestsPass,
    TestsFail,
    BuildOk,
    Untouched,
    Created,
    Deleted,
    EmailSent,
    NoChanges,
}

impl ClaimType {
    /// Parse the `type` field of a claims.toml entry. Returns `None` for an unknown name so a user's override
    /// file fails with a message naming the entry, instead of quietly matching nothing.
    pub fn parse(name: &str) -> Option<ClaimType> {
        Some(match name {
            "tests_pass" => ClaimType::TestsPass,
            "tests_fail" => ClaimType::TestsFail,
            "build_ok" => ClaimType::BuildOk,
            "untouched" => ClaimType::Untouched,
            "created" => ClaimType::Created,
            "deleted" => ClaimType::Deleted,
            "email_sent" => ClaimType::EmailSent,
            "no_changes" => ClaimType::NoChanges,
            _ => return None,
        })
    }
}
