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

// --- the control messages the app and the core exchange about a lane ---------------------------------------
//
// Lane *output* is `Frame::Lane` (type 1); lane *control* is the `lane.*` bodies in mewndo-proto, re-exported here
// so a caller of this crate has one place to look. The core serves them on the desk pipe (mewndo-core
// `desk_lanes.rs`).

pub use mewndo_proto::{
    LaneAttach, LaneBrake, LaneClose, LaneClosed, LaneOpen, LaneOpened, LaneReply, LaneResize,
};

/// The `type` names the lane bodies carry (`mewndo_proto::Body::TYPE`).
pub mod message_types {
    use mewndo_proto::Body;
    pub const OPEN: &str = super::LaneOpen::TYPE;
    pub const OPENED: &str = super::LaneOpened::TYPE;
    pub const REPLY: &str = super::LaneReply::TYPE;
    pub const BRAKE: &str = super::LaneBrake::TYPE;
    pub const RESIZE: &str = super::LaneResize::TYPE;
    pub const ATTACH: &str = super::LaneAttach::TYPE;
    pub const CLOSE: &str = super::LaneClose::TYPE;
    pub const CLOSED: &str = super::LaneClosed::TYPE;
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

/// What `lane.opened` says about a lane right now.
pub fn opened(lane: &Lane) -> LaneOpened {
    let size = lane.size();
    LaneOpened {
        lane_id: lane.id().to_string(),
        program: lane.spec().program.clone(),
        cwd: lane.spec().cwd.to_string_lossy().to_string(),
        pid: lane.pid(),
        rows: size.rows,
        cols: size.cols,
        running: lane.running(),
        exit_code: lane.exit_code(),
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
