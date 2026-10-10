// R6 (the transport half): the Clef client (spec §34.9 R6).
//
// This crate does not speak HTTP, on purpose. §34.9 R6 asks for one `reqwest::Client` with a 90-second idle
// pool, a 30-second TCP keepalive, rustls, a `GET /health` pre-connect at start-up and another every 45
// seconds while an agent is working -- all so the TLS handshake is already paid for when the hook is
// blocked. Every one of those is about a connection that outlives any single decision, which makes it the
// core's property, not the router's: the core already owns the runtime, the settings and the invite token,
// and it is the thing that knows when "any agent is working".
//
// So the transport is this trait. The core implements it over its own warm connection; the tests implement
// it with canned answers; the stub below implements it with "no model", which is exactly what the kill
// switch and a missing token should look like. The request body, the headers and the deadline are all
// defined here so that the core's implementation has nothing to invent.

use crate::answers::{Answer, Fallback, Question, parse_answers};
use crate::{Backend, CallKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

/// The §34.3 `state`. Under 800 tokens: paths, commands, recipients and names, never whole files or emails.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub brief: String,
    pub agent: String,
    pub cwd: String,
    /// The last three actions, no more (§34.9 "Speed rules").
    pub recent: Vec<String>,
    pub action: Value,
    pub facts: Value,
}

/// One request: the state, and every question in one batch. One call per action -- never one call per
/// question, which would multiply the round trip by five.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClefRequest {
    pub state: State,
    pub questions: Vec<Question>,
    /// `x-mewndo-kind`: picks the gateway's deadline and routing order (§37.3).
    #[serde(skip)]
    pub kind: CallKind,
    /// `x-mewndo-sig`: the action signature, hex. Lets the gateway cache without reading the body.
    #[serde(skip)]
    pub sig: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClefError {
    /// The deadline passed (§34.8). The rules decide; this is normal, not an error to report to the user.
    Deadline,
    /// No token, no network, a 5xx, or the router is off.
    Unavailable(String),
    /// A response we could not read. One raw sample is kept for fixing the parser (§34.9 R6).
    Shape(Fallback),
}

/// The model transport. Blocking on purpose: the hook that calls it is already blocked waiting for an
/// answer, so an async runtime here would buy nothing and would drag `tokio` into a crate that otherwise
/// needs no runtime at all. The implementation must return by `deadline` whatever happens.
pub trait Clef {
    fn ask(
        &self,
        request: &ClefRequest,
        deadline: Duration,
    ) -> Result<(Backend, BTreeMap<String, Answer>), ClefError>;
}

/// The stub: there is no model. Every call falls back to the rules, which is what the router does when the
/// kill switch is on, when there is no invite token, and on a machine with no network. It is also what the
/// crate ships with, so nothing here can make a network call by accident.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoClef;

impl Clef for NoClef {
    fn ask(
        &self,
        _request: &ClefRequest,
        _deadline: Duration,
    ) -> Result<(Backend, BTreeMap<String, Answer>), ClefError> {
        Err(ClefError::Unavailable("no Clef client is wired up".into()))
    }
}

/// The test double: a canned response body, a pretend latency and a backend to report.
///
/// `latency` is compared against the deadline rather than slept through, so "the deadline passed" is a test
/// that runs in microseconds and is the same test every time.
#[derive(Debug, Clone)]
pub struct FakeClef {
    pub body: Value,
    pub latency: Duration,
    pub backend: Backend,
    pub calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl FakeClef {
    pub fn new(body: Value) -> FakeClef {
        FakeClef {
            body,
            latency: Duration::from_millis(40),
            backend: Backend::WorkersAi,
            calls: Default::default(),
        }
    }

    pub fn slow(mut self, latency: Duration) -> FakeClef {
        self.latency = latency;
        self
    }

    /// How many times the model was actually called. The kill-switch test asserts this is zero, which is the
    /// §34.9 "Done when" check ("with the kill switch on, the gateway log shows no model calls") done
    /// locally.
    pub fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl Clef for FakeClef {
    fn ask(
        &self,
        request: &ClefRequest,
        deadline: Duration,
    ) -> Result<(Backend, BTreeMap<String, Answer>), ClefError> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.latency > deadline {
            return Err(ClefError::Deadline);
        }
        match parse_answers(&request.questions, &self.body) {
            Ok(answers) => Ok((self.backend, answers)),
            Err(f) => Err(ClefError::Shape(f)),
        }
    }
}
