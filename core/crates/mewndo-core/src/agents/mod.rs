//! One handler per agent kind. Each file turns that agent's hook events into Mewndo's own
//! actions - a trace, a span, a Router call, an Inbox card - and prints what the agent
//! expects to read back (spec §33.10 Parts C and F).
//!
//! The split is deliberate: §33.10 Part F says a schema that differs from Claude's is mapped
//! in that agent's own file and nowhere else, so one agent changing its hook format can never
//! reach another's handler.
pub mod claude;
pub mod codex;
pub mod cursor;

/// A card's 1 to 5 (§33.2), from what the Router already worked out, the same for every agent: one action must
/// not look riskier in one agent's card than in another's. A deny or a brake is a 5; a hard rule (the ask and
/// protect lists of §34.9 R1) or a destructive kind is a 4; anything else a 2.
pub fn risk_of(guarded: &mewndo_router::Guarded) -> u8 {
    use mewndo_router::Verdict;
    match guarded.decision.verdict {
        Verdict::Deny | Verdict::Brake => 5,
        _ if guarded.rule_outcome.hard() || guarded.rule_outcome.destructive => 4,
        _ => 2,
    }
}
