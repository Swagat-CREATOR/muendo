// mewndo-proto: the pipe protocol v2 between mewndo-core and everything that talks to it (the app, the hook
// forwarder, the computer-use proxy and the overlay). Spec §33.10 Part A and §38.5.
//
// A frame is a 1-byte frame type, a 4-byte little-endian payload length, then the payload (at most 8 MB):
//   type 0, JSON:  {"v":2,"id":"01J…","type":"hello","body":{"role":"app"}}
//   type 1, lane:  a 1-byte lane id length, the lane id (UTF-8), then raw terminal bytes
// The first message on every connection is `hello`. If a contract here must change, bump VERSION and change both
// sides in the same commit (§32.5 rule 1).
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const VERSION: u16 = 2;
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
pub const HEADER: usize = 5;
const JSON: u8 = 0;
const LANE: u8 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u16,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub body: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Json(Envelope),
    Lane { lane: String, data: Vec<u8> },
}

#[derive(Debug, PartialEq)]
pub enum Error {
    TooLarge(usize),
    UnknownFrameType(u8),
    BadJson(String),
    BadLane,
    WrongType { want: &'static str, got: String },
    WrongVersion(u16),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Error::TooLarge(n) => write!(f, "a {n}-byte frame is over the {MAX_FRAME}-byte limit"),
            Error::UnknownFrameType(t) => write!(f, "unknown frame type {t}"),
            Error::BadJson(e) => write!(f, "bad message: {e}"),
            Error::BadLane => write!(f, "bad lane frame"),
            Error::WrongType { want, got } => write!(f, "expected {want}, got {got}"),
            Error::WrongVersion(v) => write!(f, "protocol version {v}, this side speaks {VERSION}"),
        }
    }
}

impl std::error::Error for Error {}

pub fn encode(frame: &Frame) -> Result<Vec<u8>, Error> {
    let (kind, payload) = match frame {
        Frame::Json(env) => (
            JSON,
            serde_json::to_vec(env).map_err(|e| Error::BadJson(e.to_string()))?,
        ),
        Frame::Lane { lane, data } => {
            let id = lane.as_bytes();
            let len = u8::try_from(id.len()).map_err(|_| Error::BadLane)?;
            let mut p = Vec::with_capacity(1 + id.len() + data.len());
            p.push(len);
            p.extend_from_slice(id);
            p.extend_from_slice(data);
            (LANE, p)
        }
    };
    if payload.len() > MAX_FRAME {
        return Err(Error::TooLarge(payload.len()));
    }
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// The frame type and payload length from a header. Checked before the payload is read, so a bad or huge length
/// never makes a reader allocate.
pub fn header(h: &[u8; HEADER]) -> Result<(u8, usize), Error> {
    let len = u32::from_le_bytes([h[1], h[2], h[3], h[4]]) as usize;
    if h[0] != JSON && h[0] != LANE {
        return Err(Error::UnknownFrameType(h[0]));
    }
    if len > MAX_FRAME {
        return Err(Error::TooLarge(len));
    }
    Ok((h[0], len))
}

pub fn payload(kind: u8, p: &[u8]) -> Result<Frame, Error> {
    match kind {
        JSON => {
            let env: Envelope =
                serde_json::from_slice(p).map_err(|e| Error::BadJson(e.to_string()))?;
            Ok(Frame::Json(env))
        }
        LANE => {
            let n = *p.first().ok_or(Error::BadLane)? as usize;
            let id = p.get(1..1 + n).ok_or(Error::BadLane)?;
            let lane = std::str::from_utf8(id)
                .map_err(|_| Error::BadLane)?
                .to_string();
            Ok(Frame::Lane {
                lane,
                data: p[1 + n..].to_vec(),
            })
        }
        other => Err(Error::UnknownFrameType(other)),
    }
}

/// One frame from the front of `buf`: `None` while it is incomplete, otherwise the frame and the bytes it used.
pub fn decode(buf: &[u8]) -> Result<Option<(Frame, usize)>, Error> {
    let Some(h) = buf.first_chunk::<HEADER>() else {
        return Ok(None);
    };
    let (kind, len) = header(h)?;
    let Some(p) = buf.get(HEADER..HEADER + len) else {
        return Ok(None);
    };
    Ok(Some((payload(kind, p)?, HEADER + len)))
}

/// A message body with its `type` name. `Envelope::wrap` and `Envelope::open` convert between the two.
pub trait Body: Serialize + DeserializeOwned {
    const TYPE: &'static str;
}

impl Envelope {
    pub fn wrap<B: Body>(id: impl Into<String>, body: &B) -> Envelope {
        Envelope {
            v: VERSION,
            id: id.into(),
            kind: B::TYPE.to_string(),
            body: serde_json::to_value(body).expect("message bodies always serialize"),
        }
    }

    pub fn open<B: Body>(&self) -> Result<B, Error> {
        if self.v != VERSION {
            return Err(Error::WrongVersion(self.v));
        }
        if self.kind != B::TYPE {
            return Err(Error::WrongType {
                want: B::TYPE,
                got: self.kind.clone(),
            });
        }
        serde_json::from_value(self.body.clone()).map_err(|e| Error::BadJson(e.to_string()))
    }
}

macro_rules! bodies {
    ($($name:ident = $ty:literal),* $(,)?) => { $(impl Body for $name { const TYPE: &'static str = $ty; })* };
}

// --- §38.5 messages -----------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    App,
    Hook,
    Computer,
    Overlay,
}

/// any -> core, first message on every connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub role: Role,
}

/// any -> core; the core answers `pong` with the same id.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Ping {}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Pong {}

/// core -> any, in place of a reply the core can't give.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub message: String,
}

/// hook -> core: one agent hook event; `payload` is the hook's stdin JSON as the agent sent it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookRequest {
    pub agent: String,
    pub event: String,
    pub session_id: Option<String>,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
    pub lane_id: Option<String>,
    pub payload: Value,
}

/// core -> hook: what the forwarder prints, and its exit code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookResponse {
    pub stdout: String,
    pub exit_code: i32,
}

/// core -> app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStatus {
    pub agent_id: String,
    pub kind: String,
    pub name: String,
    pub connection: String,
    pub status: String,
    pub last_line: Option<String>,
}

/// core -> app: a card to show (§33.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxCard {
    pub id: String,
    pub kind: String,
    pub agent_id: String,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub risk: u8,
    pub thumb: Option<String>,
    pub grace_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Key,
    Click,
    Voice,
}

/// app -> core: `choice` is an index into the card's options; `text` a typed or spoken reply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxAnswer {
    pub card_id: String,
    pub choice: Option<usize>,
    pub text: Option<String>,
    pub via: Via,
}

/// core -> app: the grace period ended and the answer went to the agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxRelease {
    pub card_id: String,
    pub savepoint_id: Option<String>,
}

/// core -> app: the card can no longer be answered (its hook timed out, or the user answered in the terminal), so
/// it leaves the stack. Not in §38.5's table; added with the core's Inbox wiring (docs/decisions.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxExpired {
    pub card_id: String,
}

/// core -> app: the gateway said today's model budget is out (`rules_only`), or that it is back. The dock shows
/// "Rules only mode" while it is true. Not in §38.5's table; added with the gateway's budget priorities.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetState {
    pub rules_only: bool,
}

/// app -> core: undo what the agent did after this answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxUndo {
    pub card_id: String,
    pub savepoint_id: Option<String>,
}

/// app -> core: text from the Talk box.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteRequest {
    pub text: String,
}

/// core -> app: where the text should go.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteResult {
    pub target: String,
    pub confidence: f64,
    pub alternatives: Vec<String>,
}

/// core -> app. The span's own shape belongs to mewndo-trace (§35); it travels as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpanCreated {
    pub trace_id: String,
    pub span: Value,
}

/// core -> app: the Receipt line for a Done card (§35).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptResult {
    pub trace_id: String,
    pub line: String,
    pub mismatches: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// core -> overlay: animate the agent cursor (§36.3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CursorMove {
    pub agent_id: String,
    pub from: Point,
    pub to: Point,
    pub style: String,
    pub label: String,
}

/// core -> app: Show Me recording on or off.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShowmeState {
    pub recording: bool,
}

/// core -> app: one recorded step, in the steps.json shape of §36.5.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShowmeStep {
    pub step: Value,
}

/// app -> core.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ShowmeStart {}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ShowmeStop {}

/// computer proxy -> core: an act to guard (§36.6 U5). Typed text is redacted before it is sent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerAction {
    pub session: String,
    pub tool: String,
    pub args_redacted: Value,
    pub point: Option<Point>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Deny,
}

/// core -> computer proxy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerVerdict {
    pub verdict: Verdict,
    pub reason: Option<String>,
}

/// core -> computer proxy and app: the user touched the mouse (§36.4), or chose Resume.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerPause {
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComputerResume {
    pub sessions: Vec<String>,
}

// --- lanes (§33.7, §33.10 Part G) ----------------------------------------------------------------------------------
// A lane's output is `Frame::Lane` (type 1). These are its control messages. They lived in mewndo-pty until the
// core served them; they moved here unchanged, plus `lane.attach` and `lane.close` (docs/decisions.md, "Lanes on
// the desk pipe").

/// app -> core: "start Claude in shop" (§33.7). The core answers with `lane.opened`, or `error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneOpen {
    /// `claude`, `codex` or `cursor-agent`, as the user would type it.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// The protected folder the lane runs in.
    pub cwd: String,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

/// core -> app: a lane exists, with what a window needs to draw it. Sent to every app when the lane opens, to an
/// app that connects while it exists, and after a `lane.attach` replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneOpened {
    pub lane_id: String,
    pub program: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
    /// False once the agent has ended; the lane stays until `lane.close`, so its last output can be read.
    #[serde(default = "yes")]
    pub running: bool,
    #[serde(default)]
    pub exit_code: Option<u32>,
}

fn yes() -> bool {
    true
}

/// app -> core: type this into the lane, at any time (§33.7). The core adds Enter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneReply {
    pub lane_id: String,
    pub text: String,
}

/// app -> core: Ctrl+C (§24).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneBrake {
    pub lane_id: String,
}

/// app -> core: an xterm.js `resize` event. The core clamps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneResize {
    pub lane_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// app -> core: a window (re)opened. The core sends this connection the lane's replay buffer as lane frames,
/// then `lane.opened`, so the window can draw from where the lane is now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneAttach {
    pub lane_id: String,
}

/// app -> core: end the lane for good: the agent is stopped if it still runs, and its replay buffer goes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneClose {
    pub lane_id: String,
}

/// core -> app: the agent ended (`exit_code`), or, with `removed`, the lane itself is gone (`lane.close`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneClosed {
    pub lane_id: String,
    pub exit_code: Option<u32>,
    #[serde(default)]
    pub removed: bool,
}

bodies! {
    Hello = "hello", Ping = "ping", Pong = "pong", ErrorBody = "error",
    HookRequest = "hook.request", HookResponse = "hook.response", AgentStatus = "agent.status",
    InboxCard = "inbox.card", InboxAnswer = "inbox.answer", InboxRelease = "inbox.release", InboxUndo = "inbox.undo", InboxExpired = "inbox.expired", BudgetState = "budget.state",
    RouteRequest = "route.request", RouteResult = "route.result", SpanCreated = "span.created",
    ReceiptResult = "receipt.result", CursorMove = "cursor.move", ShowmeState = "showme.state",
    ShowmeStep = "showme.step", ShowmeStart = "showme.start", ShowmeStop = "showme.stop",
    ComputerAction = "computer.action", ComputerVerdict = "computer.verdict", ComputerPause = "computer.pause",
    ComputerResume = "computer.resume",
    LaneOpen = "lane.open", LaneOpened = "lane.opened", LaneReply = "lane.reply", LaneBrake = "lane.brake",
    LaneResize = "lane.resize", LaneAttach = "lane.attach", LaneClose = "lane.close", LaneClosed = "lane.closed",
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_trip(frame: Frame) {
        let bytes = encode(&frame).unwrap();
        assert_eq!(decode(&bytes).unwrap(), Some((frame, bytes.len())));
    }

    #[test]
    fn json_and_lane_frames_round_trip() {
        round_trip(Frame::Json(Envelope::wrap(
            "1",
            &Hello { role: Role::Hook },
        )));
        round_trip(Frame::Lane {
            lane: "01JAN0LANE".into(),
            data: b"\x1b[32mok\x1b[0m\r\n".to_vec(),
        });
        round_trip(Frame::Lane {
            lane: String::new(),
            data: vec![],
        });
    }

    #[test]
    fn the_wire_format_is_type_then_little_endian_length() {
        let bytes = encode(&Frame::Json(Envelope::wrap("7", &Ping {}))).unwrap();
        let json = br#"{"v":2,"id":"7","type":"ping","body":{}}"#;
        assert_eq!(bytes[0], 0);
        assert_eq!(&bytes[1..5], &(json.len() as u32).to_le_bytes());
        assert_eq!(&bytes[5..], json);
    }

    #[test]
    fn every_message_body_round_trips_through_an_envelope() {
        fn check<B: Body + PartialEq + fmt::Debug>(body: B) {
            let env = Envelope::wrap("x", &body);
            assert_eq!(env.kind, B::TYPE);
            let Frame::Json(back) = decode(&encode(&Frame::Json(env)).unwrap())
                .unwrap()
                .unwrap()
                .0
            else {
                panic!("not json")
            };
            assert_eq!(back.open::<B>().unwrap(), body);
        }
        let p = Point { x: -1920, y: 40 };
        check(Hello {
            role: Role::Overlay,
        });
        check(Ping {});
        check(Pong {});
        check(ErrorBody {
            message: "no".into(),
        });
        check(HookRequest {
            agent: "claude".into(),
            event: "pre-tool".into(),
            session_id: Some("s".into()),
            pid: Some(42),
            cwd: Some(r"C:\work\shop".into()),
            lane_id: None,
            payload: json!({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
        });
        check(HookResponse {
            stdout: "{}".into(),
            exit_code: 0,
        });
        check(AgentStatus {
            agent_id: "a".into(),
            kind: "claude-code".into(),
            name: "Claude".into(),
            connection: "hooked".into(),
            status: "working".into(),
            last_line: None,
        });
        check(InboxCard {
            id: "c".into(),
            kind: "permission".into(),
            agent_id: "a".into(),
            title: "Run npm test?".into(),
            body: "shop".into(),
            options: vec!["Allow once".into(), "Deny".into()],
            risk: 2,
            thumb: None,
            grace_ms: 2000,
        });
        check(InboxAnswer {
            card_id: "c".into(),
            choice: Some(0),
            text: None,
            via: Via::Key,
        });
        check(InboxRelease {
            card_id: "c".into(),
            savepoint_id: Some("sp".into()),
        });
        check(InboxUndo {
            card_id: "c".into(),
            savepoint_id: None,
        });
        check(InboxExpired {
            card_id: "c".into(),
        });
        check(BudgetState { rules_only: true });
        check(RouteRequest {
            text: "tell Claude to update the README".into(),
        });
        check(RouteResult {
            target: "a".into(),
            confidence: 0.82,
            alternatives: vec!["b".into()],
        });
        check(SpanCreated {
            trace_id: "t".into(),
            span: json!({"kind": "shell"}),
        });
        check(ReceiptResult {
            trace_id: "t".into(),
            line: "✓ 4 files".into(),
            mismatches: vec![],
        });
        check(CursorMove {
            agent_id: "a".into(),
            from: p,
            to: Point { x: 10, y: 10 },
            style: "fitts".into(),
            label: "Claude · clicking Send".into(),
        });
        check(ShowmeState { recording: true });
        check(ShowmeStep {
            step: json!({"n": 1, "do": "click"}),
        });
        check(ShowmeStart {});
        check(ShowmeStop {});
        check(ComputerAction {
            session: "s".into(),
            tool: "click".into(),
            args_redacted: json!({"x": 1}),
            point: Some(p),
        });
        check(ComputerVerdict {
            verdict: Verdict::Deny,
            reason: Some("private window".into()),
        });
        check(ComputerPause {
            sessions: vec!["s".into()],
        });
        check(ComputerResume { sessions: vec![] });
    }

    #[test]
    fn partial_input_waits_for_more() {
        let bytes = encode(&Frame::Json(Envelope::wrap("1", &Ping {}))).unwrap();
        for cut in 0..bytes.len() {
            assert_eq!(decode(&bytes[..cut]).unwrap(), None, "cut at {cut}");
        }
        let mut two = bytes.clone();
        two.extend_from_slice(&bytes);
        let (_, used) = decode(&two).unwrap().unwrap();
        assert_eq!(used, bytes.len(), "one frame at a time");
    }

    #[test]
    fn bad_frames_are_refused_before_any_payload_is_read() {
        let mut huge = vec![0u8];
        huge.extend_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert_eq!(decode(&huge), Err(Error::TooLarge(MAX_FRAME + 1)));
        assert_eq!(decode(&[9, 0, 0, 0, 0]), Err(Error::UnknownFrameType(9)));
        assert!(matches!(
            decode(&[0, 2, 0, 0, 0, b'{', b'x']),
            Err(Error::BadJson(_))
        ));
        assert_eq!(
            decode(&[1, 0, 0, 0, 0]),
            Err(Error::BadLane),
            "a lane frame needs its id length"
        );
        assert_eq!(
            decode(&[1, 2, 0, 0, 0, 5, b'a']),
            Err(Error::BadLane),
            "id longer than the frame"
        );
        assert!(matches!(
            encode(&Frame::Lane {
                lane: "x".repeat(256),
                data: vec![]
            }),
            Err(Error::BadLane)
        ));
        assert!(matches!(
            encode(&Frame::Lane {
                lane: "l".into(),
                data: vec![0; MAX_FRAME]
            }),
            Err(Error::TooLarge(_))
        ));
    }

    #[test]
    fn open_checks_the_type_and_the_version() {
        let env = Envelope::wrap("1", &Ping {});
        assert!(matches!(
            env.open::<Pong>(),
            Err(Error::WrongType { want: "pong", .. })
        ));
        let old = Envelope { v: 1, ..env };
        assert_eq!(old.open::<Ping>(), Err(Error::WrongVersion(1)));
    }
}
