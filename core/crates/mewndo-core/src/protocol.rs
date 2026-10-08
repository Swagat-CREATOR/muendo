// The messages between the desktop app and mewndo-core. One JSON object per line, both ways.
//   app  -> core  {"v":1,"id":7,"type":"status"}
//   core -> app   {"v":1,"id":7,"type":"status","version":"0.1.0","pid":1234,"uptime_ms":5000}
//   app  -> core  {"v":1,"id":8,"type":"store_put","store":"<data>/store","files":["C:\\a.txt"],"within":"C:\\"}
//   core -> app   {"v":1,"id":8,"type":"stored","results":[{"hash":"9f86…"}]}  or [{"error":"…","code":"changed"}]
//   app  -> core  {"v":1,"id":9,"type":"watch","root":"C:\\Projects\\app","options":{"cursor_file":"…"}}
//   core -> app   {"v":1,"id":9,"type":"watching","root":"C:\\Projects\\app"}
//   core -> app   {"v":1,"id":null,"type":"event","root":"C:\\Projects\\app","kind":"deleted","path":"src/a.js",…}
//   app  -> core  {"v":1,"id":10,"type":"restore","log":"<folder data>\\restores\\<id>.json","store":"<data>/store"}
//   core -> app   {"v":1,"id":null,"type":"event","root":"C:\\Projects\\app","kind":"restore_progress","restore":"<id>",…}
//   core -> app   {"v":1,"id":10,"type":"restored","result":{"verified":true,…}}
// Events (id null) come on the connection that asked for the watch or restore, until it unwatches or disconnects.
//   app  -> core  {"v":1,"id":11,"type":"process_freeze","pid":4242}   (also process_resume, process_end)
//   core -> app   {"v":1,"id":11,"type":"processes","pids":[4242,4250],"skipped":[]}
//   app  -> core  {"v":1,"id":12,"type":"screen_state"}  ->  {"v":1,"id":12,"type":"screen_state","full_screen":false}
// Restores and other slow requests (is_slow) run alongside the rest, so their replies can come after later ones'.
// Every message carries the protocol version `v`; a request with another version gets an `unsupported_version`
// error and nothing else happens. Replies echo the request's `id` (null when the line couldn't be read at all).
use crate::decide;
use crate::feed::{self, FeedEvent, WatchOptions};
use crate::ledger::{self, Ledger};
use crate::paths::{display, real};
use crate::policy;
use crate::process::{self, Action};
use crate::restore;
use crate::scanner::{self, Manifest, ScanOptions};
use crate::screen;
use crate::store::{self, Store, StoreError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    /// Is the core alive, and which version is it?
    Status,
    /// Stop cleanly. The reply comes first.
    Shutdown,
    /// Store files in the content store at `store` (a v0-format store folder), many at once. `within`: the
    /// protected folder each file must really be inside. Replies `stored`, one result per file, in order.
    StorePut {
        store: PathBuf,
        files: Vec<PathBuf>,
        within: Option<PathBuf>,
    },
    /// Replies `has`.
    StoreHas {
        store: PathBuf,
        hash: String,
    },
    /// Write stored content to `dest`, which must not exist yet, verifying it. Replies `ok`.
    StoreCopyOut {
        store: PathBuf,
        hash: String,
        dest: PathBuf,
    },
    /// Scan a folder (scanner.rs): everything, or with `dirs` only those folders on top of `previous`. With
    /// `store`, new content is stored as it's hashed. Replies `scanned`.
    Scan {
        root: PathBuf,
        #[serde(default)]
        previous: Manifest,
        dirs: Option<Vec<String>>,
        store: Option<PathBuf>,
        #[serde(default)]
        options: ScanOptions,
    },
    /// Start the change feed for a folder (feed.rs). Replies `watching`; then `event`s, starting with a
    /// `rescan` that says what to look at to catch up.
    Watch {
        root: PathBuf,
        #[serde(default)]
        options: WatchOptions,
    },
    /// Replies `ok`.
    Unwatch {
        root: PathBuf,
    },
    /// Where the change journal is now; note it before a sync. Replies `position` (usn null: no journal).
    FeedPosition {
        root: PathBuf,
    },
    /// Everything before `usn` is safely recorded; the next start catches up from there. Replies `ok`.
    FeedCheckpoint {
        root: PathBuf,
        usn: i64,
    },
    /// Run (or with `resuming`, finish) the restore whose log the app wrote (restore.rs). `options`: the folder's
    /// scan settings, for verification. Sends `restore_progress` and `restore_retry` events; replies `restored`
    /// once the folder is verified and the result is in the log.
    Restore {
        log: PathBuf,
        store: PathBuf,
        #[serde(default)]
        options: ScanOptions,
        #[serde(default)]
        resuming: bool,
        retry_delay_ms: Option<u64>,
        /// Tests only.
        crash_after_steps: Option<usize>,
    },
    /// Guard (policy.rs): judge an agent's planned action against its session's brief. `brief` starts or replaces
    /// the session's policy. Replies `verdict`.
    PolicyCheck {
        session: String,
        brief: Option<policy::Brief>,
        action: policy::Action,
    },
    /// Decision service (decide.rs, spec §29.4): for cases the rules can't decide. Batches an action's questions
    /// into one request with a deadline, a hedge and the caller's rule fallback. Replies `decided`.
    Decide {
        #[serde(flatten)]
        request: decide::DecideRequest,
    },
    /// Flight Recorder (ledger.rs, spec §30.2): record one event in the device's hash-chained, signed ledger
    /// under `data_dir`. Replies `ledger_record`.
    LedgerAppend {
        data_dir: PathBuf,
        event: ledger::Event,
    },
    /// Check the whole ledger chain under `data_dir`. Replies `ledger_status`.
    LedgerVerify {
        data_dir: PathBuf,
    },
    /// Brake (process.rs): freeze, resume or end the process tree of `pid`. Replies `processes`.
    ProcessFreeze {
        pid: u32,
    },
    ProcessResume {
        pid: u32,
    },
    ProcessEnd {
        pid: u32,
    },
    /// Is a full-screen app in front (screen.rs)? Replies `screen_state`.
    ScreenState,
    /// Any type this version doesn't know. Only for reading requests; never sent.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Status {
        version: String,
        pid: u32,
        uptime_ms: u64,
    },
    Ok,
    Stored {
        results: Vec<PutResult>,
    },
    Has {
        stored: bool,
    },
    /// root: the folder's long real path, as it's known from now on.
    Scanned {
        root: String,
        manifest: Manifest,
        found: usize,
        hashed: usize,
    },
    Watching {
        root: String,
    },
    Position {
        usn: Option<i64>,
    },
    Verdict {
        #[serde(flatten)]
        verdict: policy::Verdict,
    },
    /// The decision for a `decide` request (model answers or a rule fallback), with its bookkeeping.
    Decided {
        #[serde(flatten)]
        decided: decide::Decided,
    },
    /// One appended ledger record (spec §30.2).
    LedgerRecord {
        #[serde(flatten)]
        record: ledger::Record,
    },
    /// Whether the ledger chain is intact, and how many records it holds.
    LedgerStatus {
        intact: bool,
        count: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<String>,
    },
    /// The processes acted on, root first, and the ones left alone (system processes, Mewndo itself).
    Processes {
        #[serde(flatten)]
        report: process::Report,
    },
    ScreenState {
        full_screen: bool,
    },
    /// v0's restore result (see restore::run).
    Restored {
        result: serde_json::Value,
    },
    /// A change feed event, sent unasked (id null).
    Event {
        root: String,
        #[serde(flatten)]
        event: FeedEvent,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, PartialEq, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Not JSON, or missing `v`, `id` or `type`.
    BadRequest,
    UnsupportedVersion,
    UnknownType,
    /// The request was understood but failed; `message` says why.
    Failed,
}

/// One file's result in a batch: its hash, or why it wasn't stored (`code`: changed, not_found, io…).
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct PutResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// What every message looks like on the wire: the version and id around the message itself.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub v: u32,
    pub id: Option<u64>,
    #[serde(flatten)]
    pub body: T,
}

pub struct ErrorReply {
    pub id: Option<u64>,
    pub code: ErrorCode,
    pub message: String,
}

fn bad(id: Option<u64>, code: ErrorCode, message: impl Into<String>) -> ErrorReply {
    ErrorReply {
        id,
        code,
        message: message.into(),
    }
}

/// Read one request line. The id is recovered whenever possible, so even an error reply can be matched up.
pub fn decode(line: &str) -> Result<(u64, Request), ErrorReply> {
    let value: serde_json::Value = serde_json::from_str(line)
        .map_err(|e| bad(None, ErrorCode::BadRequest, format!("not JSON: {e}")))?;
    let id = value.get("id").and_then(|v| v.as_u64());
    let v = value.get("v").and_then(|v| v.as_u64());
    match v {
        None => {
            return Err(bad(
                id,
                ErrorCode::BadRequest,
                "missing protocol version \"v\"",
            ));
        }
        Some(v) if v != u64::from(PROTOCOL_VERSION) => {
            return Err(bad(
                id,
                ErrorCode::UnsupportedVersion,
                format!("mewndo-core speaks protocol {PROTOCOL_VERSION}, not {v}"),
            ));
        }
        _ => {}
    }
    let id = id.ok_or_else(|| bad(None, ErrorCode::BadRequest, "missing request \"id\""))?;
    match serde_json::from_value::<Request>(value) {
        Ok(Request::Unknown) => Err(bad(
            Some(id),
            ErrorCode::UnknownType,
            "unknown request type",
        )),
        Ok(request) => Ok((id, request)),
        Err(e) => Err(bad(Some(id), ErrorCode::BadRequest, e.to_string())),
    }
}

/// One reply line, without the newline.
pub fn encode(id: Option<u64>, body: Response) -> String {
    serde_json::to_string(&Envelope {
        v: PROTOCOL_VERSION,
        id,
        body,
    })
    .expect("replies always serialize")
}

pub struct Info {
    pub started: Instant,
    /// Guard sessions: each agent session's brief and recent activity.
    policies: policy::Sessions,
    /// Content stores opened so far. Each is cleaned of stale temp files the first time it's used.
    stores: Mutex<HashMap<PathBuf, Arc<Store>>>,
    /// Flight Recorder ledgers opened so far, one per data folder.
    ledgers: Mutex<HashMap<PathBuf, Arc<Ledger>>>,
    /// Decision-service transport, built from the environment, or None when it isn't configured (then every
    /// decision uses the caller's rule fallback).
    decider: Option<Arc<dyn decide::Responder>>,
}

impl Info {
    pub fn new() -> Info {
        Info {
            started: Instant::now(),
            policies: policy::Sessions::default(),
            stores: Mutex::new(HashMap::new()),
            ledgers: Mutex::new(HashMap::new()),
            decider: decide::configured(),
        }
    }

    fn store(&self, dir: &Path) -> Arc<Store> {
        let mut stores = self.stores.lock().unwrap_or_else(|e| e.into_inner());
        stores
            .entry(dir.to_path_buf())
            .or_insert_with(|| {
                let store = Arc::new(Store::new(dir));
                let _ = store.clean_temp(store::TEMP_MAX_AGE); // startup cleanup, as v0 does
                store
            })
            .clone()
    }

    /// Open (once) and cache the Flight Recorder ledger under `dir`.
    fn ledger(&self, dir: &Path) -> std::io::Result<Arc<Ledger>> {
        let mut ledgers = self.ledgers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(l) = ledgers.get(dir) {
            return Ok(l.clone());
        }
        let l = Arc::new(Ledger::open(dir)?);
        ledgers.insert(dir.to_path_buf(), l.clone());
        Ok(l)
    }
}

/// One connection's state: where its events go, and the folders it watches. Dropping it stops the watches.
pub struct Session {
    out: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    watches: Mutex<HashMap<String, feed::Watch>>,
}

impl Session {
    pub fn new(out: tokio::sync::mpsc::UnboundedSender<String>) -> Session {
        Session {
            out: Some(out),
            watches: Mutex::new(HashMap::new()),
        }
    }

    /// A session whose events go nowhere (tests of single requests).
    #[cfg(test)]
    pub fn detached() -> Session {
        Session {
            out: None,
            watches: Mutex::new(HashMap::new()),
        }
    }

    fn watches(&self) -> std::sync::MutexGuard<'_, HashMap<String, feed::Watch>> {
        self.watches.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The key a folder is known by: its long real path, as shown.
fn folder_key(root: &Path) -> std::io::Result<String> {
    real(root).map(|r| display(&r))
}

fn io_failed(e: &std::io::Error) -> Response {
    Response::Error {
        code: ErrorCode::Failed,
        message: format!("{e} ({})", scanner::node_code(e)),
    }
}

fn failed(e: StoreError) -> Response {
    Response::Error {
        code: ErrorCode::Failed,
        message: format!("{} ({})", e, e.code()),
    }
}

/// Requests that can take long: the connection runs them alongside others instead of in order.
pub fn is_slow(line: &str) -> bool {
    matches!(
        decode(line),
        Ok((
            _,
            Request::StorePut { .. }
                | Request::StoreCopyOut { .. }
                | Request::Scan { .. }
                | Request::ProcessFreeze { .. }
                | Request::ProcessResume { .. }
                | Request::ProcessEnd { .. }
                | Request::Decide { .. }
        ))
    )
}

/// Answer one request line. Returns the reply line (None: it comes later, on the session) and whether the core
/// should now stop. May take a while (store work): run it off the async threads.
pub fn respond(line: &str, info: &Info, session: &Session) -> (Option<String>, bool) {
    if let Ok((
        id,
        Request::Restore {
            log,
            store,
            options,
            resuming,
            retry_delay_ms,
            crash_after_steps,
        },
    )) = decode(line)
    {
        let (store, out) = (info.store(&store), session.out.clone());
        let send = move |line: String| {
            if let Some(out) = &out {
                let _ = out.send(line);
            }
        };
        std::thread::spawn(move || {
            let opts = restore::Options {
                scan: options,
                resuming,
                retry_delay_ms: retry_delay_ms.unwrap_or(100),
                crash_after_steps,
            };
            let emit = |mut event: serde_json::Value| {
                event["v"] = PROTOCOL_VERSION.into();
                event["id"] = serde_json::Value::Null;
                event["type"] = "event".into();
                send(event.to_string());
            };
            let reply = match restore::run(&log, &store, &opts, &emit) {
                Ok(result) => Response::Restored { result },
                Err(e) => Response::Error {
                    code: ErrorCode::Failed,
                    message: e.to_string(),
                },
            };
            send(encode(Some(id), reply));
        });
        return (None, false);
    }
    let (reply, stop) = respond_now(line, info, session);
    (Some(reply), stop)
}

fn respond_now(line: &str, info: &Info, session: &Session) -> (String, bool) {
    match decode(line) {
        Err(e) => (
            encode(
                e.id,
                Response::Error {
                    code: e.code,
                    message: e.message,
                },
            ),
            false,
        ),
        Ok((id, Request::Status)) => {
            let status = Response::Status {
                version: env!("CARGO_PKG_VERSION").to_string(),
                pid: std::process::id(),
                uptime_ms: info.started.elapsed().as_millis() as u64,
            };
            (encode(Some(id), status), false)
        }
        Ok((id, Request::Shutdown)) => (encode(Some(id), Response::Ok), true),
        Ok((
            id,
            Request::StorePut {
                store,
                files,
                within,
            },
        )) => {
            let results = info
                .store(&store)
                .put_batch(&files, within.as_deref())
                .into_iter()
                .map(|r| match r {
                    Ok(hash) => PutResult {
                        hash: Some(hash),
                        error: None,
                        code: None,
                    },
                    Err(e) => PutResult {
                        hash: None,
                        error: Some(e.to_string()),
                        code: Some(e.code().into()),
                    },
                })
                .collect();
            (encode(Some(id), Response::Stored { results }), false)
        }
        Ok((id, Request::StoreHas { store, hash })) => {
            let reply = info
                .store(&store)
                .has(&hash)
                .map_or_else(failed, |stored| Response::Has { stored });
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::StoreCopyOut { store, hash, dest })) => {
            let reply = info
                .store(&store)
                .copy_out(&hash, &dest)
                .map_or_else(failed, |()| Response::Ok);
            (encode(Some(id), reply), false)
        }
        Ok((
            id,
            Request::Scan {
                root,
                previous,
                dirs,
                store,
                options,
            },
        )) => {
            let store = store.map(|dir| info.store(&dir));
            let reply = match folder_key(&root) {
                Err(e) => io_failed(&e),
                Ok(key) => match scanner::scan(
                    &root,
                    &previous,
                    dirs.as_deref(),
                    &options,
                    store.as_deref(),
                ) {
                    Ok((manifest, stats)) => Response::Scanned {
                        root: key,
                        manifest,
                        found: stats.found,
                        hashed: stats.hashed,
                    },
                    Err(e) => io_failed(&e),
                },
            };
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::Watch { root, options })) => {
            let reply = match folder_key(&root) {
                Err(e) => io_failed(&e),
                Ok(key) => {
                    let out = session.out.clone();
                    let event_root = key.clone();
                    let emit: feed::Emit = Arc::new(move |event| {
                        if let Some(out) = &out {
                            let _ = out.send(encode(
                                None,
                                Response::Event {
                                    root: event_root.clone(),
                                    event,
                                },
                            ));
                        }
                    });
                    session.watches().remove(&key); // watching again restarts it
                    match feed::watch(&root, options, emit) {
                        Ok(w) => {
                            let root = display(w.real_root()); // as the feed resolved it
                            session.watches().insert(key, w);
                            Response::Watching { root }
                        }
                        Err(e) => io_failed(&e),
                    }
                }
            };
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::Unwatch { root })) => {
            let reply = match folder_key(&root) {
                Ok(key) => {
                    session.watches().remove(&key);
                    Response::Ok
                }
                Err(e) => io_failed(&e),
            };
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::FeedPosition { root })) => {
            let reply = with_watch(session, &root, |w| {
                w.position().map(|usn| Response::Position { usn })
            });
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::FeedCheckpoint { root, usn })) => {
            let reply = with_watch(session, &root, |w| w.checkpoint(usn).map(|()| Response::Ok));
            (encode(Some(id), reply), false)
        }
        Ok((
            id,
            Request::PolicyCheck {
                session,
                brief,
                action,
            },
        )) => {
            let verdict = info.policies.check(&session, brief, &action);
            (encode(Some(id), Response::Verdict { verdict }), false)
        }
        Ok((id, Request::Decide { request })) => {
            let decided = match &info.decider {
                Some(responder) => decide::decide(responder, &request),
                None => decide::immediate_fallback(&request),
            };
            (encode(Some(id), Response::Decided { decided }), false)
        }
        Ok((id, Request::LedgerAppend { data_dir, event })) => {
            let reply = match info.ledger(&data_dir).and_then(|l| l.append(event)) {
                Ok(record) => Response::LedgerRecord { record },
                Err(e) => io_failed(&e),
            };
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::LedgerVerify { data_dir })) => {
            let reply = match info.ledger(&data_dir) {
                Ok(l) => {
                    let (intact, problem) = match l.verify() {
                        Ok(()) => (true, None),
                        Err(t) => (false, Some(t.to_string())),
                    };
                    Response::LedgerStatus {
                        intact,
                        count: l.len(),
                        problem,
                    }
                }
                Err(e) => io_failed(&e),
            };
            (encode(Some(id), reply), false)
        }
        Ok((id, Request::ProcessFreeze { pid })) => {
            (encode(Some(id), control(pid, Action::Freeze)), false)
        }
        Ok((id, Request::ProcessResume { pid })) => {
            (encode(Some(id), control(pid, Action::Resume)), false)
        }
        Ok((id, Request::ProcessEnd { pid })) => {
            (encode(Some(id), control(pid, Action::End)), false)
        }
        Ok((id, Request::ScreenState)) => (
            encode(
                Some(id),
                Response::ScreenState {
                    full_screen: screen::full_screen(),
                },
            ),
            false,
        ),
        Ok((_, Request::Restore { .. })) => unreachable!("respond runs restores"),
        Ok((_, Request::Unknown)) => unreachable!("decode turns unknown types into errors"),
    }
}

fn control(pid: u32, action: Action) -> Response {
    match process::control(pid, action) {
        Ok(report) => Response::Processes { report },
        Err(e) => Response::Error {
            code: ErrorCode::Failed,
            message: e.to_string(),
        },
    }
}

fn with_watch(
    session: &Session,
    root: &Path,
    f: impl FnOnce(&feed::Watch) -> std::io::Result<Response>,
) -> Response {
    let key = match folder_key(root) {
        Ok(k) => k,
        Err(e) => return io_failed(&e),
    };
    match session.watches().get(&key) {
        Some(w) => f(w).unwrap_or_else(|e| io_failed(&e)),
        None => Response::Error {
            code: ErrorCode::Failed,
            message: format!("not watching {key}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(line: &str) -> (serde_json::Value, bool) {
        let (out, stop) = respond(line, &Info::new(), &Session::detached());
        let out = out.expect("answered at once");
        assert!(!out.contains('\n'), "a reply is exactly one line");
        (serde_json::from_str(&out).unwrap(), stop)
    }

    #[test]
    fn status_reports_version_pid_and_uptime() {
        let (r, stop) = reply(r#"{"v":1,"id":7,"type":"status"}"#);
        assert_eq!(r["v"], 1);
        assert_eq!(r["id"], 7);
        assert_eq!(r["type"], "status");
        assert_eq!(r["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(r["pid"], std::process::id());
        assert!(r["uptime_ms"].is_u64());
        assert!(!stop);
    }

    #[test]
    fn shutdown_replies_ok_then_stops() {
        let (r, stop) = reply(r#"{"v":1,"id":2,"type":"shutdown"}"#);
        assert_eq!(r, serde_json::json!({"v":1,"id":2,"type":"ok"}));
        assert!(stop);
    }

    #[test]
    fn another_protocol_version_is_refused_and_does_nothing() {
        let (r, stop) = reply(r#"{"v":2,"id":3,"type":"shutdown"}"#);
        assert_eq!(r["type"], "error");
        assert_eq!(r["code"], "unsupported_version");
        assert_eq!(r["id"], 3);
        assert!(
            !stop,
            "a shutdown in an unknown protocol version must not stop the core"
        );
    }

    #[test]
    fn unknown_type_is_an_error_with_its_id() {
        let (r, _) = reply(r#"{"v":1,"id":4,"type":"restore_everything"}"#);
        assert_eq!(
            (r["code"].as_str(), r["id"].as_u64()),
            (Some("unknown_type"), Some(4))
        );
    }

    #[test]
    fn malformed_requests_are_bad_requests() {
        for line in [
            "",
            "not json",
            "[]",
            r#"{"id":1,"type":"status"}"#,
            r#"{"v":1,"type":"status"}"#,
            r#"{"v":1,"id":1}"#,
            r#"{"v":1,"id":1,"type":5}"#,
        ] {
            let (r, stop) = reply(line);
            assert_eq!(r["code"], "bad_request", "line {line:?}");
            assert!(!stop);
        }
    }

    #[test]
    fn extra_fields_are_ignored_so_newer_apps_can_add_optional_ones() {
        let (r, _) = reply(r#"{"v":1,"id":5,"type":"status","hint":"x"}"#);
        assert_eq!(r["type"], "status");
    }

    #[test]
    fn decide_without_a_configured_service_falls_back_to_the_rules() {
        // No MEWNDO_DECIDE_URL in the test environment, so Info has no decider and
        // the decision is an immediate rule fallback. Also checks that the flattened
        // DecideRequest decodes inside the internally-tagged request enum.
        let line = r#"{"v":1,"id":9,"type":"decide","caller":"send","state":{"brief":"x"},"questions":[{"id":"a","type":"noul","text":"ok?"}],"fallback":"ask"}"#;
        let (r, stop) = reply(line);
        assert_eq!(r["type"], "decided");
        assert_eq!(r["id"], 9);
        assert_eq!(r["source"], "rules");
        assert_eq!(r["fallback_used"], true);
        assert_eq!(r["deadline_met"], false);
        assert_eq!(r["fallback"], "ask");
        assert!(!stop);
    }

    #[test]
    fn ledger_append_then_verify_over_the_protocol() {
        // Same Info for both requests, so the cached ledger (and its device key) is shared.
        let info = Info::new();
        let session = Session::detached();
        let dir = std::env::temp_dir().join(format!(
            "mewndo-proto-ledger-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let dir_json = serde_json::to_string(&dir).unwrap(); // escapes backslashes on Windows
        let append = format!(
            r#"{{"v":1,"id":1,"type":"ledger_append","data_dir":{dir_json},"event":{{"time_ms":1,"kind":"guard","agent":"claude","vendor":"anthropic","principal":"me","brief_hash":"x","action":{{"t":1}},"target":"a.txt","decision":"deny"}}}}"#
        );
        let (out, _) = respond(&append, &info, &session);
        let r: serde_json::Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(r["type"], "ledger_record");
        assert_eq!(r["seq"], 0);
        assert_eq!(r["event"]["target"], "a.txt");

        let verify = format!(r#"{{"v":1,"id":2,"type":"ledger_verify","data_dir":{dir_json}}}"#);
        let (out, _) = respond(&verify, &info, &session);
        let r: serde_json::Value = serde_json::from_str(&out.unwrap()).unwrap();
        assert_eq!(r["type"], "ledger_status");
        assert_eq!(r["intact"], true);
        assert_eq!(r["count"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_response_round_trips() {
        for body in [
            Response::Status {
                version: "1.2.3".into(),
                pid: 9,
                uptime_ms: 10,
            },
            Response::Ok,
            Response::Error {
                code: ErrorCode::UnknownType,
                message: "m".into(),
            },
        ] {
            let line = encode(Some(1), body);
            let back: Envelope<Response> = serde_json::from_str(&line).unwrap();
            assert_eq!(back.v, PROTOCOL_VERSION);
            assert_eq!(back.id, Some(1));
            assert_eq!(encode(back.id, back.body), line);
        }
    }

    #[test]
    fn every_request_round_trips() {
        for request in [Request::Status, Request::Shutdown] {
            let line = serde_json::to_string(&Envelope {
                v: PROTOCOL_VERSION,
                id: Some(8),
                body: request,
            })
            .unwrap();
            let (id, back) = decode(&line).ok().unwrap();
            assert_eq!(id, 8);
            assert_eq!(
                serde_json::to_string(&Envelope {
                    v: PROTOCOL_VERSION,
                    id: Some(8),
                    body: back
                })
                .unwrap(),
                line
            );
        }
    }
}
