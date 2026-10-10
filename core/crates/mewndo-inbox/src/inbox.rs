// The Inbox actor: one task owns every card (spec §33.10 Part D step 2), and the 2-second grace (§33.4,
// step 3) is enforced here.
//
// Two promises everything below is shaped around. They are the reason this file is an actor and not a
// `Mutex<HashMap>`, and the reason the grace is a generation counter and not a cancellable timer handle:
//
//   1. A card never releases an answer the user took back. Esc during the grace (§33.4) must win, and it must
//      win even when it arrives in the same instant as the release. The actor processes commands one at a
//      time, in arrival order, so "the Esc got there first" is a fact about a queue rather than a race
//      between two threads; and the release re-checks, at the moment it would send, that the answer it is
//      about to release is still the one the card is waiting on.
//   2. Nobody is blocked forever (§33.9). The hook waits on a `oneshot::Receiver`. Every path that makes a
//      card unanswerable -- expiry, the hook's own deadline, the Inbox shutting down -- drops the matching
//      sender, which wakes the waiter at once with an error. That error is the agent's cue to fall back to
//      its own prompt, and it cannot be forgotten: it is what *dropping* means, not something a handler has
//      to remember to send.
//
// Why no locks, concretely: the grace needs a timer per answer, the save point needs a network-ish call with
// a 300 ms budget, and both must be able to be overtaken by an Esc. Done with a shared lock, the Esc path
// would have to take the same lock a 300 ms engine call was holding, or the call would have to be made without
// it and then race. With an actor, the slow work happens in a spawned task that owns nothing, and the only
// thing it may do when it finishes is *ask* the actor to release -- which the actor refuses if the user has
// since pressed Esc.
//
// §33.9's table, and what implements each row:
//
//   open      | the user answers        | answering (2 s grace)   `Command::Answer`   -> `answer`
//   answering | Esc                     | open                    `Command::Cancel`   -> `cancel`
//   answering | grace ends              | released                `GraceElapsed` + `Release` -> `release`
//   open      | hook timeout / terminal | expired                 `Command::Expire`   -> `expire`
//   released  | Undo                    | undone                  `Command::Undo`     -> `undo`
//
// There is no other edge, and every command that would make one is dropped.

use crate::card::{Answer, Card, CardId, CardKind, CardState, cmp_stack, now_ms};
use crate::engine::{EngineClient, NoEngine, SavepointRequest, TRIGGER};
use crate::habits::{HabitRecorder, NoHabits};
use crate::store::{self, CardWriter, NoStore};
use mewndo_proto::{InboxCard, InboxRelease, InboxUndo};
use mewndo_router::habits::HabitRequest;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{Instant, timeout};

/// §33.1: "At most 3 are visible; the rest collapse into '+4 more'."
pub const TOP: usize = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// §33.4: "Every answer waits 2 s, shown as a draining bar, before it is released to the agent."
    pub grace: Duration,
    /// §33.10 Part D step 3: the save point is waited for "at most 300 ms; if it's slower, release anyway".
    /// The user has already waited 2 s; making them wait on the engine as well would turn a storage hiccup
    /// into a visible stall in the one interaction that has to feel instant.
    pub savepoint_budget: Duration,
    /// How long a late save point is still worth waiting for, after the answer has already gone out.
    ///
    /// This is not in the spec; it is the "never block forever" rule applied to Mewndo's own insides. The
    /// late wait holds a task and a channel sender open, so an engine that hangs for ever would leak one of
    /// each per answer and keep the actor alive after shutdown. 30 s is far past any real save point and far
    /// short of a leak.
    pub savepoint_late_cap: Duration,
    /// The hook timeout to assume when a card does not carry its own (§33.9: 300 s for permissions). None
    /// means a card with no deadline of its own waits until something expires it -- which is a decision only
    /// the core should make, so it is expressible but not the default.
    pub default_deadline: Option<Duration>,
    /// Command queue depth. The hook path does `create` and then waits, so depth only matters when a burst
    /// of agents all ask at once; 256 is more cards than §33.1 could ever show.
    pub queue: usize,
    /// `inbox.*` event buffer. A subscriber that falls this far behind loses the oldest events, which is the
    /// right trade for a UI feed: the card list is re-read from `stack`, never rebuilt from the stream.
    pub events: usize,
    /// How many finished cards to keep in memory. They are kept at all because Undo (§33.4) arrives minutes
    /// after a release and needs the save point id; they are dropped eventually because an always-on service
    /// cannot grow for ever. Waiting cards are never dropped -- their deadline does that.
    pub keep_finished: usize,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            grace: Duration::from_secs(2),
            savepoint_budget: Duration::from_millis(300),
            savepoint_late_cap: Duration::from_secs(30),
            default_deadline: Some(Duration::from_secs(300)),
            queue: 256,
            events: 256,
            keep_finished: 500,
        }
    }
}

/// The three things the Inbox cannot do itself. All three default to doing nothing, which keeps the Inbox
/// usable -- and honest -- in a build where the engine, the database or the Router is not wired up yet.
pub struct Deps {
    /// Persists every state change (§33.10 Part D step 4). Owned by the actor; nothing else writes cards.
    pub writer: Box<dyn CardWriter>,
    /// Writes the release save point (§33.4). An `Arc` because the release task is spawned: the actor must
    /// not sit inside a 300 ms call.
    pub engine: Arc<dyn EngineClient>,
    /// §34.9 R11's habit counter, called on release.
    pub habits: Box<dyn HabitRecorder>,
}

impl Default for Deps {
    fn default() -> Deps {
        Deps {
            writer: Box::new(NoStore),
            engine: Arc::new(NoEngine),
            habits: Box::new(NoHabits),
        }
    }
}

/// What the Inbox tells the rest of the process. `Card`, `Release` and `Undo` are §38.5 messages and the core
/// forwards them to the app as they are; the other two are in-process only and have no wire form, so the core
/// must not invent one for them (§32.5 rule 1).
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// §38.5 `inbox.card`.
    Card(InboxCard),
    /// §38.5 `inbox.release`. Sent again, with the id filled in, if the save point arrived after the answer
    /// did (§33.10 Part D step 3). A second release for the same card is that and only that.
    Release(InboxRelease),
    /// §38.5 `inbox.undo`, carrying the save point to restore to.
    Undo(InboxUndo),
    /// Esc during the grace: the card is open again (§33.9). In-process: the app re-reads the stack.
    Reopened(String),
    /// The card can no longer be answered. In-process: §38.5 has no message for it, and the agent has
    /// already fallen back to its own prompt by the time it is sent.
    Expired(String),
    /// §34.7's "Always allow `npm test` in shop?" card, offered by the Router on the third identical answer.
    /// Accepting it writes a rule, which is the core's job -- see src/habits.rs.
    Habit(HabitRequest),
}

/// What the dock shows: the top cards, and how many more there are (§33.1's "+4 more").
#[derive(Debug, Clone, PartialEq)]
pub struct Stack {
    pub cards: Vec<Card>,
    pub more: usize,
}

// The Card is boxed: every queued command would otherwise be as big as the largest variant, and
// Create is far bigger than Answer or Cancel. The mpsc holds one allocation per pending command
// either way, so boxing costs nothing and keeps the queue small.
enum Command {
    Create {
        card: Box<Card>,
        waiting: oneshot::Sender<Answer>,
    },
    Answer {
        id: CardId,
        answer: Answer,
    },
    Cancel {
        id: CardId,
    },
    Expire {
        id: CardId,
    },
    Undo {
        id: CardId,
        reply: oneshot::Sender<Option<InboxUndo>>,
    },
    /// The 2 s grace is up for the answer of generation `generation`.
    GraceElapsed {
        id: CardId,
        generation: u64,
    },
    /// The save point call finished, or ran out of its 300 ms budget. Either way: release.
    Release {
        id: CardId,
        generation: u64,
        savepoint: Option<String>,
    },
    /// The save point arrived after the release (§33.10 Part D step 3).
    SavepointLate {
        id: CardId,
        generation: u64,
        savepoint: String,
    },
    State {
        id: CardId,
        reply: oneshot::Sender<Option<CardState>>,
    },
    Stack {
        n: usize,
        reply: oneshot::Sender<Stack>,
    },
}

/// The handle. Cheap to clone, and every clone talks to the one actor.
#[derive(Clone)]
pub struct Inbox {
    tx: mpsc::Sender<Command>,
    events: broadcast::Sender<Event>,
    grace: Duration,
}

impl Inbox {
    /// Start the actor. Returns at once; the one blocking thing it does first is queue §33.10 Part D step 4's
    /// start-up sweep, which marks every card left over from a previous run as expired.
    pub fn start(config: Config, deps: Deps) -> Inbox {
        // The sweep is queued before the actor runs, so it cannot be reordered after the first card of this
        // run: the writer commits in arrival order, and a sweep that landed later would expire a live card.
        deps.writer.write(store::EXPIRE_STALE, vec![]);

        let (tx, rx) = mpsc::channel(config.queue);
        let (events, _) = broadcast::channel(config.events);
        let grace = config.grace;
        let actor = Actor {
            cards: HashMap::new(),
            // A weak sender, so the channel still closes when the last handle is dropped. With a strong
            // clone here, `rx.recv()` would never return None, the actor task would outlive the Inbox for
            // ever, and the cards it holds -- and every hook waiting on one -- would never be woken.
            weak: tx.downgrade(),
            events: events.clone(),
            config,
            deps,
        };
        tokio::spawn(actor.run(rx));
        Inbox { tx, events, grace }
    }

    /// `inbox.card`, `inbox.release`, `inbox.undo` and the two in-process events.
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// The grace this Inbox was built with, for the UI's draining bar and for `grace_ms` on the wire.
    pub fn grace(&self) -> Duration {
        self.grace
    }

    /// §33.10 Part D step 2: `create(card) -> (CardId, oneshot::Receiver<Answer>)`.
    ///
    /// The receiver is the hook's side of the card: it resolves with the user's answer when the grace ends,
    /// and it *errors* the moment the card can no longer be answered. There is no third outcome and no way
    /// for it to simply never finish, which is §33.9's "nobody is blocked forever" in the type.
    pub async fn create(&self, card: Card) -> (CardId, oneshot::Receiver<Answer>) {
        let id = card.id;
        let (waiting, answer) = oneshot::channel();
        // If the actor has gone, `waiting` is dropped here along with the command, and the caller's receiver
        // errors on its very next await. A hook must never block on an Inbox that is not there.
        let _ = self
            .tx
            .send(Command::Create {
                card: Box::new(card),
                waiting,
            })
            .await;
        (id, answer)
    }

    /// The user answered (§33.9: open -> answering). A second answer while the grace is running is ignored,
    /// and so is an answer to a card that is already released, expired or undone.
    pub async fn answer(&self, id: CardId, answer: Answer) {
        let _ = self.tx.send(Command::Answer { id, answer }).await;
    }

    /// Esc during the grace (§33.9: answering -> open). Ignored in every other state: after the release
    /// there is nothing to take back with a key press, and Undo (§33.4) is the thing that undoes it.
    pub async fn cancel(&self, id: CardId) {
        let _ = self.tx.send(Command::Cancel { id }).await;
    }

    /// The hook timed out, or the user answered in the terminal (§33.9: open -> expired).
    pub async fn expire(&self, id: CardId) {
        let _ = self.tx.send(Command::Expire { id }).await;
    }

    /// Undo on a released card (§33.9: released -> undone). Returns the `inbox.undo` body, whose
    /// `savepoint_id` is the release save point the restore plan runs back to (§33.4); None if the card was
    /// not in `released`, which is the only state Undo has a meaning in.
    pub async fn undo(&self, id: CardId) -> Option<InboxUndo> {
        let (reply, answer) = oneshot::channel();
        self.tx.send(Command::Undo { id, reply }).await.ok()?;
        answer.await.ok().flatten()
    }

    /// The card's state, or None if the Inbox has never heard of it -- or has already forgotten it, which it
    /// only does to finished cards (`Config::keep_finished`).
    pub async fn state(&self, id: CardId) -> Option<CardState> {
        let (reply, answer) = oneshot::channel();
        self.tx.send(Command::State { id, reply }).await.ok()?;
        answer.await.ok().flatten()
    }

    /// §33.10 Part D step 5: the cards still waiting for the user, ordered by urgency then time, and how many
    /// did not fit. Pass [`TOP`] for what the dock shows.
    pub async fn stack(&self, n: usize) -> Stack {
        let (reply, answer) = oneshot::channel();
        if self.tx.send(Command::Stack { n, reply }).await.is_err() {
            return Stack {
                cards: Vec::new(),
                more: 0,
            };
        }
        answer.await.unwrap_or(Stack {
            cards: Vec::new(),
            more: 0,
        })
    }
}

/// One card as the actor holds it: the card itself, plus the things that must not be visible to anyone else.
struct Entry {
    card: Card,
    /// The hook waiting for this card. `None` once the answer has been handed over, or once the card can
    /// never be answered -- and dropping it is what wakes the hook (§33.9).
    waiting: Option<oneshot::Sender<Answer>>,
    /// Bumped by every answer and every cancel. A grace timer, a release or a late save point that quotes an
    /// older generation belongs to an answer that has since been taken back, and is dropped.
    ///
    /// This is deliberately a counter and not an `AbortHandle` on the timer task. Aborting is a request that
    /// can lose: the timer may already have put `GraceElapsed` in the queue, and abort cannot un-send a
    /// message. A generation is checked at the moment of use, by the one task that owns the truth, so there
    /// is no window in which a stale release can slip through.
    generation: u64,
    /// What the user chose, held through the grace. Cleared by Esc, so there is nothing left to release.
    answer: Option<Answer>,
    /// The release save point (§33.4), for Undo. `None` when the engine was too slow, said no, or is absent.
    savepoint: Option<String>,
}

struct Actor {
    cards: HashMap<CardId, Entry>,
    weak: mpsc::WeakSender<Command>,
    events: broadcast::Sender<Event>,
    config: Config,
    deps: Deps,
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::Receiver<Command>) {
        while let Some(command) = rx.recv().await {
            match command {
                Command::Create { card, waiting } => self.create(*card, waiting),
                Command::Answer { id, answer } => self.answer(id, answer),
                Command::Cancel { id } => self.cancel(id),
                Command::Expire { id } => self.expire(id),
                Command::Undo { id, reply } => {
                    let undo = self.undo(id);
                    let _ = reply.send(undo);
                }
                Command::GraceElapsed { id, generation } => self.grace_elapsed(id, generation),
                Command::Release {
                    id,
                    generation,
                    savepoint,
                } => self.release(id, generation, savepoint),
                Command::SavepointLate {
                    id,
                    generation,
                    savepoint,
                } => self.savepoint_late(id, generation, savepoint),
                Command::State { id, reply } => {
                    let _ = reply.send(self.cards.get(&id).map(|e| e.card.state));
                }
                Command::Stack { n, reply } => {
                    let _ = reply.send(self.stack(n));
                }
            }
        }
        // The last handle is gone: the core is shutting down. Every `waiting` sender drops with `self.cards`,
        // so every hook still holding a receiver wakes with an error and falls back to its own prompt
        // (§33.9) instead of waiting out its 300 s timeout against a service that no longer exists.
    }

    fn create(&mut self, card: Card, waiting: oneshot::Sender<Answer>) {
        let id = card.id;
        self.deps.writer.write(store::INSERT, store::insert(&card));
        let _ = self
            .events
            .send(Event::Card(card.to_proto(self.config.grace)));

        // The card's own deadline, or the Inbox's default (§33.9: 300 s for permissions). This timer is the
        // half of "nobody is blocked forever" that does not trust the other side to call back: if the hook
        // process is killed, nothing will ever call `expire`, and without this the card would sit open until
        // the core restarted.
        if let Some(after) = card.deadline.or(self.config.default_deadline) {
            self.later(after, Command::Expire { id });
        }
        self.cards.insert(
            id,
            Entry {
                card,
                waiting: Some(waiting),
                generation: 0,
                answer: None,
                savepoint: None,
            },
        );
    }

    /// open -> answering, and start the grace.
    fn answer(&mut self, id: CardId, answer: Answer) {
        let grace = self.config.grace;
        let Some(entry) = self.cards.get_mut(&id) else {
            return;
        };
        // "A second answer is ignored" (§33.10 Part D, "Done when"). Not "restarts the grace" and not
        // "replaces the first": the user pressing 1 then 3 within two seconds is as likely to be a slip as a
        // change of mind, and the only unambiguous reading of the §33.9 table is that `answering` has no
        // incoming answer edge. Esc, then answer again, says it clearly -- and costs the user 2 s.
        if !matches!(entry.card.state, CardState::Open) {
            return;
        }
        // An answer addressed to another card is never applied to this one. Everything else here can be
        // taken back with Esc; releasing the wrong card's answer cannot.
        if !answer.card_id.is_empty() && answer.card_id != id.to_string() {
            return;
        }

        entry.generation += 1;
        let generation = entry.generation;
        entry.card.state = CardState::Answering {
            until: Instant::now() + grace,
        };
        entry.answer = Some(answer.clone());
        self.deps.writer.write(
            store::ANSWERED,
            store::answered(&entry.card, &answer, now_ms()),
        );
        self.later(grace, Command::GraceElapsed { id, generation });
    }

    /// answering -> open: Esc (§33.4). The whole of "a card never releases an answer the user took back" is
    /// these three lines plus the generation check in `release`.
    fn cancel(&mut self, id: CardId) {
        let Some(entry) = self.cards.get_mut(&id) else {
            return;
        };
        if !matches!(entry.card.state, CardState::Answering { .. }) {
            return;
        }
        // Bumping the generation first invalidates the grace timer and any save-point call already in
        // flight, so neither can come back and release this answer.
        entry.generation += 1;
        entry.card.state = CardState::Open;
        entry.answer = None;
        self.deps
            .writer
            .write(store::REOPENED, store::reopened(&entry.card));
        let _ = self.events.send(Event::Reopened(id.to_string()));
    }

    /// open -> expired: the hook timed out (300 s for permissions, §33.9), the user answered in the terminal,
    /// or this card's deadline came round.
    fn expire(&mut self, id: CardId) {
        let Some(entry) = self.cards.get_mut(&id) else {
            return;
        };
        // Only from `open`, which is the only edge §33.9 draws. In particular an expiry that lands while the
        // grace is draining is dropped: the user has already answered, the answer is 2 s from release, and
        // throwing away an answer they did give is not better than releasing it to an agent that may have
        // stopped listening. The release handles that case honestly -- it finds no receiver and says so.
        if !matches!(entry.card.state, CardState::Open) {
            return;
        }
        entry.card.state = CardState::Expired;
        // Dropping the sender wakes the hook *now* with an error, which is its cue to fall back to its own
        // prompt (§33.9). It is also what the 300 s deadline timer exists to reach.
        entry.waiting = None;
        self.deps
            .writer
            .write(store::STATE, store::state(&entry.card));
        let _ = self.events.send(Event::Expired(id.to_string()));
        self.prune();
    }

    /// The grace ran out. Ask the engine for the save point, with the 300 ms budget (§33.10 Part D step 3).
    fn grace_elapsed(&mut self, id: CardId, generation: u64) {
        let Some(entry) = self.cards.get(&id) else {
            return;
        };
        // Esc won: this timer belongs to an answer that no longer exists.
        if entry.generation != generation
            || !matches!(entry.card.state, CardState::Answering { .. })
        {
            return;
        }
        let agent_id = entry.card.agent_id.clone();
        let Some(tx) = self.weak.upgrade() else {
            return;
        };
        let engine = Arc::clone(&self.deps.engine);
        let budget = self.config.savepoint_budget;
        let late_cap = self.config.savepoint_late_cap;
        let note = id.to_string();
        // Spawned, not awaited: the actor must stay free to receive an Esc while this is in flight. The card
        // stays in `answering` until the release lands, so Esc still works during these 300 ms too -- a
        // wider window than §33.4 promises, and wider in the only safe direction.
        tokio::spawn(async move {
            let request = SavepointRequest {
                trigger: TRIGGER,
                note,
                agent_id,
                cwd: None,
            };
            let mut pending = engine.savepoint(request);
            let (savepoint, still_running) = match timeout(budget, &mut pending).await {
                // Either an id, or the engine saying no. A refusal is not a reason to hold the user's answer
                // back (§32.5 rule 7): the answer goes out, and the card simply has no Undo point.
                Ok(result) => (result.ok(), false),
                Err(_) => (None, true),
            };
            let _ = tx
                .send(Command::Release {
                    id,
                    generation,
                    savepoint,
                })
                .await;
            if still_running {
                // "Release anyway and attach the save point id when it arrives" (step 3). The future is kept
                // alive rather than dropped, because dropping it here would cancel the very save point the
                // user's Undo needs. The cap stops a hung engine keeping this task -- and the actor -- alive.
                if let Ok(Ok(savepoint)) = timeout(late_cap, pending).await {
                    let _ = tx
                        .send(Command::SavepointLate {
                            id,
                            generation,
                            savepoint,
                        })
                        .await;
                }
            }
        });
    }

    /// answering -> released: send the answer to the agent, write the state, broadcast `inbox.release`, and
    /// teach the habit counter (§33.10 Part D steps 3 and 6).
    fn release(&mut self, id: CardId, generation: u64, savepoint: Option<String>) {
        let Some(entry) = self.cards.get_mut(&id) else {
            return;
        };
        // The last line of defence for promise 1, and the reason the save-point call can be slow without
        // being dangerous: between the grace ending and this moment the user may have pressed Esc, and if
        // they did, the generation no longer matches and nothing is sent. A save point written for an answer
        // that was taken back is left behind on purpose -- it is a version of the user's files and harms
        // nothing, whereas releasing the answer would hand an agent a decision the user reversed.
        if entry.generation != generation
            || !matches!(entry.card.state, CardState::Answering { .. })
        {
            return;
        }
        let Some(answer) = entry.answer.clone() else {
            return;
        };

        entry.card.state = CardState::Released;
        entry.savepoint = savepoint.clone();
        // The hook may have given up and gone (its 300 s, or the user answered in the terminal). The answer
        // is still released: the save point exists, Undo still works, and §33.9 says the card then shows
        // "answered in terminal" when `PostToolUse` arrives. What must not happen is the Inbox pretending
        // the answer never happened.
        if let Some(waiting) = entry.waiting.take() {
            let _ = waiting.send(answer.clone());
        }
        self.deps.writer.write(
            store::RELEASED,
            store::released(&entry.card, now_ms(), savepoint.as_ref()),
        );
        let _ = self.events.send(Event::Release(InboxRelease {
            card_id: id.to_string(),
            savepoint_id: savepoint,
        }));

        // §34.9 R11, and only now: a habit is the user's own standing answer, so it may only be learned from
        // an answer that was actually released. An Esc'd answer teaches nothing, which is why this call is
        // here and not in `answer`.
        let card = &entry.card;
        if card.kind == CardKind::Permission
            && let Some(facts) = &card.permission
            && let Some(verdict) = card.taught_by(&answer)
            && let Some(offer) = self.deps.habits.record(
                &facts.agent_kind,
                &facts.project,
                facts.action_sig,
                verdict,
                &facts.command_norm,
            )
        {
            let _ = self.events.send(Event::Habit(offer));
        }
        self.prune();
    }

    /// The save point arrived after the answer did (§33.10 Part D step 3).
    fn savepoint_late(&mut self, id: CardId, generation: u64, savepoint: String) {
        let Some(entry) = self.cards.get_mut(&id) else {
            return;
        };
        // The generation still has to match: if the release was refused because of an Esc, this id belongs to
        // a save point for an answer that never went out, and attaching it to the card would offer the user
        // an Undo for something that never happened.
        if entry.generation != generation || entry.card.state != CardState::Released {
            return;
        }
        entry.savepoint = Some(savepoint.clone());
        self.deps.writer.write(
            store::SAVEPOINT_LATE,
            store::savepoint_late(&entry.card, &savepoint),
        );
        // The same `inbox.release`, now with the id. The app's handler only records the save point for Undo,
        // so a repeat is harmless; a new message type for "the id you did not get" would have to go through
        // §38.5 and both sides (§32.5 rule 1).
        let _ = self.events.send(Event::Release(InboxRelease {
            card_id: id.to_string(),
            savepoint_id: Some(savepoint),
        }));
    }

    /// released -> undone (§33.9). The Inbox only moves the card and hands back the save point: the restore
    /// itself is v0's, through the core (§32.5 rule 6).
    fn undo(&mut self, id: CardId) -> Option<InboxUndo> {
        let entry = self.cards.get_mut(&id)?;
        // Undo means "undo everything the agent did after this answer" (§33.4). Before the release there is
        // nothing after the answer, and a card can only be undone once.
        if entry.card.state != CardState::Released {
            return None;
        }
        entry.card.state = CardState::Undone;
        let undo = InboxUndo {
            card_id: id.to_string(),
            savepoint_id: entry.savepoint.clone(),
        };
        self.deps
            .writer
            .write(store::STATE, store::state(&entry.card));
        let _ = self.events.send(Event::Undo(undo.clone()));
        Some(undo)
    }

    /// §33.10 Part D step 5. Only cards the user can still act on: a released or expired card is not in the
    /// stack, and `more` is what §33.1's "+4 more" counts.
    fn stack(&self, n: usize) -> Stack {
        let mut waiting: Vec<Card> = self
            .cards
            .values()
            .filter(|e| e.card.state.waiting())
            .map(|e| e.card.clone())
            .collect();
        waiting.sort_by(cmp_stack);
        let more = waiting.len().saturating_sub(n);
        waiting.truncate(n);
        Stack {
            cards: waiting,
            more,
        }
    }

    /// Send `command` to ourselves after `delay`.
    ///
    /// The timer holds a strong sender for as long as it is pending, which is what makes a release that is
    /// already under way finish even if the core drops its last handle in the middle of it. Upgrading can
    /// fail only when the Inbox is already gone, and then there is nothing left to time.
    fn later(&self, delay: Duration, command: Command) {
        let Some(tx) = self.weak.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = tx.send(command).await;
        });
    }

    /// Forget the oldest finished cards once there are more than `keep_finished` of them.
    ///
    /// Waiting cards are never forgotten -- that is what their deadline is for -- so this cannot drop a card
    /// a hook is still blocked on. Ulids sort by creation time, so "oldest" needs no extra field.
    fn prune(&mut self) {
        let keep = self.config.keep_finished;
        let finished = self
            .cards
            .values()
            .filter(|e| !e.card.state.waiting())
            .count();
        if finished <= keep {
            return;
        }
        let mut ids: Vec<CardId> = self
            .cards
            .iter()
            .filter(|(_, e)| !e.card.state.waiting())
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        for id in ids.into_iter().take(finished - keep) {
            self.cards.remove(&id);
        }
    }
}
