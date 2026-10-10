// The cards themselves (spec §33.2), their states (§33.9) and the order they are shown in (§33.10 Part D
// step 5, §34.5).
//
// A card is plain data with no behaviour: the actor in inbox.rs owns every transition. That split is on
// purpose. `Card.state` is public because §33.10 Part D step 1 puts it in the type and because the UI and the
// `cards` table both read it, but nothing outside the actor ever *writes* it -- a card handed out by
// `Inbox::stack` is a clone, so a caller cannot move a card to `Released` by assigning to a field.

use mewndo_proto::{InboxAnswer, InboxCard, Via};
use mewndo_router::Sig;
use mewndo_router::Verdict;
use mewndo_router::triage::{NORMAL_URGENCY, Triage};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;
use ulid::Ulid;

/// A Ulid, as §33.10 Part D step 1 asks. Two things come free with it and are both used here: it sorts by
/// creation time, which is the tie-break in [`cmp_stack`], and it carries its own millisecond timestamp, so a
/// card id and a card's `created_at` can never disagree.
pub type CardId = Ulid;

/// The answer the user gave, exactly as §38.5 puts it on the wire. The Inbox does not define a parallel type:
/// what the app sends (`inbox.answer`) is what the actor stores, what goes in `answer_json`, and what the hook
/// receives on its oneshot, so there is no place for the three to drift apart.
pub type Answer = InboxAnswer;

/// §33.2's five card types. The string form is the `cards.kind` column (§38.6) and `inbox.card`'s `kind`
/// (§38.5); it is written out by hand rather than derived so that renaming the Rust variant cannot silently
/// change the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardKind {
    /// Claude Code / Codex `PermissionRequest`, Cursor `beforeShellExecution`, cloud `ask_user`.
    Permission,
    /// `AskUserQuestion`, `agent_needs_input`, cloud `ask_user` with options.
    Question,
    /// `Stop`, Codex `notify`, Cursor `stop`: a summary plus the Receipt (§35).
    Done,
    /// Guard or Heal (§23.4).
    Drift,
    /// A claim that does not match the evidence (§35).
    Receipt,
}

impl CardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CardKind::Permission => "permission",
            CardKind::Question => "question",
            CardKind::Done => "done",
            CardKind::Drift => "drift",
            CardKind::Receipt => "receipt",
        }
    }
}

/// One numbered option on a card (§33.2: "1 allow once · 2 always allow here · 3 deny", with "Recommended"
/// kept).
///
/// `answer` is what choosing this option means to the habit counter (§34.7). It lives on the option instead of
/// being inferred from the index, because "the third option is a deny" is true of a permission card and false
/// of a question with three answers, and getting it wrong would teach the user's own policy the opposite of
/// what they said.
///
/// `Deserialize` as well as `Serialize`, because the whole option -- including the flag §38.5 cannot carry --
/// goes into `cards.options_json` (§38.6) and is read back from there by whoever redraws an old card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Opt {
    pub label: String,
    /// §33.2 keeps the agent's own "Recommended" marker. It cannot travel on `inbox.card` yet: §38.5 types
    /// `options` as a list of strings, and widening it means bumping the protocol version and changing both
    /// sides in one commit (§32.5 rule 1). Until then the flag is for the core and the tests.
    pub recommended: bool,
    /// None for options that teach nothing: "add a reason", a question's answers, "clear".
    pub answer: Option<Verdict>,
}

impl Opt {
    pub fn new(label: impl Into<String>) -> Opt {
        Opt {
            label: label.into(),
            recommended: false,
            answer: None,
        }
    }

    pub fn teaching(label: impl Into<String>, answer: Verdict) -> Opt {
        Opt {
            label: label.into(),
            recommended: false,
            answer: Some(answer),
        }
    }

    pub fn recommended(mut self) -> Opt {
        self.recommended = true;
        self
    }
}

/// §33.9's five states, and nothing else. Released, Expired and Undone are all final: there is no edge out of
/// them in the table, so the actor refuses every command that would create one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CardState {
    Open,
    /// The grace is running (§33.4). `until` is when the answer is released if Esc does not arrive first, and
    /// is what the draining bar in the UI counts down.
    ///
    /// It is a `tokio::time::Instant`, not a `std::time::Instant`, so that it follows the same clock as the
    /// `sleep` that will fire -- including the virtual clock the tests run on.
    Answering {
        until: Instant,
    },
    Released,
    Expired,
    Undone,
}

impl CardState {
    /// The `cards.state` column (§38.6), in §33.9's own words.
    pub fn as_str(self) -> &'static str {
        match self {
            CardState::Open => "open",
            CardState::Answering { .. } => "answering",
            CardState::Released => "released",
            CardState::Expired => "expired",
            CardState::Undone => "undone",
        }
    }

    /// True while the card is still the user's to answer, which is also exactly the set the dock counts and
    /// the stack shows (§33.1). An `Answering` card stays visible because its bar is still draining and Esc
    /// still works on it.
    pub fn waiting(self) -> bool {
        matches!(self, CardState::Open | CardState::Answering { .. })
    }

    /// What the draining bar has left, or None when no answer is in flight.
    pub fn remaining(self) -> Option<Duration> {
        match self {
            CardState::Answering { until } => Some(until.saturating_duration_since(Instant::now())),
            _ => None,
        }
    }
}

/// The facts a permission card needs to teach a habit (§34.7, §34.9 R11). They come from the Router's guard
/// call -- `Guarded.sig`, `Action.command_norm` -- and are carried on the card because by the time the answer
/// is released, seconds or minutes later, the hook call that knew them has long returned.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionFacts {
    pub agent_kind: String,
    pub project: String,
    pub action_sig: Sig,
    /// The command as the user read it on the card, which is also what a habit rule would be written with.
    pub command_norm: String,
}

/// §33.10 Part D step 1.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub id: CardId,
    pub agent_id: String,
    /// The trace this card belongs to (§38.6 `cards.trace_id`). None for a card that is not part of an agent
    /// turn, such as a Drift card raised by the watcher.
    pub trace_id: Option<String>,
    pub kind: CardKind,
    pub title: String,
    pub body: String,
    pub options: Vec<Opt>,
    /// 1-5 (§33.2). Risk orders nothing: it is shown, and §34.5 uses it to decide what may be auto-approved
    /// before a card is ever made.
    pub risk: u8,
    pub state: CardState,
    /// Milliseconds since the epoch, as `cards.created_at` stores it (§38.6).
    pub created_at: i64,
    /// The Router's triage score, 1-5 (§34.5). Not a column in §38.6 and deliberately not persisted: every
    /// card is expired at start-up (§33.10 Part D step 4), so a score that outlived the process would only
    /// ever order cards that are already gone.
    pub urgency: f64,
    /// How long the thing that is waiting will wait: the hook's own timeout (§33.9 gives 300 s for
    /// permissions, §33.2 a 15 s reply window on a Done card). When it passes the card expires itself, which
    /// is the half of "nobody is blocked forever" that does not depend on the hook remembering to call back.
    /// None means no deadline of its own -- only the Inbox-wide default applies.
    pub deadline: Option<Duration>,
    /// §38.5's `thumb`: a screenshot for a computer-use card (§36).
    pub thumb: Option<String>,
    /// Present on permission cards; what `router.habits.record` needs at release.
    pub permission: Option<PermissionFacts>,
}

/// Milliseconds since the epoch. A clock that has been set behind the epoch would give a negative number
/// rather than panic, because a wrong card order is a cosmetic bug and a crashed Inbox blocks every agent.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Card {
    /// A new card in `Open`, with a fresh Ulid and the untriaged urgency of §34.5 ("shown as a normal card").
    pub fn new(
        kind: CardKind,
        agent_id: impl Into<String>,
        title: impl Into<String>,
        body: impl Into<String>,
    ) -> Card {
        Card {
            id: Ulid::new(),
            agent_id: agent_id.into(),
            trace_id: None,
            kind,
            title: title.into(),
            body: body.into(),
            options: Vec::new(),
            risk: 0,
            state: CardState::Open,
            created_at: now_ms(),
            urgency: NORMAL_URGENCY,
            deadline: None,
            thumb: None,
            permission: None,
        }
    }

    /// The §33.2 permission card, with its three options and their meaning to the habit counter in one place.
    ///
    /// "Always allow here" counts as an allow, like "allow once": both are the user saying yes to this action
    /// in this project, which is what §34.7 counts. Turning it into a standing rule straight away is the
    /// core's job -- `Habits::accept` -- because writing the user's rules.toml needs the temp-file-then-rename
    /// path this crate cannot reach (mewndo-router/src/habits.rs says the same).
    pub fn permission(
        agent_id: impl Into<String>,
        title: impl Into<String>,
        body: impl Into<String>,
        risk: u8,
        facts: PermissionFacts,
    ) -> Card {
        let mut card = Card::new(CardKind::Permission, agent_id, title, body);
        card.risk = risk;
        card.options = vec![
            Opt::teaching("Allow once", Verdict::Allow),
            Opt::teaching("Always allow here", Verdict::Allow),
            Opt::teaching("Deny", Verdict::Deny),
            Opt::new("Add a reason"),
        ];
        card.permission = Some(facts);
        card
    }

    /// Take the urgency and the "does this need the user?" answer from `router.triage` (§34.5, §34.9 R13).
    /// A card the model said does not need the user is still made and still shown -- triage orders the stack,
    /// it does not hide anything (see mewndo-router/src/triage.rs).
    pub fn triaged(mut self, triage: &Triage) -> Card {
        self.urgency = triage.urgency;
        self
    }

    /// §38.5's `inbox.card`. `grace_ms` is passed in because the grace is the Inbox's setting, not the card's,
    /// and the UI needs it to size the draining bar.
    pub fn to_proto(&self, grace: Duration) -> InboxCard {
        InboxCard {
            id: self.id.to_string(),
            kind: self.kind.as_str().to_string(),
            agent_id: self.agent_id.clone(),
            title: self.title.clone(),
            body: self.body.clone(),
            options: self.options.iter().map(|o| o.label.clone()).collect(),
            risk: self.risk,
            thumb: self.thumb.clone(),
            grace_ms: grace.as_millis() as u64,
        }
    }

    /// The verdict the chosen option teaches the habit counter, or None when this answer teaches nothing:
    /// a question, a typed reason, or a choice index the card does not have.
    pub fn taught_by(&self, answer: &Answer) -> Option<Verdict> {
        self.options
            .get(answer.choice?)
            .and_then(|option| option.answer)
    }
}

/// §33.10 Part D step 5: "Order cards by the Router's urgency score (§34.5), then by time."
///
/// Urgency first, highest first. Then newest first, because §33.1 draws the stack as "newest on top" -- a card
/// that just arrived is about the thing the user is doing now. Starvation is handled by the clock, not by the
/// order: an unanswered card expires at its deadline (§33.9), so an old card cannot sit at the bottom for ever.
///
/// The id breaks a remaining tie. Two cards made in the same millisecond must still have one order, or `stack`
/// could return them in a different arrangement on each call and the UI would flicker between two layouts.
///
/// A NaN urgency is handled before the comparison, not by it. It comes from a bad model answer, and it must
/// never jump the queue: a card nobody can score is the *least* trustworthy thing to put on top. `total_cmp`
/// alone would do the opposite, because IEEE total order ranks a positive NaN above `+inf`, which in this
/// descending sort means first. So NaN is pushed to the end explicitly, and `total_cmp` then handles the real
/// scores (`partial_cmp` would return `None` on NaN and leave `sort_by` unpredictable).
pub fn cmp_stack(a: &Card, b: &Card) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a.urgency.is_nan(), b.urgency.is_nan()) {
        (true, false) => return Ordering::Greater, // a is unscored: after b
        (false, true) => return Ordering::Less,    // b is unscored: after a
        _ => {}                                    // both scored, or both NaN: fall through to time
    }
    b.urgency
        .total_cmp(&a.urgency)
        .then(b.created_at.cmp(&a.created_at))
        .then(b.id.cmp(&a.id))
}

/// An answer that picked option `n` (§33.2's number keys).
pub fn choice(card: CardId, n: usize, via: Via) -> Answer {
    Answer {
        card_id: card.to_string(),
        choice: Some(n),
        text: None,
        via,
    }
}

/// An answer that is typed or spoken text (Space, or V through Wispr Flow; §33.5).
pub fn text(card: CardId, text: impl Into<String>, via: Via) -> Answer {
    Answer {
        card_id: card.to_string(),
        choice: None,
        text: Some(text.into()),
        via,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(urgency: f64, created_at: i64) -> Card {
        let mut c = Card::new(CardKind::Question, "a", "t", "b");
        c.urgency = urgency;
        c.created_at = created_at;
        c
    }

    #[test]
    fn the_stack_is_urgency_then_newest() {
        let old_urgent = card(5.0, 1_000);
        let new_urgent = card(5.0, 2_000);
        let new_calm = card(1.0, 3_000);
        let mut cards = [new_calm.clone(), old_urgent.clone(), new_urgent.clone()];
        cards.sort_by(cmp_stack);
        assert_eq!(
            cards.iter().map(|c| c.created_at).collect::<Vec<_>>(),
            [2_000, 1_000, 3_000],
            "urgency wins over time, and the newer of two equally urgent cards is on top"
        );
    }

    #[test]
    fn a_nan_urgency_sorts_last_instead_of_scrambling_the_stack() {
        let mut cards = [card(f64::NAN, 1), card(2.0, 2), card(4.0, 3)];
        cards.sort_by(cmp_stack);
        let scores: Vec<String> = cards.iter().map(|c| c.urgency.to_string()).collect();
        assert_eq!(scores, ["4", "2", "NaN"]);
    }

    #[test]
    fn two_cards_made_in_the_same_millisecond_still_have_one_order() {
        let a = card(3.0, 7);
        let b = card(3.0, 7);
        let one = {
            let mut v = vec![a.clone(), b.clone()];
            v.sort_by(cmp_stack);
            v
        };
        let other = {
            let mut v = vec![b, a];
            v.sort_by(cmp_stack);
            v
        };
        assert_eq!(
            one, other,
            "the id breaks the tie, so the layout cannot flicker"
        );
    }

    #[test]
    fn a_permission_card_teaches_allow_allow_deny_and_nothing_else() {
        let card = Card::permission(
            "agent-1",
            "Run npm test?",
            "shop",
            2,
            PermissionFacts {
                agent_kind: "claude-code".into(),
                project: "shop".into(),
                action_sig: [7; 16],
                command_norm: "npm test".into(),
            },
        );
        let taught = |n| card.taught_by(&choice(card.id, n, Via::Key));
        assert_eq!(taught(0), Some(Verdict::Allow));
        assert_eq!(
            taught(1),
            Some(Verdict::Allow),
            "always allow here is still an allow"
        );
        assert_eq!(taught(2), Some(Verdict::Deny));
        assert_eq!(
            taught(3),
            None,
            "'add a reason' is not an answer about the action"
        );
        assert_eq!(
            taught(9),
            None,
            "an option the card does not have teaches nothing"
        );
        assert_eq!(
            card.taught_by(&text(card.id, "not like that", Via::Voice)),
            None,
            "typed text is not one of the counted answers (§34.7)"
        );
    }

    #[test]
    fn the_wire_card_matches_38_5() {
        let mut card = Card::new(CardKind::Permission, "agent-1", "Run npm test?", "shop");
        card.options = vec![Opt::new("Allow once").recommended(), Opt::new("Deny")];
        card.risk = 3;
        let wire = card.to_proto(Duration::from_millis(2000));
        assert_eq!(wire.id, card.id.to_string());
        assert_eq!(wire.kind, "permission");
        assert_eq!(wire.options, vec!["Allow once".to_string(), "Deny".into()]);
        assert_eq!((wire.risk, wire.grace_ms), (3, 2000));
    }

    #[test]
    fn every_state_has_the_name_33_9_uses() {
        assert_eq!(CardState::Open.as_str(), "open");
        assert_eq!(
            CardState::Answering {
                until: Instant::now()
            }
            .as_str(),
            "answering"
        );
        assert_eq!(CardState::Released.as_str(), "released");
        assert_eq!(CardState::Expired.as_str(), "expired");
        assert_eq!(CardState::Undone.as_str(), "undone");
        assert!(CardState::Open.waiting());
        assert!(
            CardState::Answering {
                until: Instant::now()
            }
            .waiting()
        );
        for done in [CardState::Released, CardState::Expired, CardState::Undone] {
            assert!(
                !done.waiting(),
                "{} is not the user's to answer",
                done.as_str()
            );
        }
    }
}
