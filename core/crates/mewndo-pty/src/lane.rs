// The lane itself: one agent Mewndo started, in a terminal Mewndo owns (spec §33.10 Part G, §33.7).
//
// What owning the input stream buys, and why the whole of Part G exists (§33.7):
//
//   * a reply can be delivered at any time - ten minutes after the turn ended, or tomorrow - because there is
//     no reply window to miss. A hook's `Stop` window closes; a lane's keyboard does not.
//   * the brake is one byte, Ctrl+C, the same thing the user would press.
//   * the brief and a save point can be written in before the first prompt.
//
// Threading. A lane is two blocking handles and one reader thread, not an async task: the pty read is a
// blocking syscall on both platforms and `tokio::io` cannot poll a ConPTY handle. So the reader is a plain
// `std::thread` that pushes into the ring buffer and hands finished frames to a sink the core provides. The
// core keeps its own runtime and does not block on any of this.
//
// Locks. Three small mutexes rather than one big one, so replaying 256 KB into a reopened window cannot hold
// up a reply, and a reply cannot hold up the reader:
//
//   `ring`   the reader thread writes, the window reads
//   `writer` replies, the brake, and the first prompt
//   `child`  `try_wait`, `kill`
//
// The master pty is behind a mutex as well, even though `resize` and `get_size` take `&self`. The trait
// object is `Send` but not `Sync`, so a bare `Box<dyn MasterPty + Send>` would make the whole `Lane` not
// `Sync` -- and a `Lane` lives in an `Arc` shared by the reader thread, the window and the handlers. The lock
// is never held across a read or a write, only for the length of one resize call.

use crate::launch::{self, LaneSpec, LaunchError, Platform};
use crate::ring::Ring;
use crate::wire::{self, Resize};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Where a lane's output goes. The core implements this by publishing the frames to every connected app
/// (`desk.rs`); tests implement it by collecting them.
///
/// It is handed whole encoded frames, not bytes, because the alternative - a sink that takes bytes and does
/// its own framing - would mean every caller repeating the 8 MB split in `wire::frames`.
pub trait LaneSink: Send + Sync {
    /// One encoded `Frame::Lane`, ready to write to the pipe. Called from the reader thread, so it must not
    /// block for long and must not panic.
    fn frame(&self, lane_id: &str, frame: Vec<u8>);

    /// The child ended. The lane stays in the manager until the window is closed, so its last output can
    /// still be read.
    fn closed(&self, lane_id: &str, code: Option<u32>) {
        let _ = (lane_id, code);
    }
}

/// A sink that throws everything away: for a lane opened only to write into, and for tests that only care
/// about the ring buffer.
pub struct NoSink;

impl LaneSink for NoSink {
    fn frame(&self, _lane_id: &str, _frame: Vec<u8>) {}
}

/// How the reader thread reads: 64 KB at a time. Bigger than any single terminal write, small enough that a
/// chatty lane's output reaches the window promptly rather than in one lump at the end.
const READ_BUF: usize = 64 * 1024;

pub struct Lane {
    id: String,
    spec: LaneSpec,
    /// Shared with the reader thread. One buffer, not a copy: a window's replay has to see the bytes the
    /// reader has just written, not a snapshot that lags behind it.
    ring: Arc<Mutex<Ring>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    size: Mutex<Resize>,
    /// Set by the handlers when the agent's turn ends (Codex `notify`, Cursor `stop`, Claude `Stop`). It is
    /// *only* information for the Agents tab: nothing in `reply` reads it, which is what makes a reply ten
    /// minutes late no different from one sent straight away.
    turn_ended: AtomicBool,
    running: Arc<AtomicBool>,
}

// By hand, because a Lane owns the ConPTY handles and `portable-pty`'s traits are not Debug. Only the fields
// that identify a lane are printed: never the ring buffer, which holds whatever the agent put on the terminal.
impl std::fmt::Debug for Lane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lane")
            .field("id", &self.id)
            .field("spec", &self.spec)
            .field("running", &self.running.load(Ordering::Relaxed))
            .field("turn_ended", &self.turn_ended.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl Lane {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn spec(&self) -> &LaneSpec {
        &self.spec
    }

    /// The child's process id, for the Agents tab and for v0's own process tracking.
    pub fn pid(&self) -> Option<u32> {
        self.child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process_id()
    }

    /// False once the child has ended. The lane and its replay buffer outlive it.
    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn turn_ended(&self) -> bool {
        self.turn_ended.load(Ordering::SeqCst)
    }

    /// Called by the agent handlers when a turn finishes.
    pub fn set_turn_ended(&self, ended: bool) {
        self.turn_ended.store(ended, Ordering::SeqCst);
    }

    /// §33.10 Part G step 3: what a reopened lane window is shown before any live output.
    pub fn replay(&self) -> Vec<u8> {
        self.ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot()
    }

    /// The same, as encoded frames, which is what the window actually receives.
    pub fn replay_frames(&self) -> Vec<Vec<u8>> {
        wire::encoded(&self.id, &self.replay())
    }

    /// Total bytes the lane has produced, including those the ring has dropped.
    pub fn bytes_out(&self) -> u64 {
        self.ring
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .written()
    }

    /// Type a reply into the lane: the text, then Enter (§33.10 Part G step 2).
    ///
    /// No deadline, no window, no check on `turn_ended`. That is the §33.10 Part G "Done when" in one
    /// sentence: a reply sent ten minutes after the turn ended reaches the agent, because the only thing
    /// between this call and the agent's standard input is a write.
    pub fn reply(&self, text: &str) -> std::io::Result<()> {
        self.write(&wire::reply_bytes(text))
    }

    /// The brake (§24): Ctrl+C into the lane.
    pub fn brake(&self) -> std::io::Result<()> {
        self.write(&wire::brake_bytes())
    }

    /// Raw bytes, for the lane window's own keyboard: xterm.js sends what the user typed, unchanged.
    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut guard = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let writer = guard.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "this lane is closed")
        })?;
        writer.write_all(bytes)?;
        writer.flush()
    }

    /// An xterm.js `resize` event (§33.10 Part G step 2).
    pub fn resize(&self, size: Resize) -> std::io::Result<()> {
        let size = size.clamped();
        self.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        *self.size.lock().unwrap_or_else(|e| e.into_inner()) = size;
        Ok(())
    }

    /// The size this lane was last told about.
    pub fn size(&self) -> Resize {
        *self.size.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The size the kernel thinks the pty is, which is what the child sees. Only for tests and diagnostics:
    /// the lane window uses [`Lane::size`].
    pub fn kernel_size(&self) -> std::io::Result<Resize> {
        self.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_size()
            .map(|s| Resize {
                rows: s.rows,
                cols: s.cols,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Has the child ended, without blocking?
    pub fn exit_code(&self) -> Option<u32> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        match child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code()),
            _ => None,
        }
    }

    /// Close the input stream. A well-behaved agent sees end-of-input and exits; the replay buffer stays.
    pub fn close_input(&self) {
        *self.writer.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Last resort, for "close this lane" when the agent will not go.
    pub fn kill(&self) -> std::io::Result<()> {
        self.close_input();
        self.child.lock().unwrap_or_else(|e| e.into_inner()).kill()
    }

    /// Block until the child ends. Tests use it; the core never does.
    pub fn wait(&self) -> std::io::Result<u32> {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        child.wait().map(|s| s.exit_code())
    }
}

/// Every lane in this core, by id.
///
/// §33.7: "keeps the session alive even when the window is closed". So a lane leaves this map when it is
/// closed, not when its window is, and a reopened window finds the same `Arc<Lane>` and the same ring buffer.
#[derive(Default)]
pub struct Lanes {
    lanes: Mutex<HashMap<String, Arc<Lane>>>,
}

impl Lanes {
    pub fn new() -> Lanes {
        Lanes::default()
    }

    /// Start an agent in a new lane (§33.10 Part G step 1).
    ///
    /// `sink` is handed every frame of output from a thread this call starts.
    pub fn open(&self, spec: LaneSpec, sink: Arc<dyn LaneSink>) -> Result<Arc<Lane>, LaunchError> {
        let resolved = launch::resolve(&spec.program)?;
        let id = ulid::Ulid::new().to_string();
        let lane = Arc::new(start(&id, spec, &resolved, Platform::host(), sink)?);
        self.lanes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, lane.clone());
        Ok(lane)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Lane>> {
        self.lanes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .lanes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        ids.sort(); // ULIDs sort by the time they were made, so this is oldest lane first
        ids
    }

    pub fn len(&self) -> usize {
        self.lanes.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Close one lane for good: the agent is killed if it is still running, and the replay buffer goes.
    pub fn close(&self, id: &str) -> Option<Arc<Lane>> {
        let lane = self
            .lanes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)?;
        let _ = lane.kill();
        Some(lane)
    }

    /// Every lane, killed. The core calls this on shutdown so no agent outlives Mewndo.
    pub fn close_all(&self) {
        let lanes: Vec<Arc<Lane>> = self
            .lanes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, l)| l)
            .collect();
        for lane in lanes {
            let _ = lane.kill();
        }
    }
}

/// Open the terminal, spawn the child, start the reader thread.
///
/// Split out from `Lanes::open` and given the platform and the resolved path so a test can start a lane with
/// a chosen id and a chosen platform.
///
/// §32.5 rule 5 asks for ConPTY behind `cfg(windows)` with a stub elsewhere. `portable-pty` *is* that
/// boundary: `native_pty_system()` is ConPTY on Windows and `openpty(3)` on Unix, behind one API. Writing a
/// second stub here would mean no lane could open in WSL and the §33.10 Part G "Done when" - a reply ten
/// minutes after the turn ended reaching the agent - could never be tested at all. What is cfg-free instead
/// is every Windows-only *decision*: the `.cmd`/`.bat`/`.ps1` wrapper and the `.exe` lookup live in
/// `launch.rs` as pure functions that take the platform as an argument, so the Windows behaviour is checked
/// by `cargo test` in WSL. Honestly: ConPTY itself is only exercised when the tests run on Windows (CI, and
/// §32.5 rule 5's "every Done when check runs on Windows").
pub fn start(
    id: &str,
    spec: LaneSpec,
    resolved: &std::path::Path,
    platform: Platform,
    sink: Arc<dyn LaneSink>,
) -> Result<Lane, LaunchError> {
    let plan = launch::plan(&spec, resolved, id, platform);
    let size = Resize::default();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| LaunchError::Io(std::io::Error::other(e.to_string())))?;

    let mut cmd = CommandBuilder::new(&plan.program);
    cmd.args(&plan.args);
    cmd.cwd(&plan.cwd);
    // The agent's own environment is inherited: it needs PATH, HOME, its own API key file location and the
    // user's shell settings. Only the lane's own variables are added (§33.10 Part G step 1).
    for (key, value) in &plan.env {
        cmd.env(key, value);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| LaunchError::Io(std::io::Error::other(e.to_string())))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| LaunchError::Io(std::io::Error::other(e.to_string())))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| LaunchError::Io(std::io::Error::other(e.to_string())))?;
    // The slave handle is dropped here on purpose: while this process holds one, the pty never reports
    // end-of-file, so the reader thread would hang forever after the agent exited.
    drop(pair.slave);

    let ring = Arc::new(Mutex::new(Ring::default()));
    let running = Arc::new(AtomicBool::new(true));
    spawn_reader(id.to_string(), reader, ring.clone(), running.clone(), sink);
    Ok(Lane {
        id: id.to_string(),
        spec,
        ring,
        writer: Mutex::new(Some(writer)),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        size: Mutex::new(size),
        turn_ended: AtomicBool::new(false),
        running,
    })
}

/// Read until end of file, into the ring buffer and out as frames.
fn spawn_reader(
    id: String,
    mut reader: Box<dyn Read + Send>,
    ring: Arc<Mutex<Ring>>,
    running: Arc<AtomicBool>,
    sink: Arc<dyn LaneSink>,
) {
    std::thread::Builder::new()
        .name(format!("mewndo-lane-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        ring.lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(&buf[..n]);
                        for frame in wire::encoded(&id, &buf[..n]) {
                            sink.frame(&id, frame);
                        }
                    }
                    // A closed ConPTY reports an error rather than end of file; either way the lane's
                    // output is over.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            running.store(false, Ordering::SeqCst);
            sink.closed(&id, None);
        })
        .expect("a lane reader thread");
}
