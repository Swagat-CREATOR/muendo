// Decision service client (spec §29.4). The rules in policy.rs decide every
// clear case locally; only the cases they can't decide come here, where their
// questions for one action are batched into a single request to mewndo-decide
// (P4.1). Each decision has a hard deadline, a hedge (a second identical request
// at the hedge mark, take whichever answers first), and a rule-based fallback
// the caller supplies for when the deadline passes. Every decision records
// deadline_met, fallback_used and latency, as §29.4's SLOs require.
//
// The transport is injected behind `Responder` so the deadline/hedge/fallback
// engine is tested offline and deterministically. The real HTTPS transport is
// Windows-only (uses the OS TLS stack via native-tls/SChannel, so no extra
// crypto build); other platforms always fall back, which is fine because the
// core ships on Windows and dev/CI-Linux exercise the rules path.
use crate::policy::Decision;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Who is asking: sets the deadline and whether to hedge (spec §29.4).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Caller {
    Guard,
    Send,
    Heal,
    Voice,
}

impl Caller {
    /// (deadline, hedge-after). After `hedge-after` with no answer, fire a second
    /// identical request and take whichever answers first.
    fn timing(self) -> (Duration, Option<Duration>) {
        let (deadline, hedge) = match self {
            Caller::Guard => (60, Some(25)),
            Caller::Send => (100, Some(30)),
            Caller::Heal => (200, None),
            Caller::Voice => (150, None),
        };
        (
            Duration::from_millis(deadline),
            hedge.map(Duration::from_millis),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // noul | choice | score
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DecideRequest {
    pub caller: Caller,
    pub state: serde_json::Value,
    pub questions: Vec<Question>,
    /// What the rules decide if the deadline passes (§29.4). The caller already
    /// knows the action's nature: allow harmless, deny destructive, Ask = hold.
    pub fallback: Decision,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Model,
    Rules,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decided {
    pub source: Source,
    /// Whether a model answer arrived in time. A fallback counts as a met
    /// deadline for the SLO (§29.4) but is tracked separately by fallback_used.
    pub deadline_met: bool,
    pub fallback_used: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Decision>,
}

/// One blocking POST of `payload` (a DecideRequest as JSON) to the decision
/// service, returning the JSON body. `backstop` is a hard cap; the engine
/// enforces the real per-caller deadline and abandons a slow request.
pub trait Responder: Send + Sync + 'static {
    fn ask(&self, payload: &str, backstop: Duration) -> Result<String, String>;
}

/// The decision when the service isn't configured at all: an immediate rule
/// fallback, no model call, zero latency.
pub fn immediate_fallback(req: &DecideRequest) -> Decided {
    Decided {
        source: Source::Rules,
        deadline_met: false,
        fallback_used: true,
        latency_ms: 0,
        answers: None,
        fallback: Some(req.fallback),
    }
}

/// Run one decision with the caller's deadline, hedge and fallback.
pub fn decide(responder: &Arc<dyn Responder>, req: &DecideRequest) -> Decided {
    let (deadline, hedge) = req.caller.timing();
    let payload = serde_json::to_string(req).expect("a decide request serializes");
    let start = Instant::now();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let fire = |tx: mpsc::Sender<Result<String, String>>| {
        let (responder, payload) = (responder.clone(), payload.clone());
        std::thread::spawn(move || {
            let _ = tx.send(responder.ask(&payload, deadline));
        });
    };
    fire(tx.clone());
    let mut hedged = hedge.is_none();
    loop {
        let elapsed = start.elapsed();
        if elapsed >= deadline {
            break;
        }
        // Wake at the hedge mark if we still owe a hedge, otherwise at the deadline.
        let wait = match hedge {
            Some(h) if !hedged && elapsed < h => h - elapsed,
            _ => deadline - elapsed,
        };
        match rx.recv_timeout(wait) {
            Ok(Ok(body)) => {
                return Decided {
                    source: Source::Model,
                    deadline_met: true,
                    fallback_used: false,
                    latency_ms: start.elapsed().as_millis() as u64,
                    // Pass the model's answers through; if it wasn't JSON, keep the raw string.
                    answers: Some(
                        serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!(body)),
                    ),
                    fallback: None,
                };
            }
            // One request errored; keep waiting for the other, or the deadline.
            Ok(Err(_)) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !hedged && hedge.is_some_and(|h| start.elapsed() >= h) {
                    fire(tx.clone());
                    hedged = true;
                }
            }
            // We hold `tx` for the whole call, so this never happens; break to be safe.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Deadline passed (or every request errored): the rules decide.
    Decided {
        source: Source::Rules,
        deadline_met: false,
        fallback_used: true,
        latency_ms: start.elapsed().as_millis() as u64,
        answers: None,
        fallback: Some(req.fallback),
    }
}

/// Build the real responder from the environment, or None when it isn't
/// configured (then the caller always uses its rule fallback). The token lives
/// only in the environment, never in a file (CLAUDE.md rule 4).
///   MEWNDO_DECIDE_URL   the deployed mewndo-decide Worker URL
///   MEWNDO_DECIDE_TOKEN the bearer token set with `wrangler secret put`
pub fn configured() -> Option<Arc<dyn Responder>> {
    let url = std::env::var("MEWNDO_DECIDE_URL").ok()?;
    let token = std::env::var("MEWNDO_DECIDE_TOKEN").ok()?;
    if url.is_empty() || token.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        Some(Arc::new(http::HttpResponder::new(url, token)))
    }
    // ponytail: real transport is Windows-only for now (OS SChannel, no crypto
    // build). On other platforms the decision service isn't called; the core
    // ships on Windows, so dev/CI-Linux just exercise the rules fallback.
    #[cfg(not(windows))]
    {
        let _ = (url, token);
        None
    }
}

#[cfg(windows)]
mod http {
    use super::{Duration, Responder};

    pub struct HttpResponder {
        url: String,
        token: String,
        // Built once so TLS connections pool and stay warm; a cold handshake
        // alone can blow a 60 ms deadline.
        agent: ureq::Agent,
    }

    impl HttpResponder {
        pub fn new(url: String, token: String) -> Self {
            let connector = native_tls::TlsConnector::new().expect("OS TLS (SChannel)");
            let agent = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(1)) // backstop; the engine enforces the real deadline
                .tls_connector(std::sync::Arc::new(connector))
                .build();
            Self { url, token, agent }
        }
    }

    impl Responder for HttpResponder {
        fn ask(&self, payload: &str, _backstop: Duration) -> Result<String, String> {
            let resp = self
                .agent
                .post(&self.url)
                .set("authorization", &format!("Bearer {}", self.token))
                .set("content-type", "application/json")
                .send_string(payload)
                .map_err(|e| e.to_string())?;
            resp.into_string().map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A responder scripted per call: the nth `ask` sleeps then returns the nth entry.
    struct Fake {
        calls: Mutex<Vec<(Duration, Result<String, String>)>>,
        n: AtomicUsize,
    }
    impl Fake {
        fn script(calls: Vec<(Duration, Result<String, String>)>) -> Arc<dyn Responder> {
            Arc::new(Fake {
                calls: Mutex::new(calls),
                n: AtomicUsize::new(0),
            })
        }
    }
    impl Responder for Fake {
        fn ask(&self, _payload: &str, _backstop: Duration) -> Result<String, String> {
            let i = self.n.fetch_add(1, Ordering::SeqCst);
            let (delay, res) = self.calls.lock().unwrap().get(i).cloned().unwrap_or((
                Duration::from_secs(10),
                Err("no more scripted calls".into()),
            ));
            std::thread::sleep(delay);
            res
        }
    }

    fn req(caller: Caller) -> DecideRequest {
        DecideRequest {
            caller,
            state: serde_json::json!({"brief": "x"}),
            questions: vec![Question {
                id: "a".into(),
                kind: "noul".into(),
                text: "ok?".into(),
                choices: vec![],
            }],
            fallback: Decision::Deny,
        }
    }

    #[test]
    fn model_answer_within_deadline_is_used() {
        let r = Fake::script(vec![(
            Duration::from_millis(10),
            Ok(r#"{"answers":[{"id":"a","prob":0.9}]}"#.into()),
        )]);
        let d = decide(&r, &req(Caller::Guard));
        assert_eq!(d.source, Source::Model);
        assert!(d.deadline_met && !d.fallback_used);
        assert!(d.answers.is_some() && d.fallback.is_none());
        assert!(d.latency_ms < 60, "latency {} ms", d.latency_ms);
    }

    #[test]
    fn hedge_second_request_wins_when_the_first_is_slow() {
        // First request stalls past the deadline; the hedge (fired at 25 ms) is quick.
        let r = Fake::script(vec![
            (Duration::from_millis(500), Ok("{}".into())),
            (Duration::from_millis(5), Ok(r#"{"answers":[]}"#.into())),
        ]);
        let d = decide(&r, &req(Caller::Guard));
        assert_eq!(d.source, Source::Model, "hedge should have answered");
        assert!(d.deadline_met && !d.fallback_used);
    }

    #[test]
    fn deadline_passing_falls_back_to_the_rules() {
        let r = Fake::script(vec![
            (Duration::from_millis(500), Ok("{}".into())),
            (Duration::from_millis(500), Ok("{}".into())),
        ]);
        let mut request = req(Caller::Send);
        request.fallback = Decision::Ask; // a send fallback is a hold
        let d = decide(&r, &request);
        assert_eq!(d.source, Source::Rules);
        assert!(!d.deadline_met && d.fallback_used);
        assert_eq!(d.fallback, Some(Decision::Ask));
        assert!(d.answers.is_none());
        assert!(
            d.latency_ms >= 100 && d.latency_ms < 300,
            "latency {} ms",
            d.latency_ms
        );
    }

    #[test]
    fn an_erroring_request_falls_back() {
        // No hedge for Heal; the one request errors, so we fall back at the deadline.
        let r = Fake::script(vec![(Duration::from_millis(5), Err("boom".into()))]);
        let d = decide(&r, &req(Caller::Heal));
        assert_eq!(d.source, Source::Rules);
        assert!(d.fallback_used);
    }
}
