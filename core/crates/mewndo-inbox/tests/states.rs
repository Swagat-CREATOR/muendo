// §33.10 Part D's own bar: "unit tests cover every state change: Esc during grace, a second answer ignored,
// expiry, and undo." Plus the three the task adds -- a save point slower than 300 ms, a card the hook timed
// out on, and the stack order -- and both directions of the rule that matters most (§33.9): a card must never
// release an answer the user took back, and must never block anyone for ever.
//
// This is an integration test on purpose. It can only see the public API, which is the same surface
// mewndo-core will use, so a test that passes here is also proof the Inbox can be driven from outside.
//
// Time is virtual (`start_paused = true`). Nothing here sleeps for real: tokio only advances its clock when
// every task is idle, so a 2 s grace, a 300 ms budget and a 300 s hook timeout are all exact and instant, and
// each step of the chain (grace -> save point -> release) is seen to be processed before the next deadline.
// A test with a real 2 s sleep would be slow *and* flaky on a loaded machine, which is the worst of both.

use mewndo_inbox::engine::{EngineError, FakeEngine};
use mewndo_inbox::habits::RecordingHabits;
use mewndo_inbox::store::{self, Recording};
use mewndo_inbox::{
    Card, CardKind, CardState, Config, Deps, Event, Inbox, PermissionFacts, Sig, TOP, Verdict,
    choice, text,
};
use mewndo_proto::{InboxRelease, Via};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::time::Instant;

const GRACE: Duration = Duration::from_secs(2);
const BUDGET: Duration = Duration::from_millis(300);
const SIG: Sig = [7; 16];

struct H {
    inbox: Inbox,
    rows: Recording,
    habits: RecordingHabits,
    engine: Arc<FakeEngine>,
    events: broadcast::Receiver<Event>,
}

impl H {
    fn with(config: Config, engine: FakeEngine) -> H {
        let rows = Recording::default();
        let habits = RecordingHabits::default();
        let engine = Arc::new(engine);
        let inbox = Inbox::start(
            config,
            Deps {
                writer: Box::new(rows.clone()),
                engine: engine.clone(),
                habits: Box::new(habits.clone()),
            },
        );
        let events = inbox.subscribe();
        H {
            inbox,
            rows,
            habits,
            engine,
            events,
        }
    }

    /// A save point that comes back inside the 300 ms budget.
    fn fast() -> H {
        H::with(Config::default(), FakeEngine::new("sp-1", Duration::ZERO))
    }

    /// A save point that takes 1 s: §33.10 Part D step 3's "if it's slower, release anyway".
    fn slow() -> H {
        H::with(
            Config::default(),
            FakeEngine::new("sp-late", Duration::from_secs(1)),
        )
    }

    /// The statements written since start-up, without the sweep that start-up itself queues.
    fn statements(&self) -> Vec<&'static str> {
        self.rows.statements().into_iter().skip(1).collect()
    }

    /// Every value written into a `state` column since start-up: the state machine's own history.
    fn states(&self) -> Vec<String> {
        self.rows.states()
    }

    fn events(&mut self) -> Vec<Event> {
        let mut seen = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            seen.push(event);
        }
        seen
    }
}

/// Let every timer due within `d` fire, and every command they send be processed.
async fn settle(d: Duration) {
    tokio::time::sleep(d).await;
}

fn question(agent: &str) -> Card {
    let mut card = Card::new(
        CardKind::Question,
        agent,
        "Which date format?",
        "ISO or local",
    );
    card.options = vec![
        mewndo_inbox::Opt::new("ISO 8601").recommended(),
        mewndo_inbox::Opt::new("Local"),
    ];
    card
}

fn permission(agent: &str) -> Card {
    Card::permission(
        agent,
        "Run `npm test`?",
        "shop",
        2,
        PermissionFacts {
            agent_kind: "claude-code".into(),
            project: "shop".into(),
            action_sig: SIG,
            command_norm: "npm test".into(),
        },
    )
}

// --- rule 1: a card never releases an answer the user took back -----------------------------------------

#[tokio::test(start_paused = true)]
async fn esc_during_the_grace_takes_the_answer_back() {
    let mut h = H::fast();
    let (id, mut waiting) = h.inbox.create(question("a1")).await;

    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    assert!(
        matches!(h.inbox.state(id).await, Some(CardState::Answering { .. })),
        "§33.9: the user answers -> answering (2 s grace)"
    );

    h.inbox.cancel(id).await;
    assert_eq!(
        h.inbox.state(id).await,
        Some(CardState::Open),
        "§33.9: Esc -> open"
    );

    // Long past the grace, the budget and anything else that could still fire.
    settle(Duration::from_secs(60)).await;
    assert_eq!(h.inbox.state(id).await, Some(CardState::Open));
    assert_eq!(
        waiting.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty),
        "the agent was never told, and is still waiting"
    );
    assert!(
        h.engine.calls().is_empty(),
        "no save point is written for an answer that was taken back"
    );
    assert_eq!(h.states(), vec!["open", "answering", "open"]);
    assert_eq!(
        h.statements(),
        vec![store::INSERT, store::ANSWERED, store::REOPENED],
        "the database followed every step, and REOPENED clears answer_json"
    );
    assert!(
        matches!(h.events().last(), Some(Event::Reopened(card)) if *card == id.to_string()),
        "the card is on screen again"
    );
}

#[tokio::test(start_paused = true)]
async fn esc_while_the_save_point_is_being_written_still_takes_the_answer_back() {
    // The riskiest moment in the whole crate: the grace has ended, the save point is in flight, and the user
    // presses Esc. §33.4 only promises Esc during the 2 s, but an answer that has not reached the agent is
    // still an answer the user can take back -- and releasing one they reversed is the single outcome this
    // crate exists to prevent.
    let h = H::slow();
    let (id, mut waiting) = h.inbox.create(question("a1")).await;
    h.inbox.answer(id, choice(id, 0, Via::Click)).await;

    settle(GRACE + Duration::from_millis(10)).await;
    assert!(
        matches!(h.inbox.state(id).await, Some(CardState::Answering { .. })),
        "the grace is over but the 1 s save point has not come back, so nothing is released yet"
    );
    assert_eq!(h.engine.calls().len(), 1, "the save point was asked for");

    h.inbox.cancel(id).await;
    settle(Duration::from_secs(60)).await;

    assert_eq!(h.inbox.state(id).await, Some(CardState::Open));
    assert_eq!(
        waiting.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty),
        "the release was refused when it finally arrived"
    );
    assert_eq!(
        h.statements(),
        vec![store::INSERT, store::ANSWERED, store::REOPENED],
        "and the late save point was not attached to a card that never released"
    );
}

#[tokio::test(start_paused = true)]
async fn a_second_answer_is_ignored() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;

    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    h.inbox.answer(id, choice(id, 1, Via::Key)).await;
    assert!(matches!(
        h.inbox.state(id).await,
        Some(CardState::Answering { .. })
    ));

    let released = waiting.await.expect("the first answer is released");
    assert_eq!(
        released.choice,
        Some(0),
        "the second answer changed nothing"
    );
    assert_eq!(h.inbox.state(id).await, Some(CardState::Released));
    assert_eq!(
        h.statements()
            .iter()
            .filter(|sql| **sql == store::ANSWERED)
            .count(),
        1,
        "and it was never even written down"
    );
    assert_eq!(h.states(), vec!["open", "answering", "released"]);
    let _ = h.events();
}

#[tokio::test(start_paused = true)]
async fn an_answer_addressed_to_another_card_is_never_applied() {
    let h = H::fast();
    let (first, _a) = h.inbox.create(question("a1")).await;
    let (second, _b) = h.inbox.create(question("a1")).await;

    h.inbox.answer(first, choice(second, 0, Via::Key)).await;
    settle(Duration::from_secs(10)).await;
    assert_eq!(
        h.inbox.state(first).await,
        Some(CardState::Open),
        "a mixed-up card id drops the answer instead of applying it to the wrong card"
    );
    assert_eq!(h.inbox.state(second).await, Some(CardState::Open));
}

#[tokio::test(start_paused = true)]
async fn answers_cancels_and_undos_after_the_release_change_nothing() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;
    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    waiting.await.unwrap();

    h.inbox.answer(id, choice(id, 1, Via::Key)).await;
    h.inbox.cancel(id).await;
    assert_eq!(
        h.inbox.state(id).await,
        Some(CardState::Released),
        "§33.9 has no edge out of released except Undo"
    );
    assert!(h.inbox.undo(id).await.is_some());
    assert_eq!(h.inbox.state(id).await, Some(CardState::Undone));
    assert!(
        h.inbox.undo(id).await.is_none(),
        "a card can only be undone once"
    );
    let _ = h.events();
}

// --- rule 2: nobody is blocked forever ------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_card_the_hook_timed_out_on_becomes_expired_and_wakes_the_agent() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;

    // What the hook forwarder does when its own timeout runs out, or when `PostToolUse` says the user
    // answered in the terminal (§33.9).
    h.inbox.expire(id).await;

    assert_eq!(h.inbox.state(id).await, Some(CardState::Expired));
    assert!(
        waiting.await.is_err(),
        "the wait ends at once, which is the agent's cue to fall back to its own prompt (§33.9)"
    );
    assert_eq!(h.statements(), vec![store::INSERT, store::STATE]);
    assert_eq!(h.states(), vec!["open", "expired"]);
    assert!(matches!(h.events().last(), Some(Event::Expired(card)) if *card == id.to_string()));

    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    settle(Duration::from_secs(10)).await;
    assert_eq!(
        h.inbox.state(id).await,
        Some(CardState::Expired),
        "answering an expired card does not revive it: the agent has moved on"
    );
}

#[tokio::test(start_paused = true)]
async fn a_card_nobody_answers_expires_itself_at_the_hook_deadline() {
    // The half of "nobody is blocked forever" that does not depend on the hook calling back: if the agent's
    // process is killed, nothing will ever call `expire`.
    let h = H::fast();
    let mut card = question("a1");
    card.deadline = Some(Duration::from_secs(300)); // §33.9: 300 s for permissions
    let (id, waiting) = h.inbox.create(card).await;

    settle(Duration::from_secs(299)).await;
    assert_eq!(
        h.inbox.state(id).await,
        Some(CardState::Open),
        "still the user's to answer"
    );

    settle(Duration::from_secs(2)).await;
    assert_eq!(h.inbox.state(id).await, Some(CardState::Expired));
    assert!(waiting.await.is_err());
}

#[tokio::test(start_paused = true)]
async fn the_inbox_shutting_down_wakes_every_waiting_agent() {
    let h = H::fast();
    let (_, first) = h.inbox.create(question("a1")).await;
    let (_, second) = h.inbox.create(question("a2")).await;
    let inbox = h.inbox.clone();

    drop(h);
    drop(inbox); // the core is stopping: the last handle is gone

    assert!(
        first.await.is_err(),
        "no hook waits out its timeout against a dead Inbox"
    );
    assert!(second.await.is_err());
}

#[tokio::test(start_paused = true)]
async fn a_card_created_after_the_inbox_is_gone_fails_instead_of_waiting() {
    let inbox = {
        let h = H::fast();
        h.inbox.clone()
    };
    // Every other handle has gone, so the actor has stopped. `create` must still return, and the agent must
    // still be told at once that nobody is listening.
    let (_, waiting) = inbox.create(question("a1")).await;
    assert!(waiting.await.is_err());
}

// --- the grace and the save point (§33.4, step 3) -------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_answer_waits_the_grace_and_arrives_with_its_save_point() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(permission("a1")).await;
    let started = Instant::now();

    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    let answer = waiting.await.expect("released");

    assert_eq!(answer.choice, Some(0));
    assert_eq!(
        started.elapsed(),
        GRACE,
        "§33.4: every answer waits 2 s, and a save point inside the budget adds nothing to it"
    );
    assert_eq!(h.inbox.state(id).await, Some(CardState::Released));

    let request = h
        .engine
        .calls()
        .pop()
        .expect("§33.4: a save point at release");
    assert_eq!(request.trigger, "inbox-answer");
    assert_eq!(request.note, id.to_string(), "step 3: note = the card id");
    assert_eq!(request.agent_id, "a1");
    assert_eq!(
        h.rows.last(store::RELEASED).unwrap()[3],
        serde_json::json!("sp-1"),
        "the save point id is on the row Undo will read"
    );
    assert!(h.events().contains(&Event::Release(InboxRelease {
        card_id: id.to_string(),
        savepoint_id: Some("sp-1".into()),
    })));
}

#[tokio::test(start_paused = true)]
async fn a_save_point_slower_than_300ms_still_releases_and_the_id_is_attached_late() {
    let mut h = H::slow(); // the engine takes 1 s; the budget is 300 ms
    let (id, waiting) = h.inbox.create(question("a1")).await;
    let started = Instant::now();

    h.inbox
        .answer(id, text(id, "use ISO 8601", Via::Voice))
        .await;
    let answer = waiting.await.expect("released anyway");

    assert_eq!(answer.text.as_deref(), Some("use ISO 8601"));
    assert_eq!(
        started.elapsed(),
        GRACE + BUDGET,
        "step 3: at most 300 ms waiting for the save point, then release anyway"
    );
    assert_eq!(
        h.rows.last(store::RELEASED).unwrap()[3],
        serde_json::Value::Null,
        "released with no save point id yet"
    );
    assert!(
        h.events().contains(&Event::Release(InboxRelease {
            card_id: id.to_string(),
            savepoint_id: None,
        })),
        "the app is told the answer went out, with no id yet"
    );

    settle(Duration::from_secs(2)).await; // the engine finishes at 1 s after it was asked
    assert_eq!(
        h.rows.last(store::SAVEPOINT_LATE).unwrap()[1],
        serde_json::json!("sp-late"),
        "step 3: attach the save point id when it arrives"
    );
    assert!(
        h.events().contains(&Event::Release(InboxRelease {
            card_id: id.to_string(),
            savepoint_id: Some("sp-late".into()),
        })),
        "and the app is told again, now with the id, so Undo has something to restore to"
    );
    assert_eq!(
        h.inbox.state(id).await,
        Some(CardState::Released),
        "a late save point does not change the state"
    );
    assert_eq!(
        h.inbox.undo(id).await.and_then(|u| u.savepoint_id),
        Some("sp-late".into()),
        "the user's Undo gets the id that arrived late"
    );
}

#[tokio::test(start_paused = true)]
async fn an_engine_that_refuses_or_is_absent_does_not_hold_the_answer_back() {
    // §32.5 rule 7, fail open: if any Mewndo part fails, the agent carries on. The only loss is Undo on this
    // card, and the card says so by having no save point.
    let mut h = H::with(
        Config::default(),
        FakeEngine::failing(EngineError::Unavailable("v0 engine not running".into())),
    );
    let (id, waiting) = h.inbox.create(question("a1")).await;
    let started = Instant::now();

    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    assert!(waiting.await.is_ok());
    assert_eq!(
        started.elapsed(),
        GRACE,
        "a failure is not a reason to wait longer"
    );
    assert_eq!(
        h.rows.last(store::RELEASED).unwrap()[3],
        serde_json::Value::Null
    );
    assert_eq!(
        h.inbox.undo(id).await.map(|u| u.savepoint_id),
        Some(None),
        "undone, but honestly: there is no point to restore to"
    );
    let _ = h.events();
}

#[tokio::test(start_paused = true)]
async fn an_expiry_that_lands_during_the_grace_does_not_throw_the_users_answer_away() {
    // §33.9 draws expiry only out of `open`. The user has answered and the answer is 2 s from release;
    // discarding it here would be this crate deciding the user never pressed anything.
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;
    h.inbox.answer(id, choice(id, 1, Via::Key)).await;

    h.inbox.expire(id).await;
    let answer = waiting.await.expect("the answer still goes out");

    assert_eq!(answer.choice, Some(1));
    assert_eq!(h.inbox.state(id).await, Some(CardState::Released));
    assert_eq!(h.states(), vec!["open", "answering", "released"]);
    let _ = h.events();
}

// --- undo (§33.4, §33.9) --------------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn undo_only_works_on_a_released_card_and_carries_its_save_point() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;

    assert!(
        h.inbox.undo(id).await.is_none(),
        "nothing has happened after the answer yet, because there is no answer"
    );
    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    assert!(
        h.inbox.undo(id).await.is_none(),
        "and not during the grace either: Esc is the key for that"
    );

    waiting.await.unwrap();
    let undo = h.inbox.undo(id).await.expect("released -> undone");
    assert_eq!(undo.card_id, id.to_string());
    assert_eq!(
        undo.savepoint_id,
        Some("sp-1".into()),
        "§33.4: Undo means 'undo everything the agent did after this answer'"
    );
    assert_eq!(h.inbox.state(id).await, Some(CardState::Undone));
    assert_eq!(h.states(), vec!["open", "answering", "released", "undone"]);
    assert!(h.events().contains(&Event::Undo(undo)));

    assert!(
        h.inbox.undo(mewndo_inbox::CardId::new()).await.is_none(),
        "and a card the Inbox never had is not undoable"
    );
}

// --- every state change is persisted (step 4) -----------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_whole_life_of_a_card_reaches_the_database() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(question("a1")).await;
    h.inbox.answer(id, choice(id, 0, Via::Key)).await;
    h.inbox.cancel(id).await;
    h.inbox.answer(id, choice(id, 1, Via::Key)).await;
    waiting.await.unwrap();
    h.inbox.undo(id).await.unwrap();

    assert_eq!(
        h.states(),
        vec![
            "open",
            "answering",
            "open",
            "answering",
            "released",
            "undone"
        ],
        "every §33.9 transition left a row, in order"
    );
    assert_eq!(
        h.statements(),
        vec![
            store::INSERT,
            store::ANSWERED,
            store::REOPENED,
            store::ANSWERED,
            store::RELEASED,
            store::STATE,
        ]
    );
    let answered = h.rows.last(store::ANSWERED).unwrap();
    assert_eq!(
        serde_json::from_str::<mewndo_inbox::Answer>(answered[2].as_str().unwrap())
            .unwrap()
            .choice,
        Some(1),
        "the row holds the answer that was really released, not the one that was taken back"
    );
    let _ = h.events();
}

#[tokio::test(start_paused = true)]
async fn start_up_expires_the_cards_of_a_previous_run_before_anything_else() {
    // §33.10 Part D step 4: "At start-up, mark old Open cards as Expired, because their hooks are gone."
    let h = H::fast();
    assert_eq!(
        h.rows.statements().first().copied(),
        Some(store::EXPIRE_STALE),
        "the sweep is the first statement of the run, so it cannot expire a card of this run"
    );
    let (id, _waiting) = h.inbox.create(question("a1")).await;
    assert_eq!(h.inbox.state(id).await, Some(CardState::Open));
    assert_eq!(
        h.rows.statements(),
        vec![store::EXPIRE_STALE, store::INSERT]
    );
}

// --- the stack (step 5, §34.5) --------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn cards_are_ordered_by_urgency_then_time_and_the_dock_shows_three() {
    let h = H::fast();
    let mut made = Vec::new();
    // (urgency, created_at): two at the top score, one calm but newest, one urgent but oldest.
    for (urgency, created_at) in [(3.0, 100), (5.0, 200), (1.0, 900), (5.0, 300), (4.0, 150)] {
        let mut card = question("a1");
        card.urgency = urgency;
        card.created_at = created_at;
        let (id, waiting) = h.inbox.create(card).await;
        made.push((id, urgency, created_at, waiting));
    }

    let stack = h.inbox.stack(TOP).await;
    assert_eq!(
        stack
            .cards
            .iter()
            .map(|c| (c.urgency, c.created_at))
            .collect::<Vec<_>>(),
        vec![(5.0, 300), (5.0, 200), (4.0, 150)],
        "urgency first (§34.5), then newest first (§33.1 draws the stack newest on top)"
    );
    assert_eq!(stack.more, 2, "§33.1's '+4 more'");

    // A card being answered is still on screen -- its bar is draining and Esc still works on it. A released
    // one is not: it is the agent's problem now.
    let (top, ..) = made[1];
    h.inbox.answer(top, choice(top, 0, Via::Key)).await;
    assert_eq!(h.inbox.stack(TOP).await.cards.len(), 3);
    assert!(h.inbox.stack(99).await.cards.iter().any(|c| c.id == top));

    settle(GRACE * 2).await;
    assert!(
        !h.inbox.stack(99).await.cards.iter().any(|c| c.id == top),
        "a released card leaves the stack"
    );
    assert_eq!(h.inbox.stack(99).await.cards.len(), 4);
    assert_eq!(h.inbox.stack(TOP).await.more, 1);
}

// --- habits (step 6, §34.9 R11) -------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_released_permission_answer_teaches_the_habit_counter() {
    let mut h = H::fast();
    let (id, waiting) = h.inbox.create(permission("a1")).await;

    h.inbox.answer(id, choice(id, 2, Via::Key)).await; // 3 deny (§33.2)
    assert!(
        h.habits.calls().is_empty(),
        "nothing is learned while the answer can still be taken back"
    );

    waiting.await.unwrap();
    let taught = h.habits.calls();
    assert_eq!(taught.len(), 1);
    assert_eq!(taught[0].agent_kind, "claude-code");
    assert_eq!(taught[0].project, "shop");
    assert_eq!(taught[0].action_sig, SIG);
    assert_eq!(taught[0].answer, Verdict::Deny);
    assert_eq!(taught[0].command_norm, "npm test");
    let _ = h.events();
}

#[tokio::test(start_paused = true)]
async fn an_answer_taken_back_teaches_nothing_and_neither_does_a_question() {
    let h = H::fast();

    let (permission_card, _p) = h.inbox.create(permission("a1")).await;
    h.inbox
        .answer(permission_card, choice(permission_card, 0, Via::Key))
        .await;
    h.inbox.cancel(permission_card).await;

    let (question_card, waiting) = h.inbox.create(question("a1")).await;
    h.inbox
        .answer(question_card, choice(question_card, 0, Via::Key))
        .await;
    waiting.await.unwrap();

    settle(Duration::from_secs(10)).await;
    assert!(
        h.habits.calls().is_empty(),
        "§34.7 counts the user's standing answers about actions: an Esc is not one, and a question is not \
         about an action at all"
    );
}

#[tokio::test(start_paused = true)]
async fn the_third_identical_answer_offers_the_habit_card_from_the_real_router() {
    // The real `mewndo_router::Router`, not the recording fake: this is the §34.7 card, counted by the code
    // that owns habits, reached through the Inbox's release path.
    let rows = Recording::default();
    let router = Arc::new(mewndo_router::Router::default());
    let inbox = Inbox::start(
        Config::default(),
        Deps {
            writer: Box::new(rows),
            engine: Arc::new(FakeEngine::new("sp-1", Duration::ZERO)),
            habits: Box::new(RouterHabits(router)),
        },
    );
    let mut events = inbox.subscribe();

    for _ in 0..3 {
        let (id, waiting) = inbox.create(permission("a1")).await;
        inbox.answer(id, choice(id, 0, Via::Key)).await;
        waiting.await.unwrap();
    }

    let mut offered = None;
    while let Ok(event) = events.try_recv() {
        if let Event::Habit(request) = event {
            offered = Some(request);
        }
    }
    let offered = offered.expect("§34.7: after 3 identical allows, a card asks");
    assert_eq!(offered.text, "Always allow `npm test` in shop?");
    assert_eq!(offered.answer, Verdict::Allow);
}

/// `Router` is behind an `Arc` here because one Router serves the whole device; the trait is implemented for
/// `Router` itself (src/habits.rs), so this is only the Arc hop.
struct RouterHabits(Arc<mewndo_router::Router>);

impl mewndo_inbox::HabitRecorder for RouterHabits {
    fn record(
        &self,
        agent_kind: &str,
        project: &str,
        action_sig: Sig,
        answer: Verdict,
        command_norm: &str,
    ) -> Option<mewndo_inbox::HabitRequest> {
        self.0
            .record_answer(agent_kind, project, action_sig, answer, command_norm)
    }
}
