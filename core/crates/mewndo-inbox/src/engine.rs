// The save point the grace ends with (spec §33.4, §33.10 Part D step 3).
//
// §33.4: "At release, Mewndo writes a save point (trigger `inbox-answer`, agent and card id attached). From
// then on, Undo on the card means 'undo everything the agent did after this answer'." So the save point is not
// bookkeeping -- it is the line Undo restores to, and the only reason the Done card's U key can mean anything.
//
// It is a trait and not an HTTP client on purpose. §32.5 rule 6: save points, restore and verification come
// from the v0 engine, and the core reaches them through exactly one file,
// core/crates/mewndo-core/src/engine_client.rs, a thin wrapper over the v0 local server. That file does not
// exist yet, and guessing its endpoints and its token file is the mistake §32.5 rule 6 names. So this crate
// says what it needs -- one call, one id back -- and the core says how.
//
// The trait is deliberately async and boxed rather than a blocking call on a thread pool: the actor must stay
// free to receive an Esc while this is in flight, and the 300 ms budget in inbox.rs is a `tokio::time::timeout`
// around the future this returns.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

/// §33.4's trigger name. The v0 engine groups save points by trigger, so this string is what makes an
/// Inbox release findable in the timeline later; it is a const because a typo here would scatter them.
pub const TRIGGER: &str = "inbox-answer";

/// What §33.4 asks to be attached: the agent and the card id.
#[derive(Debug, Clone, PartialEq)]
pub struct SavepointRequest {
    pub trigger: &'static str,
    /// The card id. §33.10 Part D step 3: "note = card id".
    pub note: String,
    pub agent_id: String,
    /// The agent's working folder, when the caller knows it: v0 finds the protected folder from it. The Inbox's
    /// release doesn't know it; the core's engine wrapper fills it in from the agent's earlier calls.
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineError {
    /// The v0 engine is not running, or the call failed. Not a reason to hold the answer back: see
    /// `Inbox`'s release path and §32.5 rule 7.
    Unavailable(String),
    /// The engine answered and said no -- no protected folder covers this agent's work, for instance.
    Refused(String),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            EngineError::Unavailable(e) => write!(f, "the v0 engine could not be reached: {e}"),
            EngineError::Refused(e) => write!(f, "the v0 engine refused a save point: {e}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// The save point id, or why there isn't one.
pub type Pending = Pin<Box<dyn Future<Output = Result<String, EngineError>> + Send>>;

/// What the Inbox needs from the v0 engine. One method, so the core's wrapper is a few lines and so this
/// crate's tests are a few more.
pub trait EngineClient: Send + Sync + 'static {
    /// Write a save point and return its id. The implementation must have a deadline of its own (CLAUDE.md
    /// rule 3): the Inbox caps how long it *waits*, but it cannot cap how long a future it does not own runs
    /// for, so a hung engine would otherwise leave a task behind for every answer.
    fn savepoint(&self, request: SavepointRequest) -> Pending;
}

/// No engine: every call fails at once.
///
/// This is the honest default, and it is what a build with no v0 engine wired up uses. The Inbox then releases
/// answers with no save point id, which is §32.5 rule 7 exactly: the agent carries on as if Mewndo were not
/// installed. The one thing the user loses is Undo on that card, and the card says so by having no save point.
pub struct NoEngine;

impl EngineClient for NoEngine {
    fn savepoint(&self, _request: SavepointRequest) -> Pending {
        Box::pin(async {
            Err(EngineError::Unavailable(
                "no engine client is wired up".into(),
            ))
        })
    }
}

/// A fake engine for tests and for the fake agent harness (§33.10 Part A, P2.6).
///
/// Public, not `#[cfg(test)]`: the states suite in tests/ is a separate crate and can only see the public API,
/// which is the point -- it tests the Inbox the way mewndo-core will use it.
pub struct FakeEngine {
    id: String,
    /// How long the engine takes. Past the Inbox's budget this is the "the save point is slower than 300 ms"
    /// case of §33.10 Part D step 3.
    takes: std::time::Duration,
    fails: Option<EngineError>,
    calls: std::sync::Arc<std::sync::Mutex<Vec<SavepointRequest>>>,
}

impl FakeEngine {
    pub fn new(id: impl Into<String>, takes: std::time::Duration) -> FakeEngine {
        FakeEngine {
            id: id.into(),
            takes,
            fails: None,
            calls: Default::default(),
        }
    }

    pub fn failing(error: EngineError) -> FakeEngine {
        FakeEngine {
            id: String::new(),
            takes: std::time::Duration::ZERO,
            fails: Some(error),
            calls: Default::default(),
        }
    }

    /// Every request made, in order. The release path must ask once per released card, with §33.4's trigger.
    pub fn calls(&self) -> Vec<SavepointRequest> {
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl EngineClient for FakeEngine {
    fn savepoint(&self, request: SavepointRequest) -> Pending {
        self.calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(request);
        let takes = self.takes;
        let result = match &self.fails {
            Some(e) => Err(e.clone()),
            None => Ok(self.id.clone()),
        };
        Box::pin(async move {
            if !takes.is_zero() {
                tokio::time::sleep(takes).await;
            }
            result
        })
    }
}
