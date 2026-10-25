// Show Me (spec §36.6 U9), the core's half: the app says `showme.start` and `showme.stop`; the core runs the
// recording (mewndo-computer's record.rs) and tells every app connection `showme.state` and each `showme.step`.
//
//   showme.start, computer use off      -> showme.state {recording: false, reason: "turn on computer use ..."}
//   showme.start                        -> the capture starts, showme.state {recording: true}
//   every step (or a changed one)       -> showme.step {step: {index, step}}
//   Esc, showme.stop, 10 minutes, full  -> the capture stops, showme.state {recording: false, reason, steps}
//
// The last `showme.state` carries every step, so an app that missed a `showme.step` still saves the whole skill.
// The core keeps nothing after that: saving, naming and editing the skill are the app's (apps/desktop/app/
// skills.js), in Mewndo's own app data. Nothing a recording sees is logged; the log says it started, how it ended
// and how many steps it made.
use crate::desk_agents::Publisher;
use crate::log::Log;
use mewndo_computer::record::{Input, MAX_RECORDING, Output, Recorder, StopReason};
use mewndo_proto::{ShowmeState, ShowmeStep};
use serde_json::json;
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

/// Starts a capture that calls the given function for each input; what it returns keeps the capture running
/// until it is dropped. The real one is `mewndo_computer::record::start`; tests drive a fake.
pub type Starter =
    Box<dyn Fn(Box<dyn Fn(Input) + Send>) -> std::io::Result<Box<dyn Send>> + Send + Sync>;

pub const NEEDS_COMPUTER_USE: &str =
    "Show Me needs computer use. Turn it on in Mewndo's settings, then record again.";

pub struct ShowMe {
    state: Mutex<State>,
    publisher: Publisher,
    log: Arc<Log>,
    starter: Starter,
}

#[derive(Default)]
struct State {
    /// Which recording an input belongs to, so a late input from an old capture changes nothing.
    session: u64,
    recorder: Option<Recorder>,
    capture: Option<Box<dyn Send>>,
}

impl ShowMe {
    pub fn new(publisher: Publisher, log: Arc<Log>) -> Arc<ShowMe> {
        Self::with_starter(
            publisher,
            log,
            Box::new(|on_input| {
                mewndo_computer::record::start(on_input).map(|c| Box::new(c) as Box<dyn Send>)
            }),
        )
    }

    pub fn with_starter(publisher: Publisher, log: Arc<Log>, starter: Starter) -> Arc<ShowMe> {
        Arc::new(ShowMe {
            state: Mutex::new(State::default()),
            publisher,
            log,
            starter,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    fn recording(&self) -> bool {
        self.lock().recorder.is_some()
    }

    /// `showme.start`. `computer_use`: whether the user has switched computer use on (the core's gate).
    pub fn start(self: &Arc<Self>, computer_use: bool) {
        if !computer_use {
            self.publisher.send(&ShowmeState {
                recording: false,
                reason: Some(NEEDS_COMPUTER_USE.into()),
                steps: Vec::new(),
            });
            return;
        }
        let mut state = self.lock();
        if state.recorder.is_some() {
            drop(state);
            self.publisher.send(&ShowmeState {
                recording: true,
                reason: None,
                steps: Vec::new(),
            });
            return;
        }
        state.session += 1;
        let session = state.session;
        let me: Weak<ShowMe> = Arc::downgrade(self);
        let capture = (self.starter)(Box::new(move |input| {
            if let Some(me) = me.upgrade() {
                me.input(session, input, Instant::now());
            }
        }));
        match capture {
            Ok(capture) => {
                state.recorder = Some(Recorder::new(Instant::now()));
                state.capture = Some(capture);
                drop(state);
                self.log.info("Show Me: recording started");
                self.publisher.send(&ShowmeState {
                    recording: true,
                    reason: None,
                    steps: Vec::new(),
                });
                // The hard cap, even if the user never touches anything again.
                let me = Arc::downgrade(self);
                let _ = std::thread::Builder::new()
                    .name("mewndo-showme-cap".into())
                    .spawn(move || {
                        std::thread::sleep(MAX_RECORDING);
                        if let Some(me) = me.upgrade() {
                            me.tick(session, Instant::now());
                        }
                    });
            }
            Err(e) => {
                drop(state);
                self.log
                    .warn(&format!("Show Me: the recording could not start: {e}"));
                self.publisher.send(&ShowmeState {
                    recording: false,
                    reason: Some(StopReason::Failed(e.to_string()).says()),
                    steps: Vec::new(),
                });
            }
        }
    }

    /// `showme.stop` from the app, or the core stopping.
    pub fn stop(&self, reason: StopReason) {
        let mut state = self.lock();
        let out = match state.recorder.as_mut() {
            Some(r) => r.stop(reason),
            None => return,
        };
        self.emit(&mut state, out);
    }

    fn input(&self, session: u64, input: Input, now: Instant) {
        let mut state = self.lock();
        if state.session != session {
            return;
        }
        let out = match state.recorder.as_mut() {
            Some(r) => r.input(input, now),
            None => return,
        };
        self.emit(&mut state, out);
    }

    fn tick(&self, session: u64, now: Instant) {
        let mut state = self.lock();
        if state.session != session {
            return;
        }
        let out = match state.recorder.as_mut() {
            Some(r) => r.tick(now),
            None => return,
        };
        self.emit(&mut state, out);
    }

    fn emit(&self, state: &mut State, out: Vec<Output>) {
        for o in out {
            match o {
                Output::Step { index, step } => self.publisher.send(&ShowmeStep {
                    step: json!({"index": index, "step": step}),
                }),
                Output::Stopped(reason) => {
                    state.capture = None; // the hooks go first
                    let steps: Vec<serde_json::Value> = state
                        .recorder
                        .take()
                        .map(|r| r.steps().to_vec())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|s| serde_json::to_value(s).ok())
                        .collect();
                    self.log.info(&format!(
                        "Show Me: recording stopped ({} steps): {}",
                        steps.len(),
                        reason.says()
                    ));
                    self.publisher.send(&ShowmeState {
                        recording: false,
                        reason: Some(reason.says()),
                        steps,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_computer::record::{Field, Where};
    use mewndo_proto::{Body, Envelope, Frame, decode};
    use std::time::Duration;
    use tokio::sync::broadcast;

    type Slot = Arc<Mutex<Option<Box<dyn Fn(Input) + Send>>>>;

    fn showme(name: &str, fail: bool) -> (Arc<ShowMe>, broadcast::Receiver<Arc<Vec<u8>>>, Slot) {
        let d = std::env::temp_dir().join(format!("mewndo-showme-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let log = Arc::new(Log::new(&d.join("logs")));
        let (tx, rx) = broadcast::channel(64);
        let slot: Slot = Arc::default();
        let keep = slot.clone();
        let starter: Starter = Box::new(move |on_input| {
            if fail {
                return Err(std::io::Error::other("no hooks today"));
            }
            *keep.lock().unwrap() = Some(on_input);
            Ok(Box::new(()))
        });
        (ShowMe::with_starter(Publisher(tx), log, starter), rx, slot)
    }

    fn next(rx: &mut broadcast::Receiver<Arc<Vec<u8>>>) -> Envelope {
        let bytes = rx.try_recv().expect("a message");
        let Frame::Json(env) = decode(&bytes).unwrap().unwrap().0 else {
            panic!("not json")
        };
        env
    }

    fn feed(slot: &Slot, input: Input) {
        (slot.lock().unwrap().as_ref().unwrap())(input);
    }

    #[test]
    fn off_without_computer_use() {
        let (me, mut rx, slot) = showme("off", false);
        me.start(false);
        let env = next(&mut rx);
        assert_eq!(env.kind, ShowmeState::TYPE);
        let state: ShowmeState = env.open().unwrap();
        assert!(!state.recording);
        assert_eq!(state.reason.as_deref(), Some(NEEDS_COMPUTER_USE));
        assert!(slot.lock().unwrap().is_none(), "no capture was started");
        assert!(!me.recording());
    }

    #[test]
    fn a_recording_streams_its_steps_and_ends_with_all_of_them() {
        let (me, mut rx, slot) = showme("run", false);
        me.start(true);
        assert!(next(&mut rx).open::<ShowmeState>().unwrap().recording);
        me.start(true);
        assert!(
            next(&mut rx).open::<ShowmeState>().unwrap().recording,
            "a second start just says it is recording"
        );
        let at = Where {
            app: "notepad.exe".into(),
            window: "Untitled".into(),
        };
        for ch in "hi".chars() {
            feed(
                &slot,
                Input::Char {
                    ch,
                    at: at.clone(),
                    field: Field::Open,
                },
            );
        }
        for ch in "pw".chars() {
            feed(
                &slot,
                Input::Char {
                    ch,
                    at: at.clone(),
                    field: Field::Password,
                },
            );
        }
        feed(&slot, Input::Stop);
        let mut kinds = Vec::new();
        let mut last = None;
        while let Ok(bytes) = rx.try_recv() {
            let Frame::Json(env) = decode(&bytes).unwrap().unwrap().0 else {
                panic!()
            };
            kinds.push(env.kind.clone());
            last = Some(env);
        }
        assert_eq!(
            kinds,
            ["showme.step", "showme.step", "showme.step", "showme.state"]
        );
        let end: ShowmeState = last.unwrap().open().unwrap();
        assert!(!end.recording);
        assert_eq!(end.reason.as_deref(), Some("you pressed Esc"));
        assert_eq!(end.steps.len(), 3);
        assert_eq!(end.steps[1], json!({"kind": "type", "text": "hi"}));
        assert_eq!(end.steps[2], json!({"kind": "type", "secret": true}));
        assert!(!me.recording());
        // An input from the finished capture changes nothing.
        feed(&slot, Input::Stop);
        assert!(rx.try_recv().is_err());
        me.stop(StopReason::App);
        assert!(rx.try_recv().is_err(), "nothing to stop");
    }

    #[test]
    fn the_app_and_the_cap_stop_it_and_a_capture_that_cannot_start_says_why() {
        let (me, mut rx, _slot) = showme("stop", false);
        me.start(true);
        next(&mut rx);
        me.stop(StopReason::App);
        let end: ShowmeState = next(&mut rx).open().unwrap();
        assert_eq!(end.reason.as_deref(), Some("you stopped it in Mewndo"));

        me.start(true);
        next(&mut rx);
        let session = me.lock().session;
        me.tick(session - 1, Instant::now() + MAX_RECORDING); // an old timer: ignored
        assert!(me.recording());
        me.tick(
            session,
            Instant::now() + MAX_RECORDING + Duration::from_secs(1),
        );
        let end: ShowmeState = next(&mut rx).open().unwrap();
        assert!(end.reason.unwrap().contains("10 minutes"));
        assert!(!me.recording());

        let (me, mut rx, _) = showme("fail", true);
        me.start(true);
        let end: ShowmeState = next(&mut rx).open().unwrap();
        assert!(!end.recording);
        assert!(end.reason.unwrap().contains("no hooks today"));
        assert!(!me.recording());
    }
}
