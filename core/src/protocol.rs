// The messages between the desktop app and mewndo-core. One JSON object per line, both ways.
//   app  -> core  {"v":1,"id":7,"type":"status"}
//   core -> app   {"v":1,"id":7,"type":"status","version":"0.1.0","pid":1234,"uptime_ms":5000}
//   app  -> core  {"v":1,"id":8,"type":"store_put","store":"<data>/store","files":["C:\\a.txt"],"within":"C:\\"}
//   core -> app   {"v":1,"id":8,"type":"stored","results":[{"hash":"9f86…"}]}  or [{"error":"…","code":"changed"}]
// Every message carries the protocol version `v`; a request with another version gets an `unsupported_version`
// error and nothing else happens. Replies echo the request's `id` (null when the line couldn't be read at all).
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
    StoreHas { store: PathBuf, hash: String },
    /// Write stored content to `dest`, which must not exist yet, verifying it. Replies `ok`.
    StoreCopyOut {
        store: PathBuf,
        hash: String,
        dest: PathBuf,
    },
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
    /// Content stores opened so far. Each is cleaned of stale temp files the first time it's used.
    stores: Mutex<HashMap<PathBuf, Arc<Store>>>,
}

impl Info {
    pub fn new() -> Info {
        Info {
            started: Instant::now(),
            stores: Mutex::new(HashMap::new()),
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
}

fn failed(e: StoreError) -> Response {
    Response::Error {
        code: ErrorCode::Failed,
        message: format!("{} ({})", e, e.code()),
    }
}

/// Answer one request line. Returns the reply line and whether the core should now stop.
/// May take a while (store work): run it off the async threads.
pub fn respond(line: &str, info: &Info) -> (String, bool) {
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
        Ok((_, Request::Unknown)) => unreachable!("decode turns unknown types into errors"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(line: &str) -> (serde_json::Value, bool) {
        let (out, stop) = respond(line, &Info::new());
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
