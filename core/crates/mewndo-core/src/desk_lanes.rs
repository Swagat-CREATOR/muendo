// Lanes on the desk pipe (spec §33.7, §33.10 Part G): agents Mewndo starts in a terminal it owns, served to the
// apps over the same pipe as the Inbox.
//
//   lane.open   (app) -> mewndo-pty Lanes::open           -> lane.opened to every app (and as the reply)
//   lane.reply  (app) -> the text, then Enter, into the lane, at any time
//   lane.brake  (app) -> Ctrl+C into the lane
//   lane.resize (app) -> the terminal's size, clamped
//   lane.attach (app) -> the replay buffer as lane frames, then lane.opened, to that app only
//   lane.close  (app) -> the agent stopped and the lane removed     -> lane.closed {removed: true}
//   lane frame  (app) -> raw keystrokes from the lane window's terminal, written as they are
//   output            -> lane frames (type 1) to every app, on their own channel
//   agent ends        -> lane.closed {exit_code}
//
// Lane output has its own broadcast channel, not the desk's: a busy agent writes far more than the Inbox ever
// does, and on a shared channel a slow app falling behind on terminal output would also lose cards.
//
// Only the agents in `AGENTS` can be started. The pipe already admits only this user's processes, but "type this
// program name into a terminal" is the one message here that runs something, so it runs only what §33.7 names.
use crate::desk_agents::Publisher;
use crate::log::Log;
use mewndo_proto::{
    Envelope, Frame, LaneBrake, LaneClosed, LaneOpen, LaneOpened, LaneReply, LaneResize,
};
use mewndo_pty::{LaneSink, LaneSpec, Lanes, Resize};
use std::sync::{Arc, Weak};
use tokio::sync::broadcast;

/// What a lane may start (§33.7): the agents, by the names the user types.
pub const AGENTS: &[&str] = &["claude", "codex", "cursor-agent"];

pub struct DeskLanes {
    lanes: Arc<Lanes>,
    output: broadcast::Sender<Arc<Vec<u8>>>,
    publisher: Publisher,
    allowed: Vec<String>,
    log: Arc<Log>,
}

/// The reader thread's way out: frames to the output channel, the end to every app.
struct Sink {
    lanes: Weak<Lanes>,
    output: broadcast::Sender<Arc<Vec<u8>>>,
    publisher: Publisher,
    log: Arc<Log>,
}

impl LaneSink for Sink {
    fn frame(&self, _lane_id: &str, frame: Vec<u8>) {
        let _ = self.output.send(Arc::new(frame)); // no app connected: the ring buffer still has it
    }

    fn closed(&self, lane_id: &str, code: Option<u32>) {
        // mewndo-pty waits for the child to have really ended before calling this, so `code` is its own.
        let code = code.or_else(|| self.lanes.upgrade()?.get(lane_id)?.exit_code());
        self.log
            .info(&format!("lane {lane_id} ended (exit code {code:?})"));
        self.publisher.send(&LaneClosed {
            lane_id: lane_id.to_string(),
            exit_code: code,
            removed: false,
        });
    }
}

impl DeskLanes {
    pub fn new(publisher: Publisher, log: Arc<Log>) -> DeskLanes {
        DeskLanes {
            lanes: Arc::new(Lanes::new()),
            output: broadcast::channel(256).0,
            publisher,
            allowed: AGENTS.iter().map(|a| a.to_string()).collect(),
            log,
        }
    }

    /// Tests start `sh` and `cat` instead of an agent.
    #[cfg(test)]
    pub fn allowing(mut self, programs: &[&str]) -> DeskLanes {
        self.allowed = programs.iter().map(|p| p.to_string()).collect();
        self
    }

    /// Lane frames, for one app connection.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Vec<u8>>> {
        self.output.subscribe()
    }

    pub async fn open(&self, open: LaneOpen) -> Result<LaneOpened, String> {
        if !self.allowed.contains(&open.program) {
            return Err(format!(
                "a lane can only start {}, not {}",
                self.allowed.join(", "),
                open.program
            ));
        }
        let cwd = std::path::PathBuf::from(&open.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(format!("{} is not a folder", open.cwd));
        }
        let spec: LaneSpec = (&open).into();
        let sink = Arc::new(Sink {
            lanes: Arc::downgrade(&self.lanes),
            output: self.output.clone(),
            publisher: self.publisher.clone(),
            log: self.log.clone(),
        });
        // Finding the program and starting a terminal are blocking calls.
        let lanes = self.lanes.clone();
        let lane = tokio::task::spawn_blocking(move || lanes.open(spec, sink))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let opened = mewndo_pty::opened(&lane);
        self.log.info(&format!(
            "lane {} started: {} in {}",
            opened.lane_id, opened.program, opened.cwd
        ));
        self.publisher.send(&opened);
        Ok(opened)
    }

    fn lane(&self, id: &str) -> Result<Arc<mewndo_pty::Lane>, String> {
        self.lanes.get(id).ok_or_else(|| format!("no lane {id}"))
    }

    pub fn reply(&self, reply: &LaneReply) -> Result<(), String> {
        self.lane(&reply.lane_id)?
            .reply(&reply.text)
            .map_err(|e| e.to_string())
    }

    pub fn brake(&self, brake: &LaneBrake) -> Result<(), String> {
        self.lane(&brake.lane_id)?
            .brake()
            .map_err(|e| e.to_string())
    }

    pub fn resize(&self, resize: &LaneResize) -> Result<(), String> {
        let size = Resize {
            rows: resize.rows,
            cols: resize.cols,
        };
        self.lane(&resize.lane_id)?
            .resize(size.clamped())
            .map_err(|e| e.to_string())
    }

    /// Keystrokes from the lane window's terminal, as typed.
    pub fn write(&self, lane_id: &str, data: &[u8]) -> Result<(), String> {
        self.lane(lane_id)?.write(data).map_err(|e| e.to_string())
    }

    /// The replay buffer as lane frames, then `lane.opened`, as one run of bytes for one connection.
    pub fn attach(&self, lane_id: &str) -> Result<Vec<u8>, String> {
        let lane = self.lane(lane_id)?;
        let mut bytes: Vec<u8> = lane.replay_frames().concat();
        let opened = Envelope::wrap(ulid::Ulid::new().to_string(), &mewndo_pty::opened(&lane));
        bytes.extend(mewndo_proto::encode(&Frame::Json(opened)).map_err(|e| e.to_string())?);
        Ok(bytes)
    }

    pub fn close(&self, lane_id: &str) -> Result<(), String> {
        let lane = self
            .lanes
            .close(lane_id)
            .ok_or_else(|| format!("no lane {lane_id}"))?;
        self.log.info(&format!("lane {lane_id} closed"));
        self.publisher.send(&LaneClosed {
            lane_id: lane_id.to_string(),
            exit_code: lane.exit_code(),
            removed: true,
        });
        Ok(())
    }

    /// Every lane that exists, for an app that has just connected.
    pub fn all(&self) -> Vec<LaneOpened> {
        self.lanes
            .ids()
            .iter()
            .filter_map(|id| self.lanes.get(id))
            .map(|lane| mewndo_pty::opened(&lane))
            .collect()
    }

    /// On shutdown: no agent outlives the thing holding its brake (mewndo-pty, "What a lane cannot do").
    pub fn close_all(&self) {
        self.lanes.close_all();
    }
}
