// §33.10 Part D step 6: "When a permission answer is released, call
// `router.habits.record(agent_kind, project, action_sig, answer)` (§34.9 R11)."
//
// The real thing fits, and is called. `mewndo_router::Router::record_answer` takes `&self`, holds its `Habits`
// behind its own mutex, and returns the §34.7 card ("Always allow `npm test` in shop?") on the third identical
// answer -- which is exactly what an actor that cannot hold a lock needs. The impl at the bottom of this file
// is the whole bridge.
//
// It still goes through a one-method trait, for two reasons that are not about the Router being unfinished:
//
//  1. A habit is learned from an answer *only after that answer is released* (§34.7: the count comes from the
//     Inbox, not from the rules). So the call sits inside the release path, past the grace and past Esc. The
//     only way to test that an Esc'd answer teaches nothing is to be able to watch the counter, and the real
//     `Habits` has no way to say "nobody called me".
//  2. Which Router instance to teach is the core's decision, not the Inbox's -- there is one per device, and
//     it is built with the user's rules file, a Clef client and a facts source this crate has no business
//     knowing about.
//
// What this crate deliberately does not do with the returned card: nothing but hand it on as
// `Event::Habit`. Accepting a habit writes a rule into the user's `rules.toml`, and both halves of that --
// `Habits::accept` and the temp-file-then-rename write (plot.md rule 4) -- belong to the core. The Inbox
// offering a habit and the Inbox applying one are different powers, and only the first one is Part D's.

use mewndo_router::habits::HabitRequest;
use mewndo_router::{Router, Sig, Verdict};
use std::sync::{Arc, Mutex};

/// §34.9 R11's `router.habits.record`.
pub trait HabitRecorder: Send + Sync + 'static {
    /// Count one answer the user actually gave. Returns the §34.7 card when this is the third identical one.
    fn record(
        &self,
        agent_kind: &str,
        project: &str,
        action_sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<HabitRequest>;
}

/// The real Router (§34). One line, because `record_answer` was written for exactly this caller -- see
/// mewndo-router/src/router.rs, whose own header lists "the Inbox -> router.habits.record(..)".
impl HabitRecorder for Router {
    fn record(
        &self,
        agent_kind: &str,
        project: &str,
        action_sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<HabitRequest> {
        self.record_answer(agent_kind, project, action_sig, answer, command_norm)
    }
}

/// Count nothing. For a core with no Router wired up, and for the tests that are not about habits.
///
/// Never learning is the safe failure: §34.7's habit turns into a standing allow, so a counter that
/// double-counted or counted an answer the user took back would hand out an allow the user never gave.
pub struct NoHabits;

impl HabitRecorder for NoHabits {
    fn record(&self, _: &str, _: &str, _: Sig, _: Verdict, _: &str) -> Option<HabitRequest> {
        None
    }
}

/// One counted answer, as a test sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub agent_kind: String,
    pub project: String,
    pub action_sig: Sig,
    pub answer: Verdict,
    pub command_norm: String,
}

/// Keeps every call, for tests and the fake agent harness. Cloning shares one log.
#[derive(Clone, Default)]
pub struct RecordingHabits(Arc<Mutex<Vec<Recorded>>>);

impl RecordingHabits {
    pub fn calls(&self) -> Vec<Recorded> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl HabitRecorder for RecordingHabits {
    fn record(
        &self,
        agent_kind: &str,
        project: &str,
        action_sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<HabitRequest> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Recorded {
                agent_kind: agent_kind.to_string(),
                project: project.to_string(),
                action_sig,
                answer,
                command_norm: command_norm.to_string(),
            });
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_router_is_what_gets_taught() {
        // Three identical allows, through the trait, must produce §34.7's card from the real counter -- not
        // from a reimplementation of it here.
        let router = Router::default();
        let sig: Sig = [3; 16];
        let recorder: &dyn HabitRecorder = &router;
        assert_eq!(
            recorder.record("claude-code", "shop", sig, Verdict::Allow, "npm test"),
            None
        );
        assert_eq!(
            recorder.record("claude-code", "shop", sig, Verdict::Allow, "npm test"),
            None
        );
        let offered = recorder
            .record("claude-code", "shop", sig, Verdict::Allow, "npm test")
            .expect("the third identical answer offers a habit (§34.7)");
        assert_eq!(offered.text, "Always allow `npm test` in shop?");
        assert_eq!(
            offered.options,
            ["yes".to_string(), "no".into(), "never ask".into()]
        );
    }
}
