// Show Me recording (spec §36.6 U9): the user shows a workflow once and Mewndo writes it down as skill steps
// (skill.rs).
//
// Two halves. `Recorder` is the pure state machine -- what becomes a step, when typing is private, the Esc key and
// the 10-minute cap -- tested everywhere with `cargo test`. `start()` is the Windows capture that feeds it: two
// low-level input hooks that exist only while a recording runs, and a worker thread that asks UI Automation what
// was clicked and whether the focused field is a password field.
//
// This is the one place in Mewndo that reads which keys the user presses, so the rules are strict:
//
//   - **It only runs while the user is recording**, started from Mewndo's Skills screen, with the "Recording -- Esc
//     to stop" indicator on top of every window (the app's job), and it stops itself after 10 minutes.
//   - **Nothing typed into a private field is kept**, not the text, not its length: a password field (UI
//     Automation's IsPassword), any field in a password manager or Windows' credential prompts, and any field
//     whose kind could not be read (fail closed). The step is `type {secret: true}`.
//   - **Nothing is recorded on the secure desktop** (UAC, Ctrl+Alt+Del): Windows does not send its input to the
//     hooks, and the worker drops anything that arrives while the input desktop is not the user's.
//   - **Input that was injected** (an agent, cua-driver, Mewndo) is not the user's and is not recorded.
//   - Steps go to the app over the desk pipe and from there to a file in Mewndo's own app data. Nothing is logged.
//
// What it can't do (CLAUDE.md rule 5): scrolling, dragging, and keys held to repeat are not recorded; text pasted
// with Ctrl+V is recorded as the shortcut, not the text; a dead key (accents typed as two keys) may be recorded
// wrong; a click on a window of an elevated (administrator) app may not reach the hooks; an app that hangs UI
// Automation holds up the steps behind it. None of it has run on Windows yet.

use crate::skill::{Element, MAX_STEPS, Step};
use std::time::{Duration, Instant};

/// The hard cap on one recording.
pub const MAX_RECORDING: Duration = Duration::from_secs(10 * 60);
/// Two clicks this close in time and space are one double-click.
pub const DOUBLE_CLICK: Duration = Duration::from_millis(500);
pub const DOUBLE_CLICK_PX: i32 = 4;

/// The window input went to: the program's file name and the window's title.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Where {
    pub app: String,
    pub window: String,
}

/// What UI Automation said about the focused field when a character was typed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Open,
    Password,
    /// The lookup failed or timed out: treated as a password field.
    Unknown,
}

/// One thing the user did, as the capture reports it.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Click {
        x: i32,
        y: i32,
        button: String,
        element: Option<Element>,
        at: Where,
        on_primary: bool,
    },
    /// A printable character.
    Char { ch: char, at: Where, field: Field },
    /// A named key or a chord.
    Key {
        key: String,
        modifiers: Vec<String>,
        at: Where,
    },
    /// Esc: the stop key.
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    Esc,
    Cap,
    /// Stopped from Mewndo.
    App,
    Full,
    Failed(String),
}

impl StopReason {
    pub fn says(&self) -> String {
        match self {
            StopReason::Esc => "you pressed Esc".into(),
            StopReason::Cap => "a recording stops after 10 minutes".into(),
            StopReason::App => "you stopped it in Mewndo".into(),
            StopReason::Full => format!("a skill holds at most {MAX_STEPS} steps"),
            StopReason::Failed(why) => format!("recording could not continue: {why}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// A new step, or (same index) a changed one: a click that became a double-click.
    Step {
        index: usize,
        step: Step,
    },
    Stopped(StopReason),
}

struct Typing {
    at: Where,
    secret: bool,
    text: String,
}

pub struct Recorder {
    started: Instant,
    steps: Vec<Step>,
    typing: Option<Typing>,
    at: Option<Where>,
    last_click: Option<(Instant, i32, i32, String)>,
    stopped: Option<StopReason>,
}

/// Programs whose fields are always private, whatever UI Automation says: password managers and Windows' own
/// credential and consent prompts. Matched on the lowercase file name.
const PRIVATE_APPS: &[&str] = &[
    "1password",
    "keepass",
    "bitwarden",
    "lastpass",
    "dashlane",
    "enpass",
    "roboform",
    "keeper",
    "nordpass",
    "protonpass",
    "proton pass",
    "credentialuibroker",
    "consent.exe",
    "logonui",
    "credwiz",
];

pub fn is_private_app(app: &str) -> bool {
    let app = app.to_lowercase();
    PRIVATE_APPS.iter().any(|p| app.contains(p))
}

impl Recorder {
    pub fn new(now: Instant) -> Recorder {
        Recorder {
            started: now,
            steps: Vec::new(),
            typing: None,
            at: None,
            last_click: None,
            stopped: None,
        }
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    pub fn stopped(&self) -> Option<&StopReason> {
        self.stopped.as_ref()
    }

    /// The cap, checked on every input and by a timer.
    pub fn tick(&mut self, now: Instant) -> Vec<Output> {
        if self.stopped.is_none() && now.saturating_duration_since(self.started) >= MAX_RECORDING {
            return self.stop(StopReason::Cap);
        }
        Vec::new()
    }

    /// Ends the recording: whatever was being typed becomes its step, then `Stopped`. Only the first stop counts.
    pub fn stop(&mut self, reason: StopReason) -> Vec<Output> {
        if self.stopped.is_some() {
            return Vec::new();
        }
        let mut out = self.flush();
        self.stopped = Some(reason.clone());
        out.push(Output::Stopped(reason));
        out
    }

    pub fn input(&mut self, input: Input, now: Instant) -> Vec<Output> {
        let mut out = self.tick(now);
        if self.stopped.is_some() {
            return out;
        }
        let at = match &input {
            Input::Stop => return self.stop(StopReason::Esc),
            Input::Click { at, .. } | Input::Char { at, .. } | Input::Key { at, .. } => at.clone(),
        };
        if self.at.as_ref() != Some(&at) {
            out.extend(self.flush());
            self.at = Some(at.clone());
            if !at.app.is_empty() {
                out.extend(self.push(Step::Focus {
                    app: at.app.clone(),
                    window: at.window.clone(),
                }));
            }
        }
        match input {
            Input::Stop => unreachable!("handled above"),
            Input::Char { ch, field, at } => {
                let secret = field != Field::Open || is_private_app(&at.app);
                if self
                    .typing
                    .as_ref()
                    .is_some_and(|t| t.secret != secret || t.at != at)
                {
                    out.extend(self.flush());
                }
                let typing = self.typing.get_or_insert(Typing {
                    at,
                    secret,
                    text: String::new(),
                });
                if !secret {
                    typing.text.push(ch);
                }
            }
            Input::Key { key, modifiers, .. }
                if key == "Backspace" && modifiers.is_empty() && self.typing.is_some() =>
            {
                // A correction while typing: the text loses its last character. Private typing keeps nothing to
                // correct.
                if let Some(t) = self.typing.as_mut() {
                    t.text.pop();
                }
            }
            Input::Key { key, modifiers, .. } => {
                out.extend(self.flush());
                out.extend(self.push(Step::Key { key, modifiers }));
            }
            Input::Click {
                x,
                y,
                button,
                element,
                at,
                on_primary,
            } => {
                out.extend(self.flush());
                let double = self.last_click.as_ref().is_some_and(|(t, px, py, b)| {
                    now.saturating_duration_since(*t) <= DOUBLE_CLICK
                        && (x - px).abs() <= DOUBLE_CLICK_PX
                        && (y - py).abs() <= DOUBLE_CLICK_PX
                        && *b == button
                });
                let last = self.steps.len().wrapping_sub(1);
                match self.steps.last_mut() {
                    Some(Step::Click { count, .. }) if double && *count < 3 => {
                        *count += 1;
                        out.push(Output::Step {
                            index: last,
                            step: self.steps[last].clone(),
                        });
                    }
                    _ => {
                        // In a password manager, what was clicked may name an account: the point only.
                        let element =
                            element.filter(|e| !e.name.is_empty() && !is_private_app(&at.app));
                        out.extend(self.push(Step::Click {
                            x,
                            y,
                            button: button.clone(),
                            count: 1,
                            element,
                            app: at.app,
                            on_primary,
                        }));
                    }
                }
                self.last_click = Some((now, x, y, button));
            }
        }
        out
    }

    fn flush(&mut self) -> Vec<Output> {
        match self.typing.take() {
            Some(t) if t.secret => self.push(Step::Type {
                text: None,
                secret: true,
            }),
            Some(t) if !t.text.is_empty() => self.push(Step::Type {
                text: Some(t.text),
                secret: false,
            }),
            _ => Vec::new(),
        }
    }

    fn push(&mut self, step: Step) -> Vec<Output> {
        if self.steps.len() >= MAX_STEPS {
            return self.stop(StopReason::Full);
        }
        self.last_click = None;
        self.steps.push(step.clone());
        vec![Output::Step {
            index: self.steps.len() - 1,
            step,
        }]
    }
}

// --- keys -----------------------------------------------------------------------------------------------------------

/// Which modifier keys were down.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyKind {
    Ignore,
    Stop,
    Char(char),
    Key { key: String, modifiers: Vec<String> },
}

/// A Windows virtual-key code and the character it produced (ToUnicodeEx), as the recorder should see it.
/// Ctrl+Alt is AltGr on many keyboards, so a character it produces is typing, not a shortcut.
pub fn key_kind(vk: u32, ch: Option<char>, mods: Mods) -> KeyKind {
    const MODIFIERS: &[u32] = &[
        0x10, 0x11, 0x12, 0x14, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5,
    ];
    if MODIFIERS.contains(&vk) {
        return KeyKind::Ignore;
    }
    if vk == 0x1B {
        return KeyKind::Stop;
    }
    let shortcut = (mods.ctrl && !mods.alt) || mods.win || (mods.alt && !mods.ctrl);
    if let Some(c) = ch.filter(|c| !c.is_control() && !shortcut) {
        return KeyKind::Char(c);
    }
    let Some(key) = key_name(vk) else {
        return KeyKind::Ignore;
    };
    let mut modifiers = Vec::new();
    for (on, name) in [
        (mods.ctrl, "ctrl"),
        (mods.alt, "alt"),
        (mods.shift, "shift"),
        (mods.win, "win"),
    ] {
        if on {
            modifiers.push(name.to_string());
        }
    }
    KeyKind::Key { key, modifiers }
}

/// cua-driver's names for the keys Mewndo records (its `press_key` takes these).
pub fn key_name(vk: u32) -> Option<String> {
    let named = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "Left",
        0x26 => "Up",
        0x27 => "Right",
        0x28 => "Down",
        0x2D => "Insert",
        0x2E => "Delete",
        0x30..=0x39 | 0x41..=0x5A => {
            return char::from_u32(vk).map(|c| c.to_ascii_lowercase().to_string());
        }
        0x70..=0x87 => return Some(format!("F{}", vk - 0x6F)),
        _ => return None,
    };
    Some(named.to_string())
}

/// UI Automation's control type ids, by name.
pub fn control_type(id: i32) -> &'static str {
    const NAMES: &[&str] = &[
        "Button",
        "Calendar",
        "CheckBox",
        "ComboBox",
        "Edit",
        "Hyperlink",
        "Image",
        "ListItem",
        "List",
        "Menu",
        "MenuBar",
        "MenuItem",
        "ProgressBar",
        "RadioButton",
        "ScrollBar",
        "Slider",
        "Spinner",
        "StatusBar",
        "Tab",
        "TabItem",
        "Text",
        "ToolBar",
        "ToolTip",
        "Tree",
        "TreeItem",
        "Custom",
        "Group",
        "Thumb",
        "DataGrid",
        "DataItem",
        "Document",
        "SplitButton",
        "Window",
        "Pane",
        "Header",
        "HeaderItem",
        "Table",
        "TitleBar",
        "Separator",
    ];
    id.checked_sub(50000)
        .and_then(|i| usize::try_from(i).ok())
        .and_then(|i| NAMES.get(i).copied())
        .unwrap_or("")
}

// --- capture ------------------------------------------------------------------------------------------------------

/// A running capture. Dropping it (or `stop`) removes the hooks.
pub struct Capture {
    #[cfg(windows)]
    _running: win::Running,
}

impl Capture {
    pub fn stop(self) {}
}

/// Starts capturing the user's own input and calls `on_input` for each thing they do, from a worker thread. One
/// capture at a time.
#[cfg(windows)]
pub fn start(on_input: impl Fn(Input) + Send + 'static) -> std::io::Result<Capture> {
    Ok(Capture {
        _running: win::start(Box::new(on_input))?,
    })
}

/// Not Windows: there is nothing to capture (§32.5 rule 5).
#[cfg(not(windows))]
pub fn start(_on_input: impl Fn(Input) + Send + 'static) -> std::io::Result<Capture> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Show Me recording needs Windows",
    ))
}

#[cfg(windows)]
mod win {
    use super::{Field, Input, KeyKind, Mods, Where, control_type, key_kind};
    use crate::skill::Element;
    use crossbeam_queue::ArrayQueue;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
    };
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentThreadId, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows_sys::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyState, GetKeyboardLayout, ToUnicodeEx, VK_CAPITAL, VK_CONTROL,
        VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowTextW, GetWindowThreadProcessId,
        HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MONITORINFOF_PRIMARY, MSG,
        MSLLHOOKSTRUCT, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
        WM_SYSKEYDOWN,
    };

    /// What a hook callback pushes. The callback must return at once, so it does nothing but read the event and
    /// the modifier state and `try_push`.
    enum Raw {
        Key {
            vk: u32,
            scan: u32,
            mods: Mods,
            caps: bool,
        },
        Button {
            button: &'static str,
            x: i32,
            y: i32,
        },
    }

    static QUEUE: OnceLock<ArrayQueue<Raw>> = OnceLock::new();
    /// Only one recording at a time; the hooks push nothing when this is off.
    static ACTIVE: AtomicBool = AtomicBool::new(false);

    fn queue() -> &'static ArrayQueue<Raw> {
        QUEUE.get_or_init(|| ArrayQueue::new(4096))
    }

    fn down(vk: u16) -> bool {
        (unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000) != 0
    }

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32
            && ACTIVE.load(Ordering::Relaxed)
            && (w as u32 == WM_KEYDOWN || w as u32 == WM_SYSKEYDOWN)
        {
            let k = unsafe { &*(l as *const KBDLLHOOKSTRUCT) };
            if k.flags & LLKHF_INJECTED == 0 {
                let mods = Mods {
                    ctrl: down(VK_CONTROL),
                    alt: down(VK_MENU),
                    shift: down(VK_SHIFT),
                    win: down(VK_LWIN) || down(VK_RWIN),
                };
                let caps = unsafe { GetKeyState(VK_CAPITAL as i32) } & 1 != 0;
                let _ = queue().push(Raw::Key {
                    vk: k.vkCode,
                    scan: k.scanCode,
                    mods,
                    caps,
                });
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && ACTIVE.load(Ordering::Relaxed) {
            let button = match w as u32 {
                WM_LBUTTONDOWN => Some("left"),
                WM_RBUTTONDOWN => Some("right"),
                WM_MBUTTONDOWN => Some("middle"),
                _ => None,
            };
            let m = unsafe { &*(l as *const MSLLHOOKSTRUCT) };
            if let Some(button) = button.filter(|_| m.flags & LLMHF_INJECTED == 0) {
                let _ = queue().push(Raw::Button {
                    button,
                    x: m.pt.x,
                    y: m.pt.y,
                });
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, w, l) }
    }

    pub struct Running {
        hook_thread: Arc<AtomicU32>,
        done: Arc<AtomicBool>,
    }

    impl Drop for Running {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::SeqCst);
            self.done.store(true, Ordering::SeqCst);
            let id = self.hook_thread.load(Ordering::SeqCst);
            if id != 0 {
                unsafe { PostThreadMessageW(id, WM_QUIT, 0, 0) };
            }
        }
    }

    pub fn start(on_input: Box<dyn Fn(Input) + Send>) -> std::io::Result<Running> {
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return Err(std::io::Error::other("a recording is already running"));
        }
        while queue().pop().is_some() {}
        let hook_thread = Arc::new(AtomicU32::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let (ready, installed) = std::sync::mpsc::channel();
        let id = hook_thread.clone();
        let spawned = std::thread::Builder::new()
            .name("mewndo-showme-hooks".into())
            .spawn(move || unsafe {
                id.store(GetCurrentThreadId(), Ordering::SeqCst);
                let k = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), std::ptr::null_mut(), 0);
                let m = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), std::ptr::null_mut(), 0);
                let ok = !k.is_null() && !m.is_null();
                let _ = ready.send(ok.then_some(()).ok_or_else(std::io::Error::last_os_error));
                if ok {
                    let mut msg: MSG = std::mem::zeroed();
                    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
                }
                if !k.is_null() {
                    UnhookWindowsHookEx(k);
                }
                if !m.is_null() {
                    UnhookWindowsHookEx(m);
                }
            });
        let installed = spawned.and_then(|_| {
            installed
                .recv()
                .map_err(|_| std::io::Error::other("the hook thread ended"))?
        });
        if let Err(e) = installed {
            ACTIVE.store(false, Ordering::SeqCst);
            return Err(e);
        }
        let stop = done.clone();
        std::thread::Builder::new()
            .name("mewndo-showme".into())
            .spawn(move || worker(on_input, stop))?;
        Ok(Running { hook_thread, done })
    }

    fn worker(on_input: Box<dyn Fn(Input) + Send>, done: Arc<AtomicBool>) {
        // Physical pixels, as the hooks report them and as cua-driver aims.
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let uia = uia::Uia::new();
        let mut field_cache: Option<(HWND, Instant, Field)> = None;
        while !done.load(Ordering::SeqCst) {
            let Some(raw) = queue().pop() else {
                std::thread::sleep(Duration::from_millis(15));
                continue;
            };
            if !input_desktop_is_the_users() {
                continue; // the secure desktop: nothing is recorded
            }
            let fg = unsafe { GetForegroundWindow() };
            let at = where_is(fg);
            let input = match raw {
                Raw::Key {
                    vk,
                    scan,
                    mods,
                    caps,
                } => match key_kind(vk, char_of(vk, scan, mods, caps, fg), mods) {
                    KeyKind::Ignore => continue,
                    KeyKind::Stop => Input::Stop,
                    KeyKind::Key { key, modifiers } => Input::Key { key, modifiers, at },
                    KeyKind::Char(ch) => {
                        let field = match field_cache {
                            Some((w, t, f))
                                if w == fg && t.elapsed() < Duration::from_millis(300) =>
                            {
                                f
                            }
                            _ => {
                                let f = uia.as_ref().map_or(Field::Unknown, |u| u.focused_field());
                                field_cache = Some((fg, Instant::now(), f));
                                f
                            }
                        };
                        Input::Char { ch, at, field }
                    }
                },
                Raw::Button { button, x, y } => {
                    field_cache = None;
                    Input::Click {
                        x,
                        y,
                        button: button.to_string(),
                        element: uia.as_ref().and_then(|u| u.element_at(x, y)),
                        at,
                        on_primary: on_primary(x, y),
                    }
                }
            };
            on_input(input);
        }
    }

    /// The character a key press makes, on the foreground window's keyboard layout, without disturbing the
    /// keyboard state of the app being typed in (flag 4, Windows 10 1607 and later).
    fn char_of(vk: u32, scan: u32, mods: Mods, caps: bool, fg: HWND) -> Option<char> {
        let mut state = [0u8; 256];
        for (on, key) in [
            (mods.shift, VK_SHIFT),
            (mods.ctrl, VK_CONTROL),
            (mods.alt, VK_MENU),
        ] {
            if on {
                state[key as usize] = 0x80;
            }
        }
        if caps {
            state[VK_CAPITAL as usize] = 0x01;
        }
        let layout =
            unsafe { GetKeyboardLayout(GetWindowThreadProcessId(fg, std::ptr::null_mut())) };
        let mut buf = [0u16; 8];
        let n = unsafe {
            ToUnicodeEx(
                vk,
                scan,
                state.as_ptr(),
                buf.as_mut_ptr(),
                buf.len() as i32,
                4,
                layout,
            )
        };
        if n != 1 {
            return None; // a dead key (negative), nothing, or more than one character
        }
        char::from_u32(buf[0] as u32)
    }

    fn where_is(hwnd: HWND) -> Where {
        let mut title = [0u16; 512];
        let n = unsafe { GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) };
        let window = String::from_utf16_lossy(&title[..n.max(0) as usize]);
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        Where {
            app: exe_name(pid).unwrap_or_default(),
            window,
        }
    }

    fn exe_name(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok =
                QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
                .and_then(|p| p.rsplit('\\').next().map(str::to_string))
        }
    }

    fn on_primary(x: i32, y: i32) -> bool {
        unsafe {
            let m = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(m, &mut info) != 0 && info.dwFlags & MONITORINFOF_PRIMARY != 0
        }
    }

    /// False on the secure desktop (UAC, Ctrl+Alt+Del, the lock screen), or when that cannot be told.
    fn input_desktop_is_the_users() -> bool {
        unsafe {
            let desk = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
            if desk.is_null() {
                return false;
            }
            let mut name = [0u16; 64];
            let mut needed = 0u32;
            let ok = GetUserObjectInformationW(
                desk,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                (name.len() * 2) as u32,
                &mut needed,
            ) != 0;
            CloseDesktop(desk);
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            ok && String::from_utf16_lossy(&name[..len]).eq_ignore_ascii_case("Default")
        }
    }

    /// UI Automation, through the `windows` crate's COM bindings, on the worker thread (its own apartment).
    mod uia {
        use super::{Element, Field, control_type};
        use windows::Win32::Foundation::POINT;
        use windows::Win32::System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        };
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

        pub struct Uia(IUIAutomation);

        impl Uia {
            pub fn new() -> Option<Uia> {
                unsafe {
                    CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
                    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                        .ok()
                        .map(Uia)
                }
            }

            /// Whether the focused element is a password field. Any failure is `Unknown`, which the recorder treats
            /// as a password field.
            pub fn focused_field(&self) -> Field {
                unsafe {
                    match self
                        .0
                        .GetFocusedElement()
                        .and_then(|e| e.CurrentIsPassword())
                    {
                        Ok(p) if p.as_bool() => Field::Password,
                        Ok(_) => Field::Open,
                        Err(_) => Field::Unknown,
                    }
                }
            }

            /// What is under the point: its name and control type.
            pub fn element_at(&self, x: i32, y: i32) -> Option<Element> {
                unsafe {
                    let e = self.0.ElementFromPoint(POINT { x, y }).ok()?;
                    let name = e.CurrentName().ok()?.to_string();
                    let kind = e.CurrentControlType().map(|c| c.0).unwrap_or_default();
                    Some(Element {
                        name: name.chars().take(200).collect(),
                        control_type: control_type(kind).to_string(),
                    })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(app: &str) -> Where {
        Where {
            app: app.into(),
            window: format!("{app} window"),
        }
    }

    fn ch(c: char, app: &str, field: Field) -> Input {
        Input::Char {
            ch: c,
            at: at(app),
            field,
        }
    }

    fn click(x: i32, y: i32, app: &str) -> Input {
        Input::Click {
            x,
            y,
            button: "left".into(),
            element: Some(Element {
                name: "Send".into(),
                control_type: "Button".into(),
            }),
            at: at(app),
            on_primary: true,
        }
    }

    fn steps(out: &[Output]) -> Vec<Step> {
        out.iter()
            .filter_map(|o| match o {
                Output::Step { step, .. } => Some(step.clone()),
                Output::Stopped(_) => None,
            })
            .collect()
    }

    #[test]
    fn focus_click_typing_and_keys_become_steps() {
        let t0 = Instant::now();
        let mut r = Recorder::new(t0);
        let mut out = Vec::new();
        out.extend(r.input(click(10, 20, "OUTLOOK.EXE"), t0));
        for c in "hi!".chars() {
            out.extend(r.input(ch(c, "OUTLOOK.EXE", Field::Open), t0));
        }
        out.extend(r.input(
            Input::Key {
                key: "Backspace".into(),
                modifiers: vec![],
                at: at("OUTLOOK.EXE"),
            },
            t0,
        ));
        out.extend(r.input(
            Input::Key {
                key: "Enter".into(),
                modifiers: vec![],
                at: at("OUTLOOK.EXE"),
            },
            t0,
        ));
        out.extend(r.input(click(500, 500, "notepad.exe"), t0 + Duration::from_secs(1)));
        assert_eq!(
            steps(&out),
            [
                Step::Focus {
                    app: "OUTLOOK.EXE".into(),
                    window: "OUTLOOK.EXE window".into()
                },
                Step::Click {
                    x: 10,
                    y: 20,
                    button: "left".into(),
                    count: 1,
                    element: Some(Element {
                        name: "Send".into(),
                        control_type: "Button".into()
                    }),
                    app: "OUTLOOK.EXE".into(),
                    on_primary: true
                },
                Step::Type {
                    text: Some("hi".into()),
                    secret: false
                },
                Step::Key {
                    key: "Enter".into(),
                    modifiers: vec![]
                },
                Step::Focus {
                    app: "notepad.exe".into(),
                    window: "notepad.exe window".into()
                },
                Step::Click {
                    x: 500,
                    y: 500,
                    button: "left".into(),
                    count: 1,
                    element: Some(Element {
                        name: "Send".into(),
                        control_type: "Button".into()
                    }),
                    app: "notepad.exe".into(),
                    on_primary: true
                },
            ]
        );
        assert_eq!(r.steps().len(), 6);
    }

    #[test]
    fn password_fields_password_managers_and_unknown_fields_keep_nothing() {
        let t0 = Instant::now();
        for (app, field) in [
            ("chrome.exe", Field::Password),
            ("chrome.exe", Field::Unknown),
            ("KeePassXC.exe", Field::Open),
            ("1Password.exe", Field::Open),
            ("CredentialUIBroker.exe", Field::Open),
        ] {
            let mut r = Recorder::new(t0);
            let mut out = Vec::new();
            for c in "hunter2".chars() {
                out.extend(r.input(ch(c, app, field), t0));
            }
            out.extend(r.stop(StopReason::App));
            let printed = format!("{out:?} {:?}", r.steps());
            assert!(
                !printed.contains("hunter") && !printed.contains('7'),
                "{app}: {printed}"
            );
            assert_eq!(
                r.steps().last(),
                Some(&Step::Type {
                    text: None,
                    secret: true
                }),
                "{app} {field:?}"
            );
            let json = serde_json::to_string(r.steps()).unwrap();
            assert!(!json.contains("hunter"), "{json}");
        }
    }

    #[test]
    fn moving_from_a_password_field_to_an_open_one_splits_the_typing() {
        let t0 = Instant::now();
        let mut r = Recorder::new(t0);
        for c in "secret".chars() {
            r.input(ch(c, "app.exe", Field::Password), t0);
        }
        for c in "name".chars() {
            r.input(ch(c, "app.exe", Field::Open), t0);
        }
        r.stop(StopReason::Esc);
        assert_eq!(
            r.steps()[1..],
            [
                Step::Type {
                    text: None,
                    secret: true
                },
                Step::Type {
                    text: Some("name".into()),
                    secret: false
                }
            ]
        );
        // In a password manager a click keeps its point, not what it was called.
        let mut r = Recorder::new(t0);
        r.input(click(1, 2, "Bitwarden.exe"), t0);
        assert!(matches!(&r.steps()[1], Step::Click { element: None, .. }));
    }

    #[test]
    fn two_quick_clicks_are_a_double_click_reported_on_the_same_index() {
        let t0 = Instant::now();
        let mut r = Recorder::new(t0);
        let first = r.input(click(100, 100, "x.exe"), t0);
        let second = r.input(click(102, 99, "x.exe"), t0 + Duration::from_millis(200));
        let Output::Step { index: a, .. } = first.last().unwrap() else {
            panic!()
        };
        let Output::Step { index: b, step } = &second[0] else {
            panic!()
        };
        assert_eq!(a, b);
        assert!(matches!(step, Step::Click { count: 2, .. }));
        // Slow, or far: a new click.
        r.input(click(102, 99, "x.exe"), t0 + Duration::from_secs(3));
        r.input(click(300, 99, "x.exe"), t0 + Duration::from_millis(3100));
        assert_eq!(r.steps().len(), 4);
    }

    #[test]
    fn esc_the_app_and_the_ten_minute_cap_each_stop_it_once() {
        let t0 = Instant::now();
        let mut r = Recorder::new(t0);
        r.input(ch('a', "x.exe", Field::Open), t0);
        let out = r.input(Input::Stop, t0);
        assert_eq!(
            out.last(),
            Some(&Output::Stopped(StopReason::Esc)),
            "{out:?}"
        );
        assert_eq!(steps(&out).len(), 1, "the typing is flushed first");
        assert!(r.input(ch('b', "x.exe", Field::Open), t0).is_empty());
        assert!(
            r.stop(StopReason::App).is_empty(),
            "only the first stop counts"
        );

        let mut r = Recorder::new(t0);
        assert!(
            r.tick(t0 + MAX_RECORDING - Duration::from_secs(1))
                .is_empty()
        );
        let late = r.input(click(1, 1, "x.exe"), t0 + MAX_RECORDING);
        assert_eq!(late, [Output::Stopped(StopReason::Cap)]);
        assert!(r.steps().is_empty(), "nothing after the cap is recorded");
        assert!(StopReason::Cap.says().contains("10 minutes"));
    }

    #[test]
    fn a_skill_is_full_at_its_step_limit() {
        let t0 = Instant::now();
        let mut r = Recorder::new(t0);
        let mut last = Vec::new();
        for i in 0..(MAX_STEPS as i32 + 5) {
            last = r.input(
                click(i * 10, 0, "x.exe"),
                t0 + Duration::from_secs(1 + i as u64),
            );
            if r.stopped().is_some() {
                break;
            }
        }
        assert_eq!(r.stopped(), Some(&StopReason::Full));
        assert_eq!(last.last(), Some(&Output::Stopped(StopReason::Full)));
        assert_eq!(r.steps().len(), MAX_STEPS);
    }

    #[test]
    fn keys_are_characters_shortcuts_or_ignored() {
        let none = Mods::default();
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        let altgr = Mods {
            ctrl: true,
            alt: true,
            ..Mods::default()
        };
        let shift = Mods {
            shift: true,
            ..Mods::default()
        };
        assert_eq!(key_kind(0x41, Some('a'), none), KeyKind::Char('a'));
        assert_eq!(key_kind(0x41, Some('A'), shift), KeyKind::Char('A'));
        assert_eq!(
            key_kind(0x43, Some('\u{3}'), ctrl),
            KeyKind::Key {
                key: "c".into(),
                modifiers: vec!["ctrl".into()]
            }
        );
        assert_eq!(
            key_kind(0x51, Some('@'), altgr),
            KeyKind::Char('@'),
            "AltGr types"
        );
        assert_eq!(key_kind(0x1B, None, none), KeyKind::Stop);
        assert_eq!(key_kind(0x10, None, shift), KeyKind::Ignore);
        assert_eq!(key_kind(0xFF, None, none), KeyKind::Ignore);
        assert_eq!(
            key_kind(0x0D, Some('\r'), none),
            KeyKind::Key {
                key: "Enter".into(),
                modifiers: vec![]
            }
        );
        assert_eq!(
            key_kind(0x09, Some('\t'), shift),
            KeyKind::Key {
                key: "Tab".into(),
                modifiers: vec!["shift".into()]
            }
        );
        assert_eq!(key_kind(0x20, Some(' '), none), KeyKind::Char(' '));
        assert_eq!(key_name(0x75).as_deref(), Some("F6"));
        assert_eq!(key_name(0x37).as_deref(), Some("7"));
        assert_eq!(control_type(50000), "Button");
        assert_eq!(control_type(50038), "Separator");
        assert_eq!(control_type(7), "");
    }

    #[test]
    fn off_windows_there_is_no_capture() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(
            start(|_| {}).err().unwrap().kind(),
            std::io::ErrorKind::Unsupported
        );
    }
}
