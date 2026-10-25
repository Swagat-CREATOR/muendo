// Typing a message the user confirmed into an idle agent's terminal (docs/decisions.md, "Typing into an idle agent's
// terminal"). The user approved this with four limits, and this file is where each one holds:
//
//   (a) Only text the user entered in Mewndo's capsule: the text comes from `agent.message`, which only the app
//       sends, from the Talk box or a card's reply.
//   (b) Only into the console of an agent process Mewndo's own hook reported: the pid is `hook.request`'s
//       `console_pid`, kept per agent by the mailbox, and nothing else is ever a target.
//   (c) Shown first, typed only after the user confirms: `agent.message` answers `confirm` with the exact text
//       (`preview`); `agent.type {offer_id}` types the stored text, once, within a minute, and carries no text.
//   (d) Never on argv, never logged, never on disk: the helper is `mewndo-core type-into --pid N` with the text on
//       its stdin; the log says only how many characters went to which agent.
//
// How: a process can be attached to only one console, and the core must keep its own, so the typing is done by a
// short-lived helper (this same binary). It frees whatever console it has, attaches to the agent's, opens CONIN$
// and writes one key-down and one key-up per UTF-16 unit, then Enter, with WriteConsoleInputW. That is the same
// input a keyboard produces, so the agent reads it at its prompt as if the user had typed it.
//
// Honest limits (§28.10): Windows only. Whether the agent sees the keys as typing depends on how its terminal
// reads input (Windows Terminal and ConPTY, Ink's raw mode); that is not verified here (docs/known-issues.md).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an offer can be confirmed. Long enough to read it; short enough that "Type it" can't land in a
/// conversation that has moved on.
pub const OFFER_TTL: Duration = Duration::from_secs(60);
/// The most characters one offer types.
pub const MAX_CHARS: usize = 2000;
/// How long the helper may take before the core kills it.
#[cfg(windows)]
pub const HELPER_DEADLINE: Duration = Duration::from_secs(3);
/// The Enter key.
pub const VK_RETURN: u16 = 0x0D;

/// The text as it will be typed, which is also what the user is shown: newlines and tabs become spaces (an Enter
/// in the middle would send half a message), control characters and the invisible direction overrides that could
/// make the preview read differently from what is typed are removed, then it is trimmed and cut to `MAX_CHARS`.
pub fn normalise(text: &str) -> String {
    let flat: String = text
        .replace("\r\n", "\n")
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' | '\u{2028}' | '\u{2029}' => Some(' '),
            '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    let kept: String = flat.trim().chars().take(MAX_CHARS).collect();
    kept.trim_end().to_string()
}

/// One console key event: `unit` is the UTF-16 code unit it carries, `vk` its virtual key (0 for text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Key {
    pub down: bool,
    pub vk: u16,
    pub unit: u16,
}

/// The key events that type `text` and press Enter: a down and an up for every UTF-16 unit (a character outside
/// the Basic Multilingual Plane is two units, as a keyboard would send it), then Enter as VK_RETURN with '\r'.
pub fn keys(text: &str) -> Vec<Key> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    for unit in text.encode_utf16() {
        out.push(Key {
            down: true,
            vk: 0,
            unit,
        });
        out.push(Key {
            down: false,
            vk: 0,
            unit,
        });
    }
    for down in [true, false] {
        out.push(Key {
            down,
            vk: VK_RETURN,
            unit: u16::from(b'\r'),
        });
    }
    out
}

/// One `confirm` the user has been shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Offer {
    pub id: String,
    pub agent_id: String,
    pub name: String,
    /// Already normalised: exactly the preview.
    pub text: String,
    pub pid: u32,
    pub expires: Instant,
}

/// Why `agent.type` can't use an offer.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// Never made, already used, or replaced by a newer offer for the same agent.
    Unknown,
    /// Made, but not confirmed within `OFFER_TTL`.
    Expired { agent_id: String, name: String },
}

/// The offers waiting for the user. Each is used at most once, and an agent has at most one: a newer `confirm`
/// for it replaces the older, so "Type it" always types the text the box shows now.
#[derive(Default)]
pub struct Offers(Mutex<HashMap<String, Offer>>);

impl Offers {
    pub fn create(&self, agent_id: &str, name: &str, text: &str, pid: u32, now: Instant) -> Offer {
        let offer = Offer {
            id: ulid::Ulid::new().to_string(),
            agent_id: agent_id.to_string(),
            name: name.to_string(),
            text: text.to_string(),
            pid,
            expires: now + OFFER_TTL,
        };
        let mut offers = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Expired offers stay a while so a late "Type it" hears "expired" rather than "unknown"; then they go.
        offers.retain(|_, o| o.agent_id != agent_id && o.expires + OFFER_TTL > now);
        offers.insert(offer.id.clone(), offer.clone());
        offer
    }

    /// The offer, removed so it can never be used twice.
    pub fn take(&self, id: &str, now: Instant) -> Result<Offer, Refused> {
        let offer = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .ok_or(Refused::Unknown)?;
        if now >= offer.expires {
            return Err(Refused::Expired {
                agent_id: offer.agent_id,
                name: offer.name,
            });
        }
        Ok(offer)
    }
}

/// What types the text: the helper on Windows; a fake in tests.
pub type Typer = std::sync::Arc<dyn Fn(u32, &str) -> Result<(), String> + Send + Sync>;

/// The real typer, on the one platform that has one.
pub fn typer() -> Option<Typer> {
    #[cfg(windows)]
    {
        let helper: Typer = std::sync::Arc::new(spawn_helper);
        Some(helper)
    }
    #[cfg(not(windows))]
    None
}

/// Runs `mewndo-core type-into --pid N` with the text on stdin, and waits at most `HELPER_DEADLINE`. Blocking:
/// the core calls it from `spawn_blocking`. The error is the helper's own short reason, which never holds the text.
#[cfg(windows)]
fn spawn_helper(pid: u32, text: &str) -> Result<(), String> {
    use std::io::{Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, DETACHED_PROCESS};

    let exe = std::env::current_exe().map_err(|e| format!("can't find mewndo-core ({e})"))?;
    let mut child = Command::new(exe)
        .args(["type-into", "--pid", &pid.to_string()])
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("can't start the typing helper ({e})"))?;
    // On its own thread, so a helper that never reads can't hold the core past the deadline; killing it closes
    // the pipe and ends the write.
    if let Some(mut stdin) = child.stdin.take() {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
    let deadline = Instant::now() + HELPER_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("the agent's terminal did not take the keys within 3 seconds".into());
            }
            Err(e) => return Err(format!("lost the typing helper ({e})")),
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut why = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.by_ref().take(512).read_to_string(&mut why);
    }
    let why = why.trim();
    Err(if why.is_empty() {
        format!("the typing helper failed ({status})")
    } else {
        why.to_string()
    })
}

/// `mewndo-core type-into --pid N`, with the text on stdin. Exit 0 once it is typed; otherwise non-zero with a
/// short reason on stderr, which never holds the text.
pub fn run_helper() -> std::process::ExitCode {
    use std::io::Read;
    use std::process::ExitCode;
    let mut args = std::env::args().skip(2);
    let pid = match (
        args.next().as_deref(),
        args.next().map(|p| p.parse::<u32>()),
    ) {
        (Some("--pid"), Some(Ok(pid))) if pid != 0 => pid,
        _ => {
            eprintln!("usage: mewndo-core type-into --pid <agent process id>  (text on stdin)");
            return ExitCode::from(2);
        }
    };
    // Read a little past the cap so an over-long text is cut by `normalise`, never by a short read.
    let mut raw = String::new();
    if std::io::stdin()
        .take((MAX_CHARS * 4 + 64) as u64)
        .read_to_string(&mut raw)
        .is_err()
    {
        eprintln!("the text was not readable");
        return ExitCode::FAILURE;
    }
    let text = normalise(&raw);
    if text.is_empty() {
        eprintln!("there was nothing to type");
        return ExitCode::FAILURE;
    }
    match type_keys(pid, &keys(&text)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("{why}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn type_keys(_pid: u32, _keys: &[Key]) -> Result<(), String> {
    Err("typing into a terminal works only on Windows".into())
}

/// Detach from any console, attach to the agent's, write the keys into its input, detach again.
#[cfg(windows)]
fn type_keys(pid: u32, keys: &[Key]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, GetLastError, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, INPUT_RECORD, INPUT_RECORD_0, KEY_EVENT, KEY_EVENT_RECORD,
        KEY_EVENT_RECORD_0, WriteConsoleInputW,
    };

    // SAFETY: plain calls with no pointers. FreeConsole fails harmlessly when there is no console (the helper is
    // started detached).
    unsafe { FreeConsole() };
    if unsafe { AttachConsole(pid) } == 0 {
        // SAFETY: reads this thread's last error.
        let code = unsafe { GetLastError() };
        return Err(format!(
            "could not attach to the agent's terminal (error {code})"
        ));
    }
    let written = (|| {
        let name: Vec<u16> = "CONIN$".encode_utf16().chain([0]).collect();
        // SAFETY: a NUL-terminated name, no security attributes and no template; the handle is checked.
        let input = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if input == INVALID_HANDLE_VALUE {
            // SAFETY: as above.
            let code = unsafe { GetLastError() };
            return Err(format!(
                "could not open the agent's terminal input (error {code})"
            ));
        }
        let records: Vec<INPUT_RECORD> = keys
            .iter()
            .map(|k| INPUT_RECORD {
                EventType: KEY_EVENT as u16,
                Event: INPUT_RECORD_0 {
                    KeyEvent: KEY_EVENT_RECORD {
                        bKeyDown: i32::from(k.down),
                        wRepeatCount: 1,
                        wVirtualKeyCode: k.vk,
                        wVirtualScanCode: 0,
                        uChar: KEY_EVENT_RECORD_0 {
                            UnicodeChar: k.unit,
                        },
                        dwControlKeyState: 0,
                    },
                },
            })
            .collect();
        let mut at = 0;
        let mut result = Ok(());
        while at < records.len() {
            let mut n = 0u32;
            let left = &records[at..];
            // SAFETY: an open console input handle, `left.len()` initialised records, and a writable count.
            let ok = unsafe { WriteConsoleInputW(input, left.as_ptr(), left.len() as u32, &mut n) };
            if ok == 0 || n == 0 {
                // SAFETY: as above.
                let code = unsafe { GetLastError() };
                result = Err(format!(
                    "the agent's terminal stopped taking keys after {at} of {} (error {code})",
                    records.len()
                ));
                break;
            }
            at += n as usize;
        }
        // SAFETY: a handle this closure owns, closed once.
        unsafe { CloseHandle(input) };
        result
    })();
    // SAFETY: a plain call.
    unsafe { FreeConsole() };
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preview_is_one_clean_line_and_exactly_what_is_typed() {
        assert_eq!(
            normalise("  fix the dates\r\nthen\trun the tests \n"),
            "fix the dates then run the tests"
        );
        // Control characters, escapes and the invisible direction overrides are gone; other text is kept as is.
        assert_eq!(
            normalise("a\u{1b}[31mb\u{7}c\u{0}d\u{202e}e\u{2066}f é 日本 🦀"),
            "a[31mbcdef é 日本 🦀"
        );
        assert_eq!(normalise("\n\t \u{1}"), "");
        let long = "x".repeat(MAX_CHARS + 10);
        assert_eq!(normalise(&long).chars().count(), MAX_CHARS);
        // Cut at the limit, then trimmed again, so the preview never ends in a space.
        let edge = format!("{} y", "x".repeat(MAX_CHARS - 1));
        assert_eq!(normalise(&edge), "x".repeat(MAX_CHARS - 1));
        // Normalising twice changes nothing: the helper normalises again, and types the same text.
        let once = normalise("one\ntwo\u{1}");
        assert_eq!(normalise(&once), once);
    }

    #[test]
    fn every_unit_is_a_key_down_and_up_and_enter_comes_last() {
        let k = keys("hi");
        assert_eq!(k.len(), 6);
        assert_eq!(
            k[..2],
            [
                Key {
                    down: true,
                    vk: 0,
                    unit: u16::from(b'h')
                },
                Key {
                    down: false,
                    vk: 0,
                    unit: u16::from(b'h')
                }
            ]
        );
        assert_eq!(
            k[4..],
            [
                Key {
                    down: true,
                    vk: VK_RETURN,
                    unit: 13
                },
                Key {
                    down: false,
                    vk: VK_RETURN,
                    unit: 13
                }
            ]
        );
        // A crab is two UTF-16 units, so two downs and two ups, in order.
        let crab = keys("🦀");
        let units: Vec<u16> = "🦀".encode_utf16().collect();
        assert_eq!(crab.len(), 6);
        assert_eq!(
            (crab[0].unit, crab[2].unit),
            (units[0], units[1]),
            "{crab:?}"
        );
        assert!(crab[..4].iter().all(|k| k.vk == 0));
        assert_eq!(keys("").len(), 2, "an empty text is only Enter");
    }

    #[test]
    fn an_offer_is_used_once_within_its_minute() {
        let offers = Offers::default();
        let now = Instant::now();
        let offer = offers.create("a1", "Claude Code", "use UTC", 42, now);
        assert_eq!((offer.text.as_str(), offer.pid), ("use UTC", 42));
        assert_eq!(offers.take("nope", now), Err(Refused::Unknown));
        let taken = offers
            .take(&offer.id, now + Duration::from_secs(59))
            .unwrap();
        assert_eq!(taken, offer);
        assert_eq!(
            offers.take(&offer.id, now),
            Err(Refused::Unknown),
            "used: gone"
        );

        let late = offers.create("a1", "Claude Code", "use UTC", 42, now);
        assert_eq!(
            offers.take(&late.id, now + OFFER_TTL),
            Err(Refused::Expired {
                agent_id: "a1".into(),
                name: "Claude Code".into()
            })
        );
        assert_eq!(offers.take(&late.id, now), Err(Refused::Unknown));
    }

    #[test]
    fn a_newer_offer_for_the_same_agent_replaces_the_older() {
        let offers = Offers::default();
        let now = Instant::now();
        let first = offers.create("a1", "Codex", "one", 7, now);
        let other = offers.create("a2", "Cursor", "elsewhere", 8, now);
        let second = offers.create("a1", "Codex", "two", 7, now);
        assert_eq!(offers.take(&first.id, now), Err(Refused::Unknown));
        assert_eq!(offers.take(&second.id, now).unwrap().text, "two");
        assert_eq!(offers.take(&other.id, now).unwrap().text, "elsewhere");
        // Long-expired offers are dropped when the next one is made.
        let old = offers.create("a3", "Codex", "old", 9, now);
        offers.create("a4", "Codex", "new", 9, now + OFFER_TTL * 3);
        assert_eq!(
            offers.take(&old.id, now + OFFER_TTL * 3),
            Err(Refused::Unknown)
        );
    }

    #[test]
    fn off_windows_there_is_no_typer_and_the_helper_refuses() {
        if cfg!(not(windows)) {
            assert!(typer().is_none());
            assert!(type_keys(1, &keys("hi")).is_err());
        }
    }
}
