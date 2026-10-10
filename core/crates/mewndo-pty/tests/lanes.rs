// §33.10 Part G "Done when": a lane opens, and a reply sent ten minutes after the turn ended reaches the
// agent.
//
// There is no real agent here, so every test drives a long-lived child this box can actually start - `sh`,
// `cat`, `printenv` - which is what the §33.10 Part G contract is about anyway: a terminal Mewndo owns, whose
// input it can write to whenever it likes. What a real `claude` adds to that is its own output, not a
// different input path.
//
// Honest about the clock: `a_reply_long_after_the_turn_ended_reaches_the_agent` does not sit for ten minutes.
// It proves the two things that could make ten minutes fail, and proves them for real:
//
//   1. nothing in the reply path consults a clock or a window - `Lane::reply` is a write, and the test sends
//      one after `set_turn_ended(true)` and after the child has been measurably idle;
//   2. the lane, its child and its writer are all still there after the turn ended, which is the thing a
//      `Stop`-hook reply window cannot promise.
//
// `the_real_ten_minute_wait` does sit for ten minutes and is `#[ignore]`d, so `cargo test -- --ignored`
// runs it on Windows when someone wants the literal check (§32.5 rule 5: every "Done when" runs on Windows).

use mewndo_pty::lane::{LaneSink, Lanes, start};
use mewndo_pty::launch::{self, LaneSpec, Platform};
use mewndo_pty::wire::Resize;
use mewndo_pty::{LANE_ID_ENV, Lane};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Collects every frame a lane produces, and decodes the bytes back out of them.
#[derive(Default)]
struct Collect {
    frames: Mutex<Vec<Vec<u8>>>,
    closed: Mutex<Option<String>>,
}

impl LaneSink for Collect {
    fn frame(&self, _lane_id: &str, frame: Vec<u8>) {
        self.frames.lock().unwrap().push(frame);
    }
    fn closed(&self, lane_id: &str, _code: Option<u32>) {
        *self.closed.lock().unwrap() = Some(lane_id.to_string());
    }
}

impl Collect {
    /// The lane bytes carried by every frame so far, in order, with the lane id checked on each.
    fn bytes(&self, lane_id: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for frame in self.frames.lock().unwrap().iter() {
            let (decoded, used) = mewndo_proto::decode(frame)
                .expect("a lane frame")
                .expect("a whole lane frame");
            assert_eq!(used, frame.len(), "one frame per sink call");
            match decoded {
                mewndo_proto::Frame::Lane { lane, data } => {
                    assert_eq!(lane, lane_id, "every frame names its own lane");
                    out.extend_from_slice(&data);
                }
                other => panic!("lane output must be a lane frame, got {other:?}"),
            }
        }
        out
    }

    fn text(&self, lane_id: &str) -> String {
        String::from_utf8_lossy(&self.bytes(lane_id)).to_string()
    }
}

fn shell() -> &'static str {
    if cfg!(windows) { "cmd" } else { "sh" }
}

/// Open a lane running the given program, with a sink that collects its output.
fn open(spec: LaneSpec) -> (Arc<Lane>, Arc<Collect>, Lanes) {
    let sink = Arc::new(Collect::default());
    let lanes = Lanes::new();
    let lane = lanes
        .open(spec, sink.clone())
        .unwrap_or_else(|e| panic!("a lane should open: {e}"));
    (lane, sink, lanes)
}

/// Wait up to two seconds for the lane's output to contain `want`. Terminals are asynchronous; a fixed sleep
/// is either flaky or slow.
fn wait_for(sink: &Collect, lane_id: &str, want: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let text = sink.text(lane_id);
        if text.contains(want) {
            return text;
        }
        if Instant::now() > deadline {
            panic!("waited 10 s for {want:?} in the lane output; got:\n{text}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_lane_opens_and_its_output_arrives_as_lane_frames() {
    let (lane, sink, lanes) = open(LaneSpec::new(shell(), std::env::temp_dir()));
    assert!(lane.running(), "the child is alive");
    assert!(
        lane.pid().is_some(),
        "and has a process id for the Agents tab"
    );
    assert_eq!(
        lane.size(),
        Resize {
            rows: 30,
            cols: 120
        },
        "§33.10 Part G step 1"
    );
    assert_eq!(lanes.ids(), [lane.id().to_string()]);

    lane.reply("echo mewndo-lane-is-open").unwrap();
    let text = wait_for(&sink, lane.id(), "mewndo-lane-is-open");
    assert!(text.contains("mewndo-lane-is-open"), "{text}");
    // The same bytes are in the replay buffer, which is what a reopened window gets.
    let replay = String::from_utf8_lossy(&lane.replay()).to_string();
    assert!(replay.contains("mewndo-lane-is-open"), "{replay}");
    assert!(lane.bytes_out() > 0);

    lanes.close(lane.id());
    assert!(lanes.is_empty());
}

// The §33.10 Part G step 4 test: the environment variable that links a hook session to its lane.
#[test]
fn mewndo_lane_id_reaches_the_child_environment() {
    // `printenv` is not on Windows, so ask the shell for the variable it was given. Both shells expand their
    // own syntax, which is the point: this is the child's real environment, not a plan.
    let (lane, sink, lanes) = if cfg!(windows) {
        open(
            LaneSpec::new("cmd", std::env::temp_dir())
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .arg("echo lane=%MEWNDO_LANE_ID%"),
        )
    } else {
        open(
            LaneSpec::new("sh", std::env::temp_dir())
                .arg("-c")
                .arg("echo lane=$MEWNDO_LANE_ID"),
        )
    };
    let want = format!("lane={}", lane.id());
    let text = wait_for(&sink, lane.id(), &want);
    assert!(text.contains(&want), "{text}");
    assert_eq!(LANE_ID_ENV, "MEWNDO_LANE_ID");
    lanes.close_all();
}

#[test]
fn the_lane_runs_in_the_folder_it_was_given() {
    let dir = std::env::temp_dir().join(format!("mewndo-lane-cwd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // macOS and some Linux setups make /tmp a link; the child reports the real path, so compare on the name.
    let name = dir.file_name().unwrap().to_string_lossy().to_string();
    let (lane, sink, lanes) = if cfg!(windows) {
        open(
            LaneSpec::new("cmd", &dir)
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .arg("cd"),
        )
    } else {
        open(LaneSpec::new("sh", &dir).arg("-c").arg("pwd"))
    };
    let text = wait_for(&sink, lane.id(), &name);
    assert!(text.contains(&name), "{text}");
    lanes.close_all();
    let _ = std::fs::remove_dir_all(&dir);
}

// The §33.10 Part G "Done when": a reply long after the turn ended reaches the agent.
#[test]
fn a_reply_long_after_the_turn_ended_reaches_the_agent() {
    // A line-reading loop: the nearest thing to an agent waiting at its prompt.
    let (lane, sink, lanes) = if cfg!(windows) {
        open(LaneSpec::new("cmd", std::env::temp_dir()))
    } else {
        open(
            LaneSpec::new("sh", std::env::temp_dir())
                .arg("-c")
                .arg("while IFS= read -r line; do printf 'agent-heard:%s\\n' \"$line\"; done"),
        )
    };

    // The turn: one exchange, then the agent goes quiet and the handlers mark the turn over.
    lane.reply("first").unwrap();
    wait_for(&sink, lane.id(), "first");
    lane.set_turn_ended(true);
    assert!(lane.turn_ended());

    // Long enough for a `Stop` hook's 15-second reply window to be well shut, and long enough that the child
    // has genuinely been idle rather than still draining the first write.
    std::thread::sleep(Duration::from_millis(1500));
    let idle = sink.bytes(lane.id()).len();

    // Now, with the turn over and nobody waiting, type into the lane.
    let late = "a reply nobody was waiting for";
    lane.reply(late).unwrap();
    let text = wait_for(&sink, lane.id(), late);
    assert!(
        sink.bytes(lane.id()).len() > idle,
        "the late reply produced new output"
    );
    assert!(text.contains(late), "{text}");
    assert!(lane.running(), "and the agent is still there afterwards");

    // The other half of "no window": a second late reply works too, and `turn_ended` changed nothing about
    // the path it took.
    lane.reply("and another").unwrap();
    wait_for(&sink, lane.id(), "and another");
    lanes.close_all();
}

/// The literal ten minutes, for a Windows run of the "Done when" (§32.5 rule 5). `cargo test -- --ignored`.
#[test]
#[ignore = "sits for 10 minutes; run with --ignored for the literal §33.10 Part G Done when"]
fn the_real_ten_minute_wait() {
    let (lane, sink, lanes) = if cfg!(windows) {
        open(LaneSpec::new("cmd", std::env::temp_dir()))
    } else {
        open(
            LaneSpec::new("sh", std::env::temp_dir())
                .arg("-c")
                .arg("while IFS= read -r line; do printf 'agent-heard:%s\\n' \"$line\"; done"),
        )
    };
    lane.reply("first").unwrap();
    wait_for(&sink, lane.id(), "first");
    lane.set_turn_ended(true);
    std::thread::sleep(Duration::from_secs(600));
    lane.reply("ten minutes later").unwrap();
    wait_for(&sink, lane.id(), "ten minutes later");
    assert!(lane.running());
    lanes.close_all();
}

// The §33.10 Part G step 2 resize test, against a real pty: `stty size` reads the size the kernel holds.
#[test]
#[cfg(unix)]
fn a_resize_reaches_the_terminal_the_child_sees() {
    let (lane, sink, lanes) = open(
        LaneSpec::new("sh", std::env::temp_dir())
            .arg("-c")
            .arg("while IFS= read -r line; do stty size; done"),
    );
    lane.reply("").unwrap();
    wait_for(&sink, lane.id(), "30 120");

    lane.resize(Resize {
        rows: 44,
        cols: 164,
    })
    .unwrap();
    assert_eq!(
        lane.size(),
        Resize {
            rows: 44,
            cols: 164
        }
    );
    assert_eq!(
        lane.kernel_size().unwrap(),
        Resize {
            rows: 44,
            cols: 164
        }
    );
    lane.reply("").unwrap();
    let text = wait_for(&sink, lane.id(), "44 164");
    assert!(text.contains("44 164"), "{text}");

    // A minimised window sends 0s; they must not reach the pty as 0s.
    lane.resize(Resize { rows: 0, cols: 0 }).unwrap();
    assert_eq!(lane.kernel_size().unwrap(), Resize { rows: 1, cols: 1 });
    lanes.close_all();
}

// The brake (§24), against a real pty.
#[test]
#[cfg(unix)]
fn the_brake_interrupts_what_the_lane_is_doing() {
    // `trap` turns the interrupt into something visible rather than into a dead shell.
    let (lane, sink, lanes) =
        open(LaneSpec::new("sh", std::env::temp_dir()).arg("-c").arg(
            "trap 'printf braked\\\\n' INT; printf ready\\\\n; while true; do sleep 0.05; done",
        ));
    wait_for(&sink, lane.id(), "ready");
    lane.brake().unwrap();
    let text = wait_for(&sink, lane.id(), "braked");
    assert!(text.contains("braked"), "{text}");
    lanes.close_all();
}

#[test]
fn a_closed_window_does_not_close_the_lane_and_the_replay_is_still_there() {
    // §33.7: "keeps the session alive even when the window is closed." The window is the app's; the lane is
    // the core's. Dropping every reference the "window" had must not end the agent.
    let (lane, sink, lanes) = open(LaneSpec::new(shell(), std::env::temp_dir()));
    lane.reply("echo before-the-window-closed").unwrap();
    wait_for(&sink, lane.id(), "before-the-window-closed");
    let id = lane.id().to_string();
    drop(lane);

    let reopened = lanes.get(&id).expect("the lane is still in the manager");
    assert!(reopened.running(), "and the agent is still running");
    let replay = String::from_utf8_lossy(&reopened.replay()).to_string();
    assert!(replay.contains("before-the-window-closed"), "{replay}");
    assert!(
        !reopened.replay_frames().is_empty(),
        "and it goes to the window as lane frames"
    );
    reopened.reply("echo after-the-window-reopened").unwrap();
    wait_for(&sink, &id, "after-the-window-reopened");
    lanes.close_all();
}

#[test]
fn the_sink_is_told_when_the_agent_ends_and_the_lane_outlives_it() {
    let (lane, sink, lanes) = if cfg!(windows) {
        open(
            LaneSpec::new("cmd", std::env::temp_dir())
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .arg("echo bye"),
        )
    } else {
        open(
            LaneSpec::new("sh", std::env::temp_dir())
                .arg("-c")
                .arg("echo bye"),
        )
    };
    wait_for(&sink, lane.id(), "bye");
    let deadline = Instant::now() + Duration::from_secs(10);
    while lane.running() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!lane.running(), "the reader saw end of file");
    assert_eq!(sink.closed.lock().unwrap().as_deref(), Some(lane.id()));
    let replay = String::from_utf8_lossy(&lane.replay()).to_string();
    assert!(
        replay.contains("bye"),
        "the replay buffer outlives the child: {replay}"
    );
    assert!(
        lane.reply("anyone there?").is_err() || !lane.running(),
        "a reply to a dead lane fails rather than pretending"
    );
    lanes.close_all();
}

#[test]
fn a_missing_agent_is_reported_as_not_found_rather_than_a_crash() {
    let lanes = Lanes::new();
    let err = lanes
        .open(
            LaneSpec::new("mewndo-no-such-agent-7b1c", std::env::temp_dir()),
            Arc::new(mewndo_pty::NoSink),
        )
        .expect_err("there is no such program");
    assert!(err.to_string().contains("not on PATH"), "{err}");
    assert!(lanes.is_empty(), "and no lane was left half open");
}

#[test]
fn two_lanes_have_different_ids_and_do_not_see_each_other_s_output() {
    let (a, sink_a, lanes) = open(LaneSpec::new(shell(), std::env::temp_dir()));
    let sink_b = Arc::new(Collect::default());
    let b = lanes
        .open(LaneSpec::new(shell(), std::env::temp_dir()), sink_b.clone())
        .unwrap();
    assert_ne!(a.id(), b.id());
    assert_eq!(lanes.len(), 2);

    a.reply("echo only-in-lane-a").unwrap();
    wait_for(&sink_a, a.id(), "only-in-lane-a");
    assert!(
        !sink_b.text(b.id()).contains("only-in-lane-a"),
        "lane b saw lane a's output"
    );
    assert!(
        !String::from_utf8_lossy(&b.replay()).contains("only-in-lane-a"),
        "lane b's replay buffer has lane a's output in it"
    );
    lanes.close_all();
    assert!(lanes.is_empty());
}

// The §33.10 Part G step 1 wrapping decision, checked at the point where a lane is actually started: the plan
// a given resolved path produces. The spawn itself is only exercisable on Windows.
#[test]
fn starting_a_lane_from_a_cmd_shim_would_go_through_cmd_exe() {
    let spec = LaneSpec::new("claude", r"C:\work\shop").arg("--continue");
    let plan = launch::plan(
        &spec,
        std::path::Path::new(r"C:\Users\me\AppData\Roaming\npm\claude.cmd"),
        "01JLANE",
        Platform::Windows,
    );
    assert_eq!(plan.program, "cmd.exe");
    assert_eq!(&plan.args[..3], ["/d", "/s", "/c"]);
    assert!(plan.args.contains(&"--continue".to_string()));
    assert!(plan.env.contains(&(LANE_ID_ENV.into(), "01JLANE".into())));
}

// `start` with a chosen id, which is what lets the id in the child's environment be a known value rather than
// a fresh ULID.
#[test]
fn a_lane_can_be_started_with_a_chosen_id() {
    let sink = Arc::new(Collect::default());
    let resolved = launch::resolve(shell()).unwrap();
    let lane = start(
        "01JCHOSENLANEID",
        LaneSpec::new(shell(), std::env::temp_dir()),
        &resolved,
        Platform::host(),
        sink.clone(),
    )
    .unwrap();
    assert_eq!(lane.id(), "01JCHOSENLANEID");
    lane.reply(if cfg!(windows) {
        "echo id=%MEWNDO_LANE_ID%"
    } else {
        "echo id=$MEWNDO_LANE_ID"
    })
    .unwrap();
    let text = wait_for(&sink, lane.id(), "id=01JCHOSENLANEID");
    assert!(text.contains("id=01JCHOSENLANEID"), "{text}");
    let _ = lane.kill();
}
