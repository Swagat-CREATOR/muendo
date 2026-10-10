// §36.6 U5: the proxy's question to the core, "may this happen?", over the desk pipe as a `computer` connection:
// `hello {role: computer}`, `computer.action` (redacted, redact.rs), then wait for `computer.verdict`.
//
// The core is the gate (mewndo-core `computer.rs`): it knows whether computer use is switched on, whether the user
// has taken over the mouse (U6), what the Router's rules say, and it is the one that can put a card in front of
// the user and wait for the answer.
//
// Fails closed, unlike the hooks (§38.4 "Fail open"): no core, no answer in time, or a reply that is not a verdict
// all refuse the act. A hook that cannot reach Mewndo lets the agent edit files Mewndo can still restore; a click
// that cannot be checked has no undo at all.

use crate::classify::Class;
use crate::proxy::Gate;
use crate::redact::{point, redact};
use mewndo_proto::{
    ComputerAction, ComputerVerdict, Envelope, Frame, Hello, Role, Verdict, decode, encode,
};
use rmcp::model::JsonObject;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

/// Where the running core's `core.json` is: `MEWNDO_DESK_DIR`, else `%LOCALAPPDATA%\Mewndo` (the hook
/// forwarder's rule, shared).
pub use mewndo_hook::pipe::desk_dir;

/// How long one act may wait for the user's answer. Matches the hooks' permission wait (§33.9), less a margin.
pub const ANSWER_WAIT: Duration = Duration::from_secs(290);

/// A core that sends this many frames that are not the answer is confused, and the act is refused.
const MAX_FRAMES: usize = 64;

pub struct CoreGate {
    /// The desk folder holding `core.json` (mewndo-hook's `desk_dir`, or `MEWNDO_DESK_DIR`).
    pub desk_dir: Option<PathBuf>,
    pub agent: String,
    pub wait: Duration,
}

impl Gate for CoreGate {
    async fn check(&self, tool: &str, _class: Class, args: &JsonObject) -> Result<(), String> {
        let action = ComputerAction {
            session: args
                .get("session")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string(),
            tool: tool.to_string(),
            args_redacted: redact(args),
            point: point(args),
            agent: self.agent.clone(),
        };
        let dir = self.desk_dir.clone();
        let ask = tokio::task::spawn_blocking(move || {
            let dir = dir.ok_or("Mewndo is not running")?;
            let pipe = mewndo_hook::pipe::pipe_name(&dir).ok_or("Mewndo is not running")?;
            let mut stream = mewndo_hook::pipe::connect(&pipe)
                .map_err(|_| "Mewndo is not running".to_string())?;
            exchange(&mut stream, &action)
        });
        // ponytail: on a timeout the blocking thread stays until the core answers or the pipe closes; it holds
        // one connection and nothing else.
        let verdict = match tokio::time::timeout(self.wait, ask).await {
            Ok(Ok(result)) => result?,
            Ok(Err(e)) => return Err(format!("Mewndo could not check this: {e}")),
            Err(_) => return Err("nobody answered in time".into()),
        };
        match verdict.verdict {
            Verdict::Allow => Ok(()),
            Verdict::Deny => Err(verdict.reason.unwrap_or_else(|| "the user said no".into())),
        }
    }
}

/// One `computer.action` and its verdict, on an open connection to the core.
pub fn exchange<S: Read + Write>(
    stream: &mut S,
    action: &ComputerAction,
) -> Result<ComputerVerdict, String> {
    let wrap = |id: &str, frame: Frame| encode(&frame).map_err(|e| format!("{id}: {e}"));
    let mut out = wrap(
        "hello",
        Frame::Json(Envelope::wrap(
            "hello",
            &Hello {
                role: Role::Computer,
            },
        )),
    )?;
    out.extend(wrap(
        "action",
        Frame::Json(Envelope::wrap("action", action)),
    )?);
    let lost = |_| "Mewndo stopped answering".to_string();
    stream.write_all(&out).map_err(lost)?;
    stream.flush().map_err(lost)?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut frames = 0;
    loop {
        while let Some((frame, used)) =
            decode(&buf).map_err(|e| format!("Mewndo sent something unreadable: {e}"))?
        {
            buf.drain(..used);
            frames += 1;
            if frames > MAX_FRAMES {
                return Err("Mewndo did not answer".into());
            }
            let Frame::Json(env) = frame else { continue };
            match env.kind.as_str() {
                "computer.verdict" => {
                    return env.open::<ComputerVerdict>().map_err(|e| e.to_string());
                }
                "error" => {
                    let why = env.body["message"]
                        .as_str()
                        .unwrap_or("an error")
                        .to_string();
                    return Err(format!("Mewndo refused the check: {why}"));
                }
                _ => {} // the hello's pong
            }
        }
        let n = stream.read(&mut chunk).map_err(lost)?;
        if n == 0 {
            return Err("Mewndo stopped answering".into());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::Pong;

    /// A connection with the core's side scripted: `replies` is what the core sends, `sent` what it received.
    struct Script {
        replies: std::io::Cursor<Vec<u8>>,
        sent: Vec<u8>,
    }

    impl Read for Script {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.replies.read(buf)
        }
    }
    impl Write for Script {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.sent.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn script(frames: Vec<Frame>) -> Script {
        let replies = frames.iter().flat_map(|f| encode(f).unwrap()).collect();
        Script {
            replies: std::io::Cursor::new(replies),
            sent: Vec::new(),
        }
    }

    fn action() -> ComputerAction {
        ComputerAction {
            session: "s".into(),
            tool: "type_text".into(),
            args_redacted: serde_json::json!({"text": "<5 characters>"}),
            point: None,
            agent: "claude".into(),
        }
    }

    #[test]
    fn hello_then_the_action_then_the_verdict() {
        let verdict = ComputerVerdict {
            verdict: Verdict::Deny,
            reason: Some("the user said no".into()),
        };
        let mut s = script(vec![
            Frame::Json(Envelope::wrap("hello", &Pong {})),
            Frame::Json(Envelope::wrap("action", &verdict)),
        ]);
        assert_eq!(exchange(&mut s, &action()), Ok(verdict));
        let (first, used) = decode(&s.sent).unwrap().unwrap();
        let Frame::Json(hello) = first else { panic!() };
        assert_eq!(hello.open::<Hello>().unwrap().role, Role::Computer);
        let Frame::Json(sent) = decode(&s.sent[used..]).unwrap().unwrap().0 else {
            panic!()
        };
        assert_eq!(sent.open::<ComputerAction>().unwrap(), action());
    }

    #[test]
    fn an_error_or_a_closed_pipe_is_a_refusal() {
        let mut s = script(vec![Frame::Json(Envelope::wrap(
            "action",
            &mewndo_proto::ErrorBody {
                message: "unknown message type".into(),
            },
        ))]);
        assert!(
            exchange(&mut s, &action())
                .unwrap_err()
                .contains("unknown message type")
        );
        let mut s = script(vec![Frame::Json(Envelope::wrap("hello", &Pong {}))]);
        assert_eq!(
            exchange(&mut s, &action()),
            Err("Mewndo stopped answering".into())
        );
    }

    #[tokio::test]
    async fn no_core_means_no_act() {
        let dir =
            std::env::temp_dir().join(format!("mewndo-computer-nocore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let gate = CoreGate {
            desk_dir: Some(dir.clone()),
            agent: "claude".into(),
            wait: Duration::from_secs(5),
        };
        assert_eq!(
            gate.check("click", Class::Act, &JsonObject::new()).await,
            Err("Mewndo is not running".into())
        );
        let none = CoreGate {
            desk_dir: None,
            agent: "claude".into(),
            wait: Duration::from_secs(5),
        };
        assert!(
            none.check("get_screen_size", Class::Read, &JsonObject::new())
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
