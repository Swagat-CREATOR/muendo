// mewndo-hook: the hook forwarder (spec §33.10 Part B, §38.4, §38.5).
//
// One job, done in a few milliseconds: take one agent hook payload, hand it to mewndo-core over the v2 pipe,
// print the core's answer exactly and exit with its code. When the core is not there, answer from the deny
// cache alone and otherwise say nothing at all (§33.10 B5).
//
// The whole crate is std only with no async runtime. §38.1 chose Rust here because this binary runs on every
// agent action and a Rust process starts in a few ms where a Node script takes 50; a runtime would add thread
// spawns and a reactor to a program that opens exactly one connection.
//
// Why a library and not just a `main`: `run` returns what to print instead of printing it, so every branch --
// the happy path, a refused request, a missing core, a protected path in the deny cache -- is a value a test
// can assert on. main.rs is the only place that touches stdout or the exit code.
pub mod args;
pub mod failopen;
pub mod pipe;

use args::Args;
use mewndo_proto::{HookRequest, HookResponse};
use serde_json::Value;

/// What the forwarder prints, and the code it exits with. `stdout` goes out byte for byte: §33.10 B3 says
/// "print its `stdout` exactly", and the agents parse it as JSON, so not one added newline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub stdout: String,
    pub exit_code: i32,
}

impl Outcome {
    /// Fail open (§32.5 rule 7): no output, exit 0, so the agent behaves exactly as if Mewndo were not
    /// installed. This is the answer to every failure that is not a cached protected path.
    pub fn silent() -> Outcome {
        Outcome {
            stdout: String::new(),
            exit_code: 0,
        }
    }
}

/// How much of an unparsable input is still worth sending to the core.
///
/// `hook.request.payload` is a `Value`, so a payload that is not JSON -- a truncated one, because of the 4 MB
/// cap in B1, or an agent that sends plain text -- travels as a JSON *string* instead: lossless for the
/// normal case and unmistakable for the core's handlers. The prefix cap matters because JSON escaping can
/// multiply a byte by six (`\u0000`), and 4 MB of escapes would be over mewndo-proto's 8 MB frame limit; the
/// frame would be refused and the event lost, which is worse than a truncated one.
pub const UNPARSED_KEEP: usize = 64 * 1024;

/// The agent's raw hook JSON, passed through untouched (§38.5: "payload (raw hook JSON)").
///
/// Nothing here looks at a field name. §32.5 rule 2 forbids coding against payload shapes that have not been
/// captured, and the forwarder never needs to: it is a pipe, not a parser. The one exception is `session_id`,
/// which §38.5 lists on `hook.request` itself -- see `request`.
pub fn payload_of(input: &[u8]) -> Value {
    if input.is_empty() {
        return Value::Null;
    }
    match serde_json::from_slice::<Value>(input) {
        Ok(v) => v,
        Err(_) => {
            let keep = &input[..input.len().min(UNPARSED_KEEP)];
            Value::String(String::from_utf8_lossy(keep).into_owned())
        }
    }
}

/// §33.10 B3: `hook.request {agent, event, pid, cwd, lane_id, payload}`.
pub fn request(args: &Args, payload: Value) -> HookRequest {
    HookRequest {
        agent: args.agent.clone(),
        event: args.event.clone(),
        // §38.5 lists session_id on hook.request but B3's field list does not, and only the agent knows it,
        // so it is read from the payload when the payload happens to carry a string under that name and left
        // as None otherwise. It is a hint for the core, never a key: `Option<String>` either way.
        session_id: payload
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        // The agent's own process is the hook's parent, so this is the forwarder's pid, not the agent's. The
        // core uses it to tie an event to a connection; §38.6's `agents.pid` is set from the agent handlers.
        pid: Some(std::process::id()),
        // The project folder: agents run their hooks in it, and the core needs it to find the brief and the
        // protected folder an action belongs to (§34).
        cwd: std::env::current_dir()
            .ok()
            .map(|d| d.to_string_lossy().into_owned()),
        // Set by the core when it starts an agent inside a Mewndo lane (§33.10 Part G), so the core can tell
        // a lane's events from a terminal the user started themselves.
        lane_id: std::env::var("MEWNDO_LANE_ID")
            .ok()
            .filter(|v| !v.is_empty()),
        payload,
    }
}

/// The happy path (§33.10 B2 and B3): find the core, open the pipe, hello, request, answer.
///
/// Every failure is an `Err` for the caller to fail open on -- there is no error path that prints or exits.
pub fn forward(args: &Args, payload: &Value) -> std::io::Result<HookResponse> {
    let missing = |what: &str| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("{what}: the core is not running"),
        )
    };
    let dir = pipe::desk_dir().ok_or_else(|| missing("no Mewndo data folder"))?;
    let name = pipe::pipe_name(&dir).ok_or_else(|| missing("no core.json"))?;
    let mut connection = pipe::connect(&name)?;
    pipe::round_trip(&mut connection, &request(args, payload.clone()))
}

/// The whole job. Never fails, because there is no failure an agent should ever see from Mewndo.
pub fn run(args: &Args, input: &[u8]) -> Outcome {
    let payload = payload_of(input);
    match forward(args, &payload) {
        Ok(response) => Outcome {
            stdout: response.stdout,
            // The core's code, passed through: 0 to carry on, 2 to block with the stdout JSON, whatever a
            // future handler needs. The forwarder has no opinion about it.
            exit_code: response.exit_code,
        },
        // A missing folder, a missing core.json, a missing pipe, a refused request, a dropped connection:
        // all one case. §33.10 B5 decides what to answer, and it is the only code path allowed to print
        // anything the core did not send.
        Err(_) => failopen::answer(args, &payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(agent: &str, event: &str) -> Args {
        Args {
            agent: agent.into(),
            event: event.into(),
            rest: Vec::new(),
            dump: false,
        }
    }

    #[test]
    fn the_payload_is_the_agents_json_untouched() {
        let raw = br#"{"tool_name":"Bash","tool_input":{"command":"ls -l"},"session_id":"s1"}"#;
        let p = payload_of(raw);
        assert_eq!(p["tool_input"]["command"], "ls -l");
        let req = request(&args("claude", "pre-tool"), p);
        assert_eq!(
            (req.agent.as_str(), req.event.as_str()),
            ("claude", "pre-tool")
        );
        assert_eq!(req.session_id.as_deref(), Some("s1"));
        assert_eq!(req.pid, Some(std::process::id()));
        assert!(req.cwd.is_some(), "the project folder the agent ran in");
    }

    #[test]
    fn an_empty_or_unparsable_input_still_travels() {
        assert_eq!(payload_of(b""), Value::Null);
        // Truncated JSON (the 4 MB cap) keeps its bytes as a string rather than losing the event.
        assert_eq!(
            payload_of(br#"{"tool_name":"Bash""#),
            Value::String(r#"{"tool_name":"Bash""#.into())
        );
        // Invalid UTF-8 is replaced, not refused.
        assert_eq!(
            payload_of(&[0xff, 0xfe]),
            Value::String("\u{fffd}\u{fffd}".into())
        );
        // Over the keep limit, so the JSON string can never outgrow proto's 8 MB frame.
        let huge = vec![b'"'; UNPARSED_KEEP * 2];
        let Value::String(s) = payload_of(&huge) else {
            panic!("a wall of quotes is not JSON")
        };
        assert_eq!(s.len(), UNPARSED_KEEP);
        // A payload with no session_id leaves the field alone.
        assert_eq!(
            request(&args("codex", "notify"), payload_of(b"[]")).session_id,
            None
        );
    }

    #[test]
    fn with_no_core_the_answer_is_silence_and_exit_0() {
        // `post-tool` is not a pre-action event, so this is silence whatever this machine happens to have in
        // its deny cache -- the cache paths are covered by failopen.rs's own tests and tests/forwarder.rs,
        // which point a child forwarder at a temporary folder instead of reading the real one.
        let out = run(&args("claude", "post-tool"), br#"{"tool_name":"Read"}"#);
        assert_eq!(out, Outcome::silent());
        assert_eq!((out.stdout.as_str(), out.exit_code), ("", 0));
    }
}
