// The core's Clef transport (spec §34.9 R6): `POST /v1/decide` to the gateway Worker (cloud/gateway).
//
// mewndo-router defines the request, the headers and the reply reader (`clef::read_reply`); this file only moves
// bytes. The rules are always the answer when anything goes wrong (CLAUDE.md rule 3): a missing token, no
// network, a 4xx/5xx, an unreadable body and a passed deadline all come back as a `ClefError`, and the router
// falls back to its rules on every one of them.
//
// The HTTP itself is behind `Transport`, so the logic here is tested on every target with a fake. The real
// transport is Windows-only (ureq over SChannel, like decide.rs), because this is where the core ships and the
// WSL box has no OpenSSL headers. The device token lives in Windows Credential Manager, never in a file
// (CLAUDE.md rule 4); off Windows `configured()` is always None and the router uses its rules.

// Off Windows only the tests construct a client (configured() is always None there).
#![cfg_attr(not(windows), allow(dead_code))]

use mewndo_router::Backend;
use mewndo_router::answers::Answer;
use mewndo_router::clef::{Clef, ClefError, ClefRequest, read_reply};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// The Credential Manager entry that holds the gateway device token (a Generic credential).
pub const TOKEN_TARGET: &str = "Mewndo/gateway-device-token";

/// How often the warm connection is refreshed with `GET /health` (§34.9 R6: every 45 seconds).
pub const WARM_EVERY: Duration = Duration::from_secs(45);

#[derive(Debug, PartialEq)]
pub enum TransportError {
    /// The deadline passed before a reply came.
    Timeout,
    /// No connection, TLS failure, a reset: anything else that is not a reply.
    Failed(String),
}

/// One HTTP exchange. Implementations must return by `deadline` whatever happens, and must reuse one pooled
/// connection so the TLS handshake is not paid on the blocked hook's time.
pub trait Transport: Send + Sync {
    /// `path` is relative to the gateway's base URL. Returns the status and the body text.
    fn post(
        &self,
        path: &str,
        headers: &[(&str, String)],
        body: &str,
        deadline: Duration,
    ) -> Result<(u16, String), TransportError>;
    fn get(&self, path: &str, deadline: Duration) -> Result<(u16, String), TransportError>;
}

pub struct GatewayClef<T: Transport> {
    transport: T,
    token: String,
}

impl<T: Transport> GatewayClef<T> {
    pub fn new(transport: T, token: String) -> Self {
        GatewayClef { transport, token }
    }

    /// `GET /health`: opens (or keeps open) the pooled connection. Failures are ignored; the next decide just
    /// pays for the handshake, or falls back at its deadline.
    pub fn warm(&self) -> bool {
        matches!(
            self.transport.get("/health", Duration::from_secs(5)),
            Ok((200, _))
        )
    }
}

/// The JSON body: the state and the questions, nothing else (kind and sig travel as headers).
pub fn body(request: &ClefRequest) -> String {
    serde_json::json!({ "state": request.state, "questions": request.questions }).to_string()
}

impl<T: Transport> Clef for GatewayClef<T> {
    fn ask(
        &self,
        request: &ClefRequest,
        deadline: Duration,
    ) -> Result<(Backend, BTreeMap<String, Answer>), ClefError> {
        let started = Instant::now();
        let mut headers = vec![
            ("authorization", format!("Bearer {}", self.token)),
            ("content-type", "application/json".to_string()),
            ("x-mewndo-kind", request.kind.as_str().to_string()),
            ("x-mewndo-deadline-ms", deadline.as_millis().to_string()),
        ];
        if !request.sig.is_empty() {
            headers.push(("x-mewndo-sig", request.sig.clone()));
        }
        let (status, text) =
            match self
                .transport
                .post("/v1/decide", &headers, &body(request), deadline)
            {
                Ok(reply) => reply,
                Err(TransportError::Timeout) => return Err(ClefError::Deadline),
                Err(TransportError::Failed(e)) => return Err(ClefError::Unavailable(e)),
            };
        // A reply that came late is still late: the hook has already moved on to the rules.
        if started.elapsed() > deadline {
            return Err(ClefError::Deadline);
        }
        if status != 200 {
            // Never echo the body: a 401 or 5xx body is the gateway's, and is not worth a log line with a token
            // nearby. The status is enough to tell a revoked device from an outage.
            return Err(ClefError::Unavailable(format!("gateway status {status}")));
        }
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| ClefError::Unavailable("gateway reply is not JSON".into()))?;
        read_reply(&request.questions, &value)
    }
}

/// The real client, or None when there is no gateway URL or no device token (then every decision is the
/// rules', which is also what the kill switch does).
///   MEWNDO_GATEWAY_URL   the deployed Worker, e.g. https://mewndo-cloud.<account>.workers.dev
///   the token            Credential Manager, Generic credential `Mewndo/gateway-device-token`
pub fn configured() -> Option<Box<dyn Clef + Send + Sync>> {
    let url = std::env::var("MEWNDO_GATEWAY_URL").ok()?;
    if url.is_empty() {
        return None;
    }
    #[cfg(windows)]
    {
        let token = win::read_token().ok().flatten()?;
        if token.is_empty() {
            return None;
        }
        let clef = std::sync::Arc::new(GatewayClef::new(win::Ureq::new(url), token));
        let warm = clef.clone();
        // Pre-connect at start-up, then keep the connection warm. One thread for the life of the core; it only
        // ever sends GET /health, which spends no neurons.
        std::thread::spawn(move || {
            loop {
                warm.warm();
                std::thread::sleep(WARM_EVERY);
            }
        });
        Some(Box::new(Shared(clef)))
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        None
    }
}

/// The router takes a `Box<dyn Clef>`; the warming thread holds the other reference.
#[cfg(windows)]
struct Shared<T: Transport>(std::sync::Arc<GatewayClef<T>>);

#[cfg(windows)]
impl<T: Transport> Clef for Shared<T> {
    fn ask(
        &self,
        request: &ClefRequest,
        deadline: Duration,
    ) -> Result<(Backend, BTreeMap<String, Answer>), ClefError> {
        self.0.ask(request, deadline)
    }
}

#[cfg(windows)]
mod win {
    use super::{Duration, TOKEN_TARGET, Transport, TransportError};
    use std::io::{Error, Result};
    use windows_sys::Win32::Foundation::ERROR_NOT_FOUND;
    use windows_sys::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };

    /// One ureq agent for the life of the core: its pool keeps the TLS connection to the gateway open.
    pub struct Ureq {
        base: String,
        agent: ureq::Agent,
    }

    impl Ureq {
        pub fn new(base: String) -> Ureq {
            let connector = native_tls::TlsConnector::new().expect("OS TLS (SChannel)");
            let agent = ureq::AgentBuilder::new()
                .tls_connector(std::sync::Arc::new(connector))
                .max_idle_connections_per_host(2)
                .no_delay(true)
                .build();
            Ureq {
                base: base.trim_end_matches('/').to_string(),
                agent,
            }
        }

        fn finish(
            reply: std::result::Result<ureq::Response, ureq::Error>,
            started: std::time::Instant,
            deadline: Duration,
        ) -> std::result::Result<(u16, String), TransportError> {
            let response = match reply {
                Ok(r) => r,
                Err(ureq::Error::Status(_, r)) => r,
                Err(e) if started.elapsed() >= deadline => {
                    let _ = e;
                    return Err(TransportError::Timeout);
                }
                Err(e) => return Err(TransportError::Failed(e.kind().to_string())),
            };
            let status = response.status();
            match response.into_string() {
                Ok(text) => Ok((status, text)),
                Err(_) if started.elapsed() >= deadline => Err(TransportError::Timeout),
                Err(e) => Err(TransportError::Failed(e.kind().to_string())),
            }
        }
    }

    impl Transport for Ureq {
        fn post(
            &self,
            path: &str,
            headers: &[(&str, String)],
            body: &str,
            deadline: Duration,
        ) -> std::result::Result<(u16, String), TransportError> {
            let started = std::time::Instant::now();
            let mut req = self
                .agent
                .post(&format!("{}{path}", self.base))
                .timeout(deadline);
            for (k, v) in headers {
                req = req.set(k, v);
            }
            Self::finish(req.send_string(body), started, deadline)
        }

        fn get(
            &self,
            path: &str,
            deadline: Duration,
        ) -> std::result::Result<(u16, String), TransportError> {
            let started = std::time::Instant::now();
            let req = self
                .agent
                .get(&format!("{}{path}", self.base))
                .timeout(deadline);
            Self::finish(req.call(), started, deadline)
        }
    }

    /// The device token from Credential Manager, or None when it was never saved.
    pub fn read_token() -> Result<Option<String>> {
        let target: Vec<u16> = TOKEN_TARGET.encode_utf16().chain([0]).collect();
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let e = Error::last_os_error();
            if e.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(None);
            }
            return Err(e);
        }
        let blob = unsafe {
            let c = &*cred;
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
        };
        unsafe { CredFree(cred as *const _ as *mut _) };
        Ok(String::from_utf8(blob).ok().map(|t| t.trim().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_router::CallKind;
    use mewndo_router::answers::Question;
    use mewndo_router::clef::State;
    use std::sync::Mutex;

    /// One sent request: path, headers, body.
    type Sent = (String, Vec<(String, String)>, String);

    /// Records what was sent and answers with a canned reply.
    struct Fake {
        reply: Result<(u16, String), TransportError>,
        sent: Mutex<Vec<Sent>>,
    }

    impl Fake {
        fn new(reply: Result<(u16, String), TransportError>) -> Fake {
            Fake {
                reply,
                sent: Mutex::default(),
            }
        }
    }

    impl Transport for &Fake {
        fn post(
            &self,
            path: &str,
            headers: &[(&str, String)],
            body: &str,
            _deadline: Duration,
        ) -> Result<(u16, String), TransportError> {
            self.sent.lock().unwrap().push((
                path.into(),
                headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                body.into(),
            ));
            match &self.reply {
                Ok(r) => Ok(r.clone()),
                Err(TransportError::Timeout) => Err(TransportError::Timeout),
                Err(TransportError::Failed(e)) => Err(TransportError::Failed(e.clone())),
            }
        }
        fn get(&self, _path: &str, _deadline: Duration) -> Result<(u16, String), TransportError> {
            Ok((200, "{\"ok\":true}".into()))
        }
    }

    fn request() -> ClefRequest {
        ClefRequest {
            state: State {
                brief: "fix the tests".into(),
                agent: "claude".into(),
                ..State::default()
            },
            questions: vec![Question::noul("q1", "Is this inside the brief?")],
            kind: CallKind::Guard,
            sig: "abc123".into(),
        }
    }

    #[test]
    fn sends_the_headers_and_body_the_gateway_reads() {
        let fake = Fake::new(Ok((
            200,
            r#"{"answers":{"q1":{"p_yes":0.8}},"backend":"workers_ai","ms":40,"rules_only":false}"#
                .into(),
        )));
        let clef = GatewayClef::new(&fake, "tok".into());
        let (backend, answers) = clef.ask(&request(), Duration::from_millis(300)).unwrap();
        assert_eq!(backend, Backend::WorkersAi);
        assert!(answers.contains_key("q1"));

        let sent = fake.sent.lock().unwrap();
        let (path, headers, body) = &sent[0];
        assert_eq!(path, "/v1/decide");
        let h = |k: &str| {
            headers
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(h("authorization"), Some("Bearer tok"));
        assert_eq!(h("x-mewndo-kind"), Some("guard"));
        assert_eq!(h("x-mewndo-sig"), Some("abc123"));
        assert_eq!(h("x-mewndo-deadline-ms"), Some("300"));
        let body: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["state"]["brief"], "fix the tests");
        assert_eq!(body["questions"][0]["id"], "q1");
        assert!(body.get("kind").is_none() && body.get("sig").is_none());
    }

    #[test]
    fn rules_only_reaches_the_router() {
        let fake = Fake::new(Ok((
            200,
            r#"{"fallback":true,"reason":"budget_out","rules_only":true}"#.into(),
        )));
        let clef = GatewayClef::new(&fake, "tok".into());
        assert_eq!(
            clef.ask(&request(), Duration::from_millis(300)),
            Err(ClefError::RulesOnly("budget_out".into()))
        );
    }

    #[test]
    fn every_failure_falls_back_to_the_rules() {
        let cases = [
            (Err(TransportError::Timeout), ClefError::Deadline),
            (
                Err(TransportError::Failed("Dns".into())),
                ClefError::Unavailable("Dns".into()),
            ),
            (
                Ok((401, r#"{"error":"unauthorized"}"#.into())),
                ClefError::Unavailable("gateway status 401".into()),
            ),
            (
                Ok((500, "oops".into())),
                ClefError::Unavailable("gateway status 500".into()),
            ),
            (
                Ok((200, "<html>".into())),
                ClefError::Unavailable("gateway reply is not JSON".into()),
            ),
        ];
        for (reply, want) in cases {
            let fake = Fake::new(reply);
            let clef = GatewayClef::new(&fake, "tok".into());
            assert_eq!(clef.ask(&request(), Duration::from_millis(300)), Err(want));
        }
    }

    #[test]
    fn a_late_reply_is_a_missed_deadline() {
        struct Slow;
        impl Transport for Slow {
            fn post(
                &self,
                _: &str,
                _: &[(&str, String)],
                _: &str,
                _: Duration,
            ) -> Result<(u16, String), TransportError> {
                std::thread::sleep(Duration::from_millis(30));
                Ok((200, r#"{"answers":{"q1":{"p_yes":0.8}}}"#.into()))
            }
            fn get(&self, _: &str, _: Duration) -> Result<(u16, String), TransportError> {
                Err(TransportError::Timeout)
            }
        }
        let clef = GatewayClef::new(Slow, "tok".into());
        assert_eq!(
            clef.ask(&request(), Duration::from_millis(5)),
            Err(ClefError::Deadline)
        );
        assert!(!clef.warm());
    }

    /// Plain HTTP/1.1 over std, for the local `wrangler dev` gateway only (scripts/gateway-dev-test.sh).
    struct LocalHttp(String);

    impl LocalHttp {
        fn send(&self, raw: String, deadline: Duration) -> Result<(u16, String), TransportError> {
            use std::io::{Read, Write};
            let addr = self.0.trim_start_matches("http://").trim_end_matches('/');
            let mut s = std::net::TcpStream::connect(addr)
                .map_err(|e| TransportError::Failed(e.to_string()))?;
            s.set_read_timeout(Some(deadline)).unwrap();
            s.write_all(raw.as_bytes())
                .map_err(|e| TransportError::Failed(e.to_string()))?;
            // wrangler dev keeps the connection open whatever `connection: close` says, so read by length.
            let mut out = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = s.read(&mut buf).map_err(|e| match e.kind() {
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                        TransportError::Timeout
                    }
                    _ => TransportError::Failed(e.to_string()),
                })?;
                out.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&out).to_string();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    if n == 0 || body.len() >= length {
                        let status = head[9..12].parse().unwrap_or(0);
                        return Ok((status, body.to_string()));
                    }
                } else if n == 0 {
                    return Err(TransportError::Failed("closed before headers".into()));
                }
            }
        }
    }

    impl Transport for LocalHttp {
        fn post(
            &self,
            path: &str,
            headers: &[(&str, String)],
            body: &str,
            deadline: Duration,
        ) -> Result<(u16, String), TransportError> {
            let mut raw =
                format!("POST {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n");
            for (k, v) in headers {
                raw.push_str(&format!("{k}: {v}\r\n"));
            }
            raw.push_str(&format!("content-length: {}\r\n\r\n{body}", body.len()));
            self.send(raw, deadline)
        }
        fn get(&self, path: &str, deadline: Duration) -> Result<(u16, String), TransportError> {
            self.send(
                format!("GET {path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n"),
                deadline,
            )
        }
    }

    /// Against the real Worker under `wrangler dev` with a stubbed AI binding. Runs only when
    /// scripts/gateway-dev-test.sh sets MEWNDO_GATEWAY_DEV_URL and MEWNDO_GATEWAY_DEV_TOKEN; otherwise it
    /// returns at once, so `cargo test` never needs the network.
    #[test]
    fn against_the_local_worker() {
        let (Ok(url), Ok(token)) = (
            std::env::var("MEWNDO_GATEWAY_DEV_URL"),
            std::env::var("MEWNDO_GATEWAY_DEV_TOKEN"),
        ) else {
            return;
        };
        let clef = GatewayClef::new(LocalHttp(url.clone()), token);
        assert!(clef.warm(), "GET /health failed");
        let mut req = request();
        req.sig = format!("live-{}", ulid::Ulid::new());
        req.questions.push(Question {
            id: "q2".into(),
            kind: mewndo_router::answers::QuestionType::Choice,
            text: "Which?".into(),
            options: vec!["a".into(), "b".into()],
            scale: vec![],
        });
        let (backend, answers) = clef.ask(&req, Duration::from_secs(5)).unwrap();
        assert_eq!(backend, Backend::WorkersAi);
        assert_eq!(answers.len(), 2);
        // The same signature and brief again: the gateway's 5-minute cache answers.
        let (backend, _) = clef.ask(&req, Duration::from_secs(5)).unwrap();
        assert_eq!(backend, Backend::Cache);
        // A revoked or wrong token is a fallback, never an error the hook sees.
        let bad = GatewayClef::new(LocalHttp(url), "not-a-token".into());
        assert!(matches!(
            bad.ask(&req, Duration::from_secs(5)),
            Err(ClefError::Unavailable(_))
        ));
    }
}
