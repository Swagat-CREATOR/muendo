// R13: Inbox triage (spec §34.5, §34.9 R13). A notification or a permission request arrives; this decides
// whether it needs the user and how urgent it is, so the Inbox can order its cards.
//
// One `noul` and one `score`, sent as kind `triage`, which the gateway routes to Kaggle first (§37.3):
// nobody is blocked waiting for it, so it should not spend free Workers AI neurons. Deadline 1.5 s; past it
// the message is "shown as a normal card" (§34.5), which is what the fallback below produces.

use crate::answers::{Answers, Question};
use crate::{Backend, CallKind};
use serde::{Deserialize, Serialize};

/// Where an untriaged card sits: visible, middle of the list, waiting for the user. Not "ignore" -- a
/// message Mewndo could not read is not a message Mewndo may hide.
pub const NORMAL_URGENCY: f64 = 3.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Triage {
    /// True when the card should interrupt: a permission request, a question, a failure the user must see.
    pub needs_user: bool,
    /// 1 to 5 (§34.5), used only to order the cards.
    pub urgency: f64,
    pub backend: Backend,
    /// The model did not answer in time or at all, and this is the normal-card default.
    pub fallback: bool,
}

pub const KIND: CallKind = CallKind::Triage;

pub fn questions() -> Vec<Question> {
    vec![
        Question::noul("needs_user", "Does this message need the user's decision?"),
        Question::score("urgency", "How urgent is this for the user?"),
    ]
}

/// Read the two answers. `answers` is None when the deadline passed, the router is off or the response did
/// not parse -- all of which mean "a normal card".
///
/// The 0.5 threshold is deliberate and in the safe direction: a message the model is evenly split on is
/// shown as needing the user, because the cost of an extra card is a glance and the cost of a hidden
/// permission request is an agent stuck forever.
pub fn triage(answers: Option<&Answers>) -> Triage {
    let Some(answers) = answers else {
        return Triage {
            needs_user: true,
            urgency: NORMAL_URGENCY,
            backend: Backend::Rules,
            fallback: true,
        };
    };
    let needs = answers.noul("needs_user");
    let urgency = answers.score("urgency");
    Triage {
        needs_user: needs.is_none_or(|p| p >= 0.5),
        urgency: urgency.unwrap_or(NORMAL_URGENCY),
        backend: answers.backend,
        // A half-answered triage still orders the card, but it is recorded as a fallback so the Agents tab
        // does not count it as the model working.
        fallback: needs.is_none() || urgency.is_none(),
    }
}
