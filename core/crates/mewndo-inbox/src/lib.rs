// The Agent Inbox (spec §33, build guide §33.10 Part D): the cards that ask the user something, the 2-second
// grace before an answer reaches the agent, and the state machine of §33.9.
//
// What it is for. An agent stops and asks: may I run this, which of these, is this what you meant. Today the
// user has to find the window the agent is in. Mewndo takes the question out of that window, shows it as a
// card next to wherever the user already is, and sends the answer back -- without ever being the reason an
// agent is stuck.
//
// The two rules everything here is built around:
//
//   1. **A card never releases an answer the user took back.** Every answer waits 2 s (§33.4) and Esc during
//      that time cancels it. "Cancels" has to mean cancels: not "usually", not "unless the save point was
//      already being written". The actor in inbox.rs checks, at the moment of sending, that the answer it is
//      about to release is still the one the card is holding.
//   2. **Nobody is blocked forever** (§33.9). The hook on the other side of a card waits on a
//      `oneshot::Receiver`. Every path that makes a card unanswerable drops the matching sender, so the wait
//      ends with an error the same instant -- and the agent falls back to its own terminal prompt. The card's
//      own deadline (300 s for permissions) does this without the hook having to call back, and so does the
//      Inbox shutting down.
//
// Shape: one actor task owns every card and takes commands over an `mpsc` (§33.10 Part D step 2), so there are
// no locks and no two-writer races. The slow parts -- the 2 s grace, the 300 ms save point -- happen in
// spawned tasks that own nothing and may only *ask* the actor to act.
//
// What it does not do, honestly (§28.10, §32.5 rule 5):
//
//   - **No save points of its own.** The release save point (§33.4) comes from the v0 engine through the
//     `EngineClient` trait (engine.rs). That wrapper -- mewndo-core's `engine_client.rs` -- does not exist
//     yet, so a build with nothing wired up releases answers with no save point id, and Undo on those cards
//     has nothing to restore to. There is no HTTP client here and guessing the v0 endpoints is exactly what
//     §32.5 rule 6 forbids.
//   - **No restore.** `undo` moves the card to `undone` and hands back the save point id; running the
//     restore plan is v0's job, through the core.
//   - **No database.** Every state change is queued to the `CardWriter` trait (store.rs), which mirrors
//     mewndo-core's batched writer task. Nothing here reads from SQLite, and nothing needs to: §33.10 Part D
//     step 4's start-up sweep is one blind UPDATE.
//   - **No triage call.** The urgency that orders the stack (§34.5) is taken from the Router's answer by
//     whoever builds the card (`Card::triaged`); this crate does not make the call.
//   - **No rules written.** A third identical answer makes the Router offer §34.7's habit card, which is
//     broadcast as `Event::Habit` and nothing more. Accepting one writes the user's `rules.toml`, which is
//     the core's path (habits.rs says why).
//   - **No keys, no focus, no window.** §33.3's answer mode and the dock are Part E, in the Electron app.
//     This crate is told "the user chose option 1"; it has no idea how.

pub mod card;
pub mod engine;
pub mod habits;
pub mod inbox;
pub mod store;

// The names a caller needs without having to know which module they live in.
pub use card::{Answer, Card, CardId, CardKind, CardState, Opt, PermissionFacts, choice, text};
pub use engine::{EngineClient, EngineError, NoEngine, SavepointRequest, TRIGGER};
pub use habits::{HabitRecorder, NoHabits};
pub use inbox::{Config, Deps, Event, Inbox, Stack, TOP};
pub use store::{CardWriter, NoStore};

// Re-exported so a caller does not need a direct dependency on mewndo-router just to read an Inbox type:
// `Verdict` is what an option teaches the habit counter, `Sig` is the action signature a permission card
// carries, and `HabitRequest` is what `Event::Habit` hands over.
pub use mewndo_router::habits::HabitRequest;
pub use mewndo_router::{Sig, Verdict};
