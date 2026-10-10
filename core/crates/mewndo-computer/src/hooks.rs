// §36.6 U6: human takeover. If the user touches the mouse or keyboard while an agent is using the computer, every
// act is refused until they choose Resume in Mewndo (§36.4).
//
// The hooks are Windows' low-level keyboard and mouse hooks, and they read exactly one thing: whether the event was
// injected (LLKHF_INJECTED / LLMHF_INJECTED). Input cua-driver synthesises is injected; the user's own is not. The
// callback pushes a tag -- keyboard or mouse -- and **no key code, no character, no position**: that is the line
// between a safety feature and a keylogger, and crossing it would need a change to `Input` itself, not a slip.
//
// The callback must return almost at once or Windows removes the hook, so it only does `try_push` on a fixed-size
// lock-free queue (crossbeam's ArrayQueue, §36.6's table); a full queue drops the event, which loses nothing,
// since one event is enough to pause. A second thread drains the queue and calls the core back.
//
// Pausing needs an agent to be acting: input more than `ACTIVE_FOR` after the last allowed act is the user using
// their own computer, not taking it back.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after an allowed act the user's own input counts as taking over.
pub const ACTIVE_FOR: Duration = Duration::from_secs(30);

/// What a hook reports. Deliberately nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    Keyboard,
    Mouse,
}

/// The pause state machine, pure so `cargo test` covers it everywhere.
#[derive(Default)]
pub struct Takeover {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    last_act: Option<Instant>,
    paused: bool,
}

impl Takeover {
    /// An act was allowed and is about to happen.
    pub fn acting(&self, now: Instant) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_act = Some(now);
    }

    /// The user's own input. True when this is what paused computer use (so the caller tells the apps once).
    pub fn human_input(&self, now: Instant) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let active = s
            .last_act
            .is_some_and(|t| now.saturating_duration_since(t) <= ACTIVE_FOR);
        if s.paused || !active {
            return false;
        }
        s.paused = true;
        true
    }

    pub fn paused(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).paused
    }

    /// The user chose Resume. The next act starts a fresh active window.
    pub fn resume(&self) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.paused = false;
        s.last_act = None;
    }
}

/// Installs the two hooks on their own thread and calls `on_input` for each human (not injected) event, from a
/// second thread. Runs for the life of the process.
#[cfg(windows)]
pub fn start(on_input: impl Fn(Input) + Send + 'static) -> std::io::Result<()> {
    win::start(Box::new(on_input))
}

/// Not Windows: there is nothing to hook (§32.5 rule 5), and computer use is a Windows feature.
#[cfg(not(windows))]
pub fn start(_on_input: impl Fn(Input) + Send + 'static) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "human takeover needs Windows' low-level input hooks",
    ))
}

#[cfg(windows)]
mod win {
    use super::Input;
    use crossbeam_queue::ArrayQueue;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED,
        MSG, MSLLHOOKSTRUCT, SetWindowsHookExW, WH_KEYBOARD_LL, WH_MOUSE_LL,
    };

    static QUEUE: OnceLock<ArrayQueue<Input>> = OnceLock::new();

    fn queue() -> &'static ArrayQueue<Input> {
        QUEUE.get_or_init(|| ArrayQueue::new(64))
    }

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // Only the flags are read. The virtual key and scan code are never touched.
            let flags = unsafe { (*(l as *const KBDLLHOOKSTRUCT)).flags };
            if flags & LLKHF_INJECTED == 0 {
                let _ = queue().push(Input::Keyboard);
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            // Only the flags are read, not the position.
            let flags = unsafe { (*(l as *const MSLLHOOKSTRUCT)).flags };
            if flags & LLMHF_INJECTED == 0 {
                let _ = queue().push(Input::Mouse);
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    pub fn start(on_input: Box<dyn Fn(Input) + Send>) -> std::io::Result<()> {
        let (ready, installed) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("mewndo-takeover-hooks".into())
            .spawn(move || unsafe {
                let k = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
                let m = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
                let ok = !k.is_null() && !m.is_null();
                let _ = ready.send(ok.then_some(()).ok_or_else(std::io::Error::last_os_error));
                // Low-level hooks are called on this thread's message loop.
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            })?;
        installed
            .recv()
            .map_err(|_| std::io::Error::other("the hook thread ended"))??;
        std::thread::Builder::new()
            .name("mewndo-takeover".into())
            .spawn(move || {
                loop {
                    while let Some(input) = queue().pop() {
                        on_input(input);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_pauses_only_while_an_agent_is_acting_and_resume_clears_it() {
        let t = Takeover::default();
        let start = Instant::now();
        assert!(
            !t.human_input(start),
            "nobody acting: the user is just using their computer"
        );
        t.acting(start);
        assert!(t.human_input(start + Duration::from_secs(5)), "taken over");
        assert!(t.paused());
        assert!(
            !t.human_input(start + Duration::from_secs(6)),
            "already paused: told once"
        );
        t.resume();
        assert!(!t.paused());
        assert!(
            !t.human_input(start + Duration::from_secs(7)),
            "resume starts afresh"
        );
        t.acting(start);
        assert!(
            !t.human_input(start + ACTIVE_FOR + Duration::from_secs(1)),
            "long after the last act"
        );
    }

    #[test]
    fn off_windows_there_is_no_hook() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(
            start(|_| {}).unwrap_err().kind(),
            std::io::ErrorKind::Unsupported
        );
    }
}
