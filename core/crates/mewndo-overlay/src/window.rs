// §36.6 U7: the agent cursor on screen. One transparent, click-through, topmost window per display, owned by one
// thread of its own, drawing an arrow and a label chip ("Claude · clicking") and gliding them along a planner's
// samples.
//
// The windows (Windows only, `win` below):
//
//   WS_EX_LAYERED | WS_EX_TRANSPARENT   see-through and click-through: the user's clicks, and the driver's, go to
//                                       whatever is underneath, and a hit test never finds the overlay.
//   WS_EX_TOPMOST | WS_EX_NOACTIVATE    above everything, and never takes focus from the user's app.
//   WS_EX_TOOLWINDOW                    no taskbar button, not in Alt+Tab.
//   per-monitor-v2 DPI aware            set on this thread only, so the overlay works in the same physical pixels as
//                                       cua-driver (coords.rs) without changing the rest of the core.
//   WDA_EXCLUDEFROMCAPTURE              kept out of screenshots, so the agent never sees Mewndo's cursor in what it
//                                       captures. Windows 10 2004 or later; on older Windows the call fails and the
//                                       cursor does show up in captures.
//
// Transparency is a colour key (magenta) and drawing is plain GDI into the part of the window that changed, so a
// frame repaints a few hundred pixels, not a whole 4K display. Edges are not anti-aliased; the label's text is,
// against the chip, which is solid.
//
// The cursor's state and the geometry are pure and tested on every platform; the Win32 calls are compile-checked
// for Windows (clippy, x86_64-pc-windows-gnu) and have not been run on Windows. Elsewhere `spawn` is a no-op.

use crate::Show;
use crate::coords::Px;
#[cfg(windows)]
use crate::coords::Rect;
use crate::motion::{MotionPlanner, MoveRequest, REST_HEADING, Sample, duration, sample_at};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

/// How long the agent cursor stays on screen after it arrives, if nothing else happens.
pub const LINGER: Duration = Duration::from_secs(5);
/// How often the animation is advanced while the cursor moves (about 120 frames a second).
pub const TICK: Duration = Duration::from_millis(8);
/// The longest label the chip shows; longer ones end in "…".
pub const MAX_LABEL: usize = 48;

/// The arrow, hotspot at (0, 0), at 100% scale (96 dpi): the usual pointer shape, so it reads as a cursor.
pub const ARROW: [(f64, f64); 7] = [
    (0.0, 0.0),
    (0.0, 17.0),
    (4.0, 13.0),
    (7.0, 20.0),
    (10.0, 19.0),
    (7.0, 12.0),
    (12.0, 12.0),
];
/// The chip's largest size at 100% scale; text past it is cut with "…".
const CHIP_MAX_W: f64 = 360.0;
const CHIP_MAX_H: f64 = 32.0;

/// The agent cursor's state: where it is, where it is going, whether it shows. Pure: the clock is passed in.
pub struct Cursor {
    pub pos: Px,
    pub heading: f64,
    pub visible: bool,
    pub label: String,
    pub arrow: bool,
    plan: Vec<Sample>,
    started: Instant,
    rested: Option<Instant>,
    moves: u64,
}

impl Cursor {
    /// A hidden cursor at `at` (the user's own pointer, when the overlay starts).
    pub fn new(at: Px, now: Instant) -> Cursor {
        Cursor {
            pos: at,
            heading: REST_HEADING,
            visible: false,
            label: String::new(),
            arrow: true,
            plan: Vec::new(),
            started: now,
            rested: None,
            moves: 0,
        }
    }

    /// Glide from wherever the cursor is now to `to`, which is a virtual-screen point.
    pub fn go(
        &mut self,
        to: Px,
        label: &str,
        arrow: bool,
        reduced_motion: bool,
        planner: &dyn MotionPlanner,
        now: Instant,
    ) {
        self.moves += 1;
        let mut request = MoveRequest::new(self.pos, to);
        request.from_heading = self.heading;
        request.seed = format!("mewndo|{}", self.moves);
        request.reduced_motion = reduced_motion;
        self.plan = planner.plan(&request);
        if self.plan.is_empty() {
            // A planner that planned nothing still gets the cursor there.
            self.plan.push(Sample {
                t: 0.0,
                x: to.x,
                y: to.y,
                heading: REST_HEADING,
            });
        }
        self.started = now;
        self.rested = None;
        self.visible = true;
        self.label = shorten(label);
        self.arrow = arrow;
    }

    /// Advance to `now`. True when what is on screen changed.
    pub fn tick(&mut self, now: Instant) -> bool {
        if !self.plan.is_empty() {
            let t = now.saturating_duration_since(self.started).as_secs_f64();
            let s = sample_at(&self.plan, t);
            self.pos = Px::new(s.x, s.y);
            self.heading = s.heading;
            if t >= duration(&self.plan) {
                self.plan.clear();
                self.rested = Some(now);
            }
            return true;
        }
        if self.visible
            && self
                .rested
                .is_some_and(|r| now.saturating_duration_since(r) >= LINGER)
        {
            self.visible = false;
            return true;
        }
        false
    }

    pub fn moving(&self) -> bool {
        !self.plan.is_empty()
    }

    /// How long the overlay thread may sleep before the next `tick` matters; None while there is nothing to do.
    pub fn next_wake(&self, now: Instant) -> Option<Duration> {
        if self.moving() {
            return Some(TICK);
        }
        match (self.visible, self.rested) {
            (true, Some(r)) => Some(LINGER.saturating_sub(now.saturating_duration_since(r))),
            _ => None,
        }
    }
}

/// A label cut to `MAX_LABEL` characters.
pub fn shorten(label: &str) -> String {
    let label = label.trim();
    if label.chars().count() <= MAX_LABEL {
        return label.to_string();
    }
    let mut short: String = label.chars().take(MAX_LABEL - 1).collect();
    short.push('…');
    short
}

fn scaled(v: f64, scale: f64) -> i32 {
    (v * scale).round() as i32
}

/// The arrow's corners for a hotspot at `p` (window pixels) at a display scale (1.0 at 96 dpi).
pub fn arrow_at(p: Px, scale: f64) -> [(i32, i32); 7] {
    ARROW.map(|(x, y)| {
        (
            (p.x + x * scale).round() as i32,
            (p.y + y * scale).round() as i32,
        )
    })
}

/// The chip for a text `text` (width, height) pixels in size: below and right of the hotspot, beside Mewndo's arrow,
/// or a little further out beside cua-driver's own cursor when Mewndo draws no arrow. As (left, top, right, bottom).
pub fn chip_rect(p: Px, text: (i32, i32), scale: f64, arrow: bool) -> (i32, i32, i32, i32) {
    let (x, y) = (p.x.round() as i32, p.y.round() as i32);
    let left = x + scaled(if arrow { 12.0 } else { 22.0 }, scale);
    let top = y + scaled(20.0, scale);
    let width = (text.0.max(0) + scaled(16.0, scale)).min(scaled(CHIP_MAX_W, scale));
    let height = (text.1.max(0) + scaled(8.0, scale)).min(scaled(CHIP_MAX_H, scale));
    (left, top, left + width, top + height)
}

/// Everything the cursor at `p` can paint, arrow and chip, as (left, top, right, bottom): what is repainted when it
/// moves away.
pub fn reach(p: Px, scale: f64) -> (i32, i32, i32, i32) {
    let (x, y) = (p.x.round() as i32, p.y.round() as i32);
    (
        x - scaled(3.0, scale),
        y - scaled(3.0, scale),
        x + scaled(22.0 + CHIP_MAX_W + 3.0, scale),
        y + scaled(20.0 + CHIP_MAX_H + 3.0, scale),
    )
}

/// Starts the overlay thread. Returns what wakes it when a `Show` has been sent.
#[cfg(windows)]
pub fn spawn(
    rx: Receiver<Show>,
    planner: Box<dyn MotionPlanner>,
) -> Result<Box<dyn Fn() + Send + Sync>, String> {
    win::spawn(rx, planner)
}

/// Not Windows: nothing to draw on (§32.5 rule 5). Every `Show` is dropped.
#[cfg(not(windows))]
pub fn spawn(
    rx: Receiver<Show>,
    _planner: Box<dyn MotionPlanner>,
) -> Result<Box<dyn Fn() + Send + Sync>, String> {
    drop(rx);
    Ok(Box::new(|| {}))
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::coords::{Origin, Target, local, to_virtual};
    use std::cell::{Cell, RefCell};
    use std::ptr::{null, null_mut};
    use std::sync::mpsc::TryRecvError;
    use windows_sys::Win32::Foundation::{
        COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, ClientToScreen, CreateFontW, CreatePen,
        CreateSolidBrush, DEFAULT_CHARSET, DEFAULT_PITCH, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX,
        DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW, EndPaint, EnumDisplayMonitors,
        FW_SEMIBOLD, FillRect, GetMonitorInfoW, GetTextExtentPoint32W, HDC, HMONITOR,
        InvalidateRect, MONITORINFO, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_SOLID, Polygon, RoundRect,
        SelectObject, SetBkMode, SetTextColor, TRANSPARENT, UpdateWindow,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetThreadDpiAwarenessContext,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        GetWindowThreadProcessId, IsWindow, LWA_COLORKEY, MONITORINFOF_PRIMARY, MSG,
        MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, PostThreadMessageW, QS_ALLINPUT,
        RegisterClassExW, SPI_GETCLIENTAREAANIMATION, SW_SHOWNOACTIVATE,
        SetLayeredWindowAttributes, SetWindowDisplayAffinity, ShowWindow, SystemParametersInfoW,
        TranslateMessage, WDA_EXCLUDEFROMCAPTURE, WM_APP, WM_DISPLAYCHANGE, WM_DPICHANGED,
        WM_PAINT, WM_QUIT, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        r as u32 | (g as u32) << 8 | (b as u32) << 16
    }
    /// Every pixel of exactly this colour is see-through. Nothing Mewndo draws uses it.
    const KEY: COLORREF = rgb(255, 0, 255);
    // The design tokens (apps/desktop/app/renderer/design/tokens.css): the accent and the ink.
    const ARROW_FILL: COLORREF = rgb(0x1f, 0x6b, 0x9c);
    const ARROW_EDGE: COLORREF = rgb(0xff, 0xff, 0xff);
    const CHIP_FILL: COLORREF = rgb(0x15, 0x17, 0x1a);
    const CHIP_TEXT: COLORREF = rgb(0xee, 0xf1, 0xec);

    struct Screen {
        hwnd: HWND,
        rect: Rect,
        primary: bool,
        /// What the last paint drew in this window, to be repainted clear when the cursor moves.
        painted: Option<RECT>,
    }

    /// What the windows draw. The overlay thread writes it, the window procedure reads it; both on this thread.
    #[derive(Default)]
    struct Frame {
        screens: Vec<Screen>,
        pos: Px,
        label: Vec<u16>,
        arrow: bool,
        visible: bool,
    }

    thread_local! {
        static FRAME: RefCell<Frame> = RefCell::default();
        static REBUILD: Cell<bool> = const { Cell::new(false) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn rect((left, top, right, bottom): (i32, i32, i32, i32)) -> RECT {
        RECT {
            left,
            top,
            right,
            bottom,
        }
    }

    pub fn spawn(
        rx: Receiver<Show>,
        planner: Box<dyn MotionPlanner>,
    ) -> Result<Box<dyn Fn() + Send + Sync>, String> {
        let (ready, started) = std::sync::mpsc::channel::<Result<u32, String>>();
        std::thread::Builder::new()
            .name("mewndo-overlay".into())
            .spawn(move || match setup() {
                Ok(()) => {
                    // SAFETY: no arguments; the id of the thread we are on.
                    let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));
                    run(rx, planner);
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                }
            })
            .map_err(|e| format!("the overlay thread did not start: {e}"))?;
        let thread = started
            .recv()
            .map_err(|_| "the overlay thread ended".to_string())??;
        Ok(Box::new(move || {
            // SAFETY: posts a message with no pointers in it to the overlay thread's queue; if the thread has gone,
            // the call fails and nothing happens.
            unsafe { PostThreadMessageW(thread, WM_APP, 0, 0) };
        }))
    }

    /// Per-monitor-v2 for this thread, the window class, and one window per display.
    fn setup() -> Result<(), String> {
        // SAFETY: plain Win32 calls with valid, null-terminated strings and a zeroed class struct whose required
        // fields are set; the window procedure has the signature Windows expects.
        unsafe {
            if SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_null() {
                return Err(
                    "the agent cursor needs Windows 10 1703 or later (per-monitor DPI v2)".into(),
                );
            }
            let class = wide("MewndoAgentCursor");
            let mut wc: WNDCLASSEXW = std::mem::zeroed();
            wc.cbSize = size_of::<WNDCLASSEXW>() as u32;
            wc.lpfnWndProc = Some(wndproc);
            wc.hInstance = GetModuleHandleW(null());
            wc.hbrBackground = CreateSolidBrush(KEY);
            wc.lpszClassName = class.as_ptr();
            if RegisterClassExW(&wc) == 0 {
                return Err(format!(
                    "the agent cursor's window class was refused: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        let screens = create_windows()?;
        FRAME.with(|f| f.borrow_mut().screens = screens);
        Ok(())
    }

    fn monitors() -> Vec<(Rect, bool)> {
        unsafe extern "system" fn each(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> i32 {
            // SAFETY: `data` is the Vec passed below, alive for the whole enumeration; `info` is sized as Windows
            // requires.
            unsafe {
                let out = &mut *(data as *mut Vec<(Rect, bool)>);
                let mut info: MONITORINFO = std::mem::zeroed();
                info.cbSize = size_of::<MONITORINFO>() as u32;
                if GetMonitorInfoW(m, &mut info) != 0 {
                    let r = info.rcMonitor;
                    out.push((
                        Rect {
                            left: r.left,
                            top: r.top,
                            right: r.right,
                            bottom: r.bottom,
                        },
                        info.dwFlags & MONITORINFOF_PRIMARY != 0,
                    ));
                }
            }
            1
        }
        let mut out: Vec<(Rect, bool)> = Vec::new();
        // SAFETY: the callback only touches `out`, which outlives the call.
        unsafe {
            EnumDisplayMonitors(null_mut(), null(), Some(each), &mut out as *mut _ as LPARAM);
        }
        out
    }

    fn create_windows() -> Result<Vec<Screen>, String> {
        let monitors = monitors();
        if monitors.is_empty() {
            return Err("Windows reported no display".into());
        }
        let class = wide("MewndoAgentCursor");
        let title = wide("Mewndo agent cursor");
        let mut screens = Vec::new();
        for (r, primary) in monitors {
            // SAFETY: a class registered in `setup`, valid strings, no parent, no menu, no creation data.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_LAYERED
                        | WS_EX_TRANSPARENT
                        | WS_EX_TOPMOST
                        | WS_EX_TOOLWINDOW
                        | WS_EX_NOACTIVATE,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_POPUP,
                    r.left,
                    r.top,
                    r.width(),
                    r.height(),
                    null_mut(),
                    null_mut(),
                    GetModuleHandleW(null()),
                    null(),
                )
            };
            if hwnd.is_null() {
                let e = std::io::Error::last_os_error();
                destroy(&screens);
                return Err(format!("the agent cursor's window could not be made: {e}"));
            }
            // SAFETY: `hwnd` is the window just made, on this thread.
            unsafe {
                SetLayeredWindowAttributes(hwnd, KEY, 255, LWA_COLORKEY);
                // Fails before Windows 10 2004; the cursor then shows in captures (top of this file).
                SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                UpdateWindow(hwnd);
            }
            screens.push(Screen {
                hwnd,
                rect: r,
                primary,
                painted: None,
            });
        }
        Ok(screens)
    }

    fn destroy(screens: &[Screen]) {
        for s in screens {
            // SAFETY: windows this thread made.
            unsafe { DestroyWindow(s.hwnd) };
        }
    }

    /// Displays were added, removed, moved or rescaled: new windows for the new layout.
    fn rebuild() {
        let old = FRAME.with(|f| std::mem::take(&mut f.borrow_mut().screens));
        destroy(&old);
        match create_windows() {
            Ok(screens) => FRAME.with(|f| f.borrow_mut().screens = screens),
            Err(e) => eprintln!(
                "mewndo-overlay: the agent cursor is off until the displays change again: {e}"
            ),
        }
    }

    fn run(rx: Receiver<Show>, planner: Box<dyn MotionPlanner>) {
        let mut cursor = Cursor::new(user_pointer().unwrap_or_default(), Instant::now());
        loop {
            let wait = cursor.next_wake(Instant::now()).map_or(u32::MAX, |d| {
                d.as_millis().clamp(1, u32::MAX as u128 - 1) as u32
            });
            // SAFETY: no handles; wakes on any message for this thread (a Show's WM_APP, a paint, a display change).
            unsafe { MsgWaitForMultipleObjects(0, null(), 0, wait, QS_ALLINPUT) };
            if !pump() {
                break;
            }
            if REBUILD.take() {
                rebuild();
            }
            loop {
                match rx.try_recv() {
                    Ok(show) => {
                        if let Some(to) = place(&show) {
                            cursor.go(
                                to,
                                &show.label,
                                show.arrow,
                                reduced_motion(),
                                planner.as_ref(),
                                Instant::now(),
                            );
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        let screens = FRAME.with(|f| std::mem::take(&mut f.borrow_mut().screens));
                        destroy(&screens);
                        return;
                    }
                }
            }
            if cursor.tick(Instant::now()) {
                publish(&cursor);
            }
        }
    }

    /// Handles every waiting message. False on WM_QUIT.
    fn pump() -> bool {
        // SAFETY: a zeroed MSG filled by PeekMessageW; thread messages (hwnd null, our WM_APP wake-up) are not
        // dispatched.
        unsafe {
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, null_mut(), 0, 0, PM_REMOVE) != 0 {
                if msg.message == WM_QUIT {
                    return false;
                }
                if msg.hwnd.is_null() {
                    continue;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        true
    }

    /// The act's point on the virtual screen, or None when it cannot be placed honestly.
    fn place(show: &Show) -> Option<Px> {
        let origin = match show.target {
            Target::Window { pid, window_id } => Origin::Window(client_origin(pid, window_id)?),
            Target::Desktop => Origin::Desktop {
                primary: FRAME.with(|f| {
                    f.borrow()
                        .screens
                        .iter()
                        .find(|s| s.primary)
                        .map(|s| s.rect)
                })?,
                capture: None,
            },
        };
        Some(to_virtual(show.at, origin))
    }

    /// Where a window's client area starts, in physical virtual-screen pixels. **Unconfirmed:** that cua-driver's
    /// `window_id` is the HWND on Windows (docs/decisions.md, "cua-driver" 3). So it is used only when it names a
    /// live window that belongs to the act's `pid`; anything else places nothing.
    fn client_origin(pid: u32, window_id: u64) -> Option<Px> {
        let hwnd = usize::try_from(window_id).ok()? as HWND;
        // SAFETY: IsWindow accepts any value; the other two are called only on a live window.
        unsafe {
            if IsWindow(hwnd) == 0 {
                return None;
            }
            let mut owner = 0u32;
            GetWindowThreadProcessId(hwnd, &mut owner);
            if owner != pid {
                return None;
            }
            let mut p = POINT { x: 0, y: 0 };
            (ClientToScreen(hwnd, &mut p) != 0).then(|| Px::new(p.x as f64, p.y as f64))
        }
    }

    fn user_pointer() -> Option<Px> {
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: writes one POINT.
        (unsafe { GetCursorPos(&mut p) } != 0).then(|| Px::new(p.x as f64, p.y as f64))
    }

    /// Windows' "Show animations in Windows" is off: the cursor jumps instead of gliding.
    fn reduced_motion() -> bool {
        let mut on: i32 = 1;
        // SAFETY: SPI_GETCLIENTAREAANIMATION writes one BOOL.
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                &mut on as *mut i32 as *mut core::ffi::c_void,
                0,
            )
        };
        ok != 0 && on == 0
    }

    fn scale_of(hwnd: HWND) -> f64 {
        // SAFETY: a window this thread made.
        match unsafe { GetDpiForWindow(hwnd) } {
            0 => 1.0,
            dpi => dpi as f64 / 96.0,
        }
    }

    /// The cursor moved, appeared or hid: hand the windows the new frame and mark what must be repainted.
    fn publish(c: &Cursor) {
        FRAME.with(|f| {
            let mut f = f.borrow_mut();
            f.pos = c.pos;
            f.visible = c.visible;
            f.arrow = c.arrow;
            f.label = c.label.encode_utf16().collect();
            for s in &f.screens {
                // SAFETY: windows this thread made; InvalidateRect only marks, it paints nothing now.
                unsafe {
                    if let Some(old) = s.painted {
                        InvalidateRect(s.hwnd, &old, 0);
                    }
                    if c.visible {
                        let r = rect(reach(local(c.pos, s.rect), scale_of(s.hwnd)));
                        if r.right > 0
                            && r.bottom > 0
                            && r.left < s.rect.width()
                            && r.top < s.rect.height()
                        {
                            InvalidateRect(s.hwnd, &r, 0);
                        }
                    }
                }
            }
        });
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_DISPLAYCHANGE | WM_DPICHANGED => {
                REBUILD.set(true);
                0
            }
            // SAFETY: Windows' own default handling, with the arguments it gave us.
            _ => unsafe { DefWindowProcW(hwnd, msg, w, l) },
        }
    }

    fn paint(hwnd: HWND) {
        // SAFETY: BeginPaint/EndPaint bracket the drawing on this window's DC; every GDI object made is selected
        // out and deleted before EndPaint.
        unsafe {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let dc = BeginPaint(hwnd, &mut ps);
            let key = CreateSolidBrush(KEY);
            FillRect(dc, &ps.rcPaint, key);
            DeleteObject(key);
            FRAME.with(|f| {
                // A paint while the frame is being changed (a window being made) draws the clear background only.
                let Ok(mut f) = f.try_borrow_mut() else {
                    return;
                };
                let (pos, visible, arrow, label) = (f.pos, f.visible, f.arrow, f.label.clone());
                let Some(screen) = f.screens.iter_mut().find(|s| s.hwnd == hwnd) else {
                    return;
                };
                screen.painted = None;
                if !visible {
                    return;
                }
                let scale = scale_of(hwnd);
                let p = local(pos, screen.rect);
                if arrow {
                    draw_arrow(dc, p, scale);
                }
                draw_chip(dc, p, &label, scale, arrow);
                screen.painted = Some(rect(reach(p, scale)));
            });
            EndPaint(hwnd, &ps);
        }
    }

    unsafe fn draw_arrow(dc: HDC, p: Px, scale: f64) {
        let points = arrow_at(p, scale).map(|(x, y)| POINT { x, y });
        // SAFETY: the caller's paint DC; objects restored and deleted below.
        unsafe {
            let pen = CreatePen(PS_SOLID, scaled(1.5, scale).max(1), ARROW_EDGE);
            let brush = CreateSolidBrush(ARROW_FILL);
            let (old_pen, old_brush) = (SelectObject(dc, pen), SelectObject(dc, brush));
            Polygon(dc, points.as_ptr(), points.len() as i32);
            SelectObject(dc, old_pen);
            SelectObject(dc, old_brush);
            DeleteObject(pen);
            DeleteObject(brush);
        }
    }

    unsafe fn draw_chip(dc: HDC, p: Px, label: &[u16], scale: f64, arrow: bool) {
        if label.is_empty() {
            return;
        }
        let face = wide("Segoe UI");
        let n = label.len() as i32;
        // SAFETY: the caller's paint DC; `label` and `face` outlive the calls; objects restored and deleted below.
        unsafe {
            let font = CreateFontW(
                -scaled(12.0, scale),
                0,
                0,
                0,
                FW_SEMIBOLD as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                DEFAULT_PITCH as u32,
                face.as_ptr(),
            );
            let old_font = SelectObject(dc, font);
            let mut size = SIZE { cx: 0, cy: 0 };
            GetTextExtentPoint32W(dc, label.as_ptr(), n, &mut size);
            let chip = chip_rect(p, (size.cx, size.cy), scale, arrow);
            let brush = CreateSolidBrush(CHIP_FILL);
            let pen = CreatePen(PS_SOLID, 1, CHIP_FILL);
            let (old_pen, old_brush) = (SelectObject(dc, pen), SelectObject(dc, brush));
            let round = scaled(10.0, scale);
            RoundRect(dc, chip.0, chip.1, chip.2, chip.3, round, round);
            SetBkMode(dc, TRANSPARENT as i32);
            SetTextColor(dc, CHIP_TEXT);
            let mut text = rect(chip);
            DrawTextW(
                dc,
                label.as_ptr(),
                n,
                &mut text,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS,
            );
            SelectObject(dc, old_pen);
            SelectObject(dc, old_brush);
            SelectObject(dc, old_font);
            DeleteObject(pen);
            DeleteObject(brush);
            DeleteObject(font);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motion::Glide;

    #[test]
    fn a_cursor_glides_to_the_act_then_lingers_then_hides() {
        let t0 = Instant::now();
        let mut c = Cursor::new(Px::new(-1500.0, 300.0), t0);
        assert!(
            !c.visible && c.next_wake(t0).is_none(),
            "hidden and idle until an act"
        );
        c.go(
            Px::new(812.0, 411.0),
            "Claude · clicking",
            true,
            false,
            &Glide,
            t0,
        );
        assert!(c.visible && c.moving());
        assert_eq!(c.next_wake(t0), Some(TICK));
        assert!(c.tick(t0));
        assert_eq!(
            c.pos,
            Px::new(-1500.0, 300.0),
            "it leaves from where it was"
        );
        assert!(c.tick(t0 + Duration::from_millis(100)));
        assert!(
            c.pos.x > -1500.0 && c.pos.x < 812.0,
            "on its way: {:?}",
            c.pos
        );
        let arrived = t0 + Duration::from_secs(1);
        assert!(c.tick(arrived));
        assert_eq!(c.pos, Px::new(812.0, 411.0));
        assert!(!c.moving() && c.visible);
        assert_eq!(c.next_wake(arrived), Some(LINGER));
        assert!(
            !c.tick(arrived + Duration::from_secs(1)),
            "resting: nothing to redraw"
        );
        assert!(c.tick(arrived + LINGER), "hidden after LINGER");
        assert!(!c.visible && c.next_wake(arrived + LINGER).is_none());
        // The next act leaves from where the last one ended.
        c.go(
            Px::new(0.0, 0.0),
            "Claude · typing",
            true,
            true,
            &Glide,
            arrived + LINGER,
        );
        assert!(c.tick(arrived + LINGER));
        assert_eq!(c.pos, Px::new(0.0, 0.0), "reduced motion: there at once");
        assert_eq!(c.label, "Claude · typing");
    }

    #[test]
    fn a_new_act_mid_glide_starts_from_where_the_cursor_is() {
        let t0 = Instant::now();
        let mut c = Cursor::new(Px::new(0.0, 0.0), t0);
        c.go(Px::new(1000.0, 0.0), "a", true, false, &Glide, t0);
        c.tick(t0 + Duration::from_millis(150));
        let mid = c.pos;
        assert!(mid.x > 0.0 && mid.x < 1000.0);
        c.go(
            Px::new(0.0, 500.0),
            "b",
            false,
            false,
            &Glide,
            t0 + Duration::from_millis(150),
        );
        c.tick(t0 + Duration::from_millis(150));
        assert_eq!(c.pos, mid);
        assert!(!c.arrow, "chip only: the driver's cursor is showing");
    }

    #[test]
    fn long_labels_are_cut() {
        assert_eq!(shorten("  Claude · clicking "), "Claude · clicking");
        let long = "x".repeat(MAX_LABEL + 10);
        let cut = shorten(&long);
        assert_eq!(cut.chars().count(), MAX_LABEL);
        assert!(cut.ends_with('…'));
        assert_eq!(shorten(&"y".repeat(MAX_LABEL)), "y".repeat(MAX_LABEL));
    }

    #[test]
    fn everything_drawn_is_inside_what_is_repainted() {
        for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
            for p in [Px::new(0.0, 0.0), Px::new(812.4, 411.6), Px::new(-3.5, 7.2)] {
                let (l, t, r, b) = reach(p, scale);
                let pen = scaled(1.5, scale).max(1);
                for (x, y) in arrow_at(p, scale) {
                    assert!(
                        x - pen >= l && x + pen <= r && y - pen >= t && y + pen <= b,
                        "arrow at {scale}"
                    );
                }
                for arrow in [true, false] {
                    // Even a label far too long for the chip stays inside: the chip is capped.
                    for text in [(0, 0), (90, 16), (5000, 400)] {
                        let (cl, ct, cr, cb) = chip_rect(p, text, scale, arrow);
                        assert!(
                            cl >= l && ct >= t && cr <= r && cb <= b,
                            "chip {text:?} at {scale}"
                        );
                        assert!(
                            cl > p.x as i32 && ct > p.y as i32,
                            "below and right of the hotspot"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_chip_sits_further_out_beside_the_drivers_own_cursor() {
        let p = Px::new(100.0, 100.0);
        assert!(chip_rect(p, (80, 16), 1.0, false).0 > chip_rect(p, (80, 16), 1.0, true).0);
        assert_eq!(
            chip_rect(p, (80, 16), 2.0, true),
            (124, 140, 124 + 112, 140 + 32)
        );
    }

    #[test]
    fn the_arrow_scales_with_the_display() {
        assert_eq!(arrow_at(Px::new(10.0, 20.0), 1.0)[3], (17, 40));
        assert_eq!(arrow_at(Px::new(10.0, 20.0), 2.0)[3], (24, 60));
        assert_eq!(
            arrow_at(Px::new(10.0, 20.0), 2.0)[0],
            (10, 20),
            "the hotspot is the tip"
        );
    }
}
