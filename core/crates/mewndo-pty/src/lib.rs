//! ConPTY lanes: agents Mewndo starts and owns the input of (spec §33.10 Part G, §33.7).
//!
//! A **lane** is an agent that Mewndo started, inside a terminal Mewndo owns. The Agents tab calls that kind
//! of connection "Lane", as opposed to "Hooked" and "MCP" (§33.6), and the difference is one thing: because
//! Mewndo owns the input stream, it can type into the agent **at any time**. A hooked agent can only be
//! answered during its `Stop` reply window, which closes after 15 seconds. A lane has no window.
//!
//! ```text
//!   Lanes::open(spec, sink)
//!        |                        launch::resolve      which claude  ->  C:\npm\claude.cmd
//!        |                        launch::plan         .cmd  ->  cmd.exe /d /s /c "..."
//!        |                                             + MEWNDO_LANE_ID=<id>
//!        v
//!   +-- ConPTY (30 x 120) --------------------------------------------+
//!   |  the agent's process                                            |
//!   +-----------------------------------------------------------------+
//!        |  stdout/stderr                        ^  stdin
//!        v                                       |
//!   reader thread                            Lane::reply   "yes, carry on" + \r
//!    -> ring::Ring (256 KB)                  Lane::brake   \x03
//!    -> wire::frames  type 1, lane id, data  Lane::resize  master.resize
//!    -> LaneSink  (the core publishes them to every connected app)
//! ```
//!
//! ## What is pure, and what needs a terminal
//!
//! §32.5 rule 5 asks for Windows-only code behind `cfg(windows)`, with the logic left testable in WSL. Here
//! that line falls as:
//!
//! | Module | Platform | Covered by `cargo test` in WSL |
//! |---|---|---|
//! | [`ring`] | none | yes: the 256 KB buffer, byte for byte |
//! | [`wire`] | none | yes: framing, `\r`, `\x03`, the resize clamp |
//! | [`launch`] | takes [`launch::Platform`] as an argument | yes, *including* the Windows `.cmd`/`.bat`/`.ps1` decision |
//! | [`lane`] | `portable-pty`: ConPTY on Windows, `openpty(3)` elsewhere | yes, against `sh`, `cat` and `printenv` |
//!
//! There is deliberately **no** second `cfg(windows)` stub for [`lane`]. `portable-pty` is already that
//! boundary, and a stub would mean no lane could open in WSL, so the §33.10 Part G "Done when" could not be
//! tested here at all. See [`lane::start`] for the full note.
//!
//! ## What a lane cannot do, honestly (§28.10)
//!
//! * **It reads a terminal, it does not understand one.** The output is raw bytes, replayed into xterm.js.
//!   Nothing here knows whether the agent is at a prompt, mid-answer or showing a menu, so a reply typed at
//!   the wrong moment is typed at the wrong moment, exactly as if the user had pressed the keys. Structured
//!   events need the ACP mode §33.7 leaves for later.
//! * **ConPTY itself is only exercised on Windows.** Every test in this crate runs on a Unix pty in WSL. The
//!   `.cmd` wrapping decision is tested, the `.cmd` *start* is not.
//! * **A lane does not survive Mewndo.** [`lane::Lanes::close_all`] kills every child on shutdown: an agent
//!   that outlived the thing holding its brake would be worse than no lane.
//! * **The replay buffer is memory only.** Close the lane, or restart the core, and the 256 KB is gone.

pub mod lane;
pub mod launch;
pub mod ring;
pub mod wire;

pub use lane::{Lane, LaneSink, Lanes, NoSink};
pub use launch::{LANE_ID_ENV, LaneSpec, LaunchError, LaunchPlan, Platform, Wrapper};
pub use ring::{CAPACITY, Ring};
pub use wire::{BRAKE, Resize, brake_bytes, reply_bytes};

use serde::{Deserialize, Serialize};

// --- the control messages the app and the core exchange about a lane ---------------------------------------
//
// Lane *output* is `Frame::Lane` (type 1) and is already in mewndo-proto. Lane *control* is not: §38.5's
// message list has no lane messages in it, and mewndo-proto belongs to Part A. So the five bodies live here,
// shaped exactly as they would be as `impl Body for ..` once Part A adds the type names. Their `type` strings
// are in the constants below, so moving them costs one line each and no renaming.
//
// Reported to the Part A owner rather than added to mewndo-proto by this session (§32.5 rule 1: a contract
// change goes in mewndo-proto first, and only its owner may make it).

/// app -> core: "start Claude in shop" (§33.7).
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

/// core -> app: the lane is open, with what a reopened window needs to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneOpened {
    pub lane_id: String,
    pub program: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
}

/// app -> core: type this into the lane, at any time (§33.7).
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

/// app -> core: an xterm.js `resize` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneResize {
    pub lane_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// core -> app: the agent ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneClosed {
    pub lane_id: String,
    pub exit_code: Option<u32>,
}

/// The `type` names these bodies will carry once mewndo-proto has them.
pub mod message_types {
    pub const OPEN: &str = "lane.open";
    pub const OPENED: &str = "lane.opened";
    pub const REPLY: &str = "lane.reply";
    pub const BRAKE: &str = "lane.brake";
    pub const RESIZE: &str = "lane.resize";
    pub const CLOSED: &str = "lane.closed";
}

impl From<&LaneOpen> for LaneSpec {
    fn from(open: &LaneOpen) -> LaneSpec {
        LaneSpec {
            program: open.program.clone(),
            args: open.args.clone(),
            cwd: std::path::PathBuf::from(&open.cwd),
            env: open.env.clone(),
        }
    }
}

impl LaneOpened {
    pub fn of(lane: &Lane) -> LaneOpened {
        let size = lane.size();
        LaneOpened {
            lane_id: lane.id().to_string(),
            program: lane.spec().program.clone(),
            cwd: lane.spec().cwd.to_string_lossy().to_string(),
            pid: lane.pid(),
            rows: size.rows,
            cols: size.cols,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_control_messages_round_trip_as_json() {
        let open = LaneOpen {
            program: "claude".into(),
            args: vec!["--continue".into()],
            cwd: r"C:\work\shop".into(),
            env: vec![("MEWNDO_BRIEF".into(), "brief.md".into())],
        };
        let text = serde_json::to_string(&open).unwrap();
        assert_eq!(serde_json::from_str::<LaneOpen>(&text).unwrap(), open);
        // args and env are optional: "start Claude in shop" sends neither.
        let minimal: LaneOpen =
            serde_json::from_str(r#"{"program":"codex","cwd":"/work/shop"}"#).unwrap();
        assert_eq!(minimal.args, Vec::<String>::new());
        assert_eq!(minimal.env, Vec::<(String, String)>::new());

        let reply = LaneReply {
            lane_id: "01JLANE".into(),
            text: "yes, carry on".into(),
        };
        assert_eq!(
            serde_json::from_str::<LaneReply>(&serde_json::to_string(&reply).unwrap()).unwrap(),
            reply
        );
    }

    #[test]
    fn a_lane_open_becomes_a_lane_spec_unchanged() {
        let open = LaneOpen {
            program: "cursor-agent".into(),
            args: vec!["chat".into()],
            cwd: "/work/shop".into(),
            env: vec![],
        };
        let spec: LaneSpec = (&open).into();
        assert_eq!(spec.program, "cursor-agent");
        assert_eq!(spec.args, ["chat"]);
        assert_eq!(spec.cwd, std::path::PathBuf::from("/work/shop"));
    }
}
