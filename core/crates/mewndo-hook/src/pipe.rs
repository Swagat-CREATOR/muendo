// Finding the core and talking to it (spec §33.10 B2 and B3).
//
// The core writes `%LOCALAPPDATA%\Mewndo\core.json` = `{pipe, pid, version, protocol}` atomically
// (mewndo-core/src/desk.rs `write_core_json`), so the one thing the forwarder has to know is that folder.
// Everything else -- the 8 random hex digits in the pipe name, the user-only DACL on it -- is the core's
// business and arrives in that file.
//
// One connection, one request, one answer, then exit. No pooling, no keepalive: the process lives for a few
// milliseconds, and a pool would mean a second process and shared state for no gain.
use mewndo_proto::{Envelope, Frame, HEADER, Hello, HookRequest, HookResponse, Role, encode};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// The connection to the core: a named pipe handle on Windows, a Unix socket elsewhere.
///
/// §32.5 rule 5: Windows-only code sits behind `#[cfg(windows)]` with a stub for other targets, so the whole
/// forwarder -- argv, the 4 MB cap, the handshake, fail open -- is testable in WSL. The core does exactly the
/// same split (desk.rs `listen`), and its own integration test connects this same way.
#[cfg(windows)]
pub type Pipe = std::fs::File;
#[cfg(not(windows))]
pub type Pipe = std::os::unix::net::UnixStream;

/// Windows: every instance of the pipe is busy for the moment. The core always creates the next instance
/// before serving the one it just accepted (§33.10 A4), so this is rare and short-lived.
#[cfg(windows)]
const ERROR_PIPE_BUSY: i32 = 231;

/// §33.10 B2: on ERROR_PIPE_BUSY, wait for an instance for 2 s and retry *once*. One retry, not a loop: a
/// core that cannot free an instance in two seconds is a core the user is already waiting on, and failing
/// open is faster and safer than queueing behind it.
#[cfg(windows)]
const PIPE_BUSY_WAIT_MS: u32 = 2000;

// WaitNamedPipeW is the only Win32 call in this crate, so it is declared here instead of pulling in
// windows-sys: that crate exports nothing without the right feature flags, and the forwarder's whole point
// is to start fast and carry nothing it does not need.
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
}

/// Mewndo's data folder: where the core puts `core.json` and `deny-cache.json`.
///
/// §33.10 B2 and B5 name `%LOCALAPPDATA%\Mewndo`. `MEWNDO_DESK_DIR` overrides it, which is how the tests
/// point a forwarder at a temporary folder and how a developer can run a second core next to a real one;
/// mewndo-core takes the same folder as `--desk <folder>` rather than assuming it, for the same reason.
/// plot.md rule 1: this is app data, never inside a protected folder.
pub fn desk_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MEWNDO_DESK_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    #[cfg(windows)]
    return std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Mewndo"));
    // Not a real location on Linux -- Mewndo is a Windows app -- but it keeps the WSL tests and `cargo test`
    // free of `#[cfg]` at every call site, exactly as mewndo-router's `user_rules_path` does.
    #[cfg(not(windows))]
    return std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .map(|d| d.join("Mewndo"));
}

/// The pipe name (Windows) or socket path (elsewhere) from `core.json`.
///
/// A missing, half-written or stale file is an ordinary outcome, not an error worth reporting: the core is
/// simply not running, and §33.10 B5 says what to do about it.
pub fn pipe_name(dir: &Path) -> Option<String> {
    let bytes = std::fs::read(dir.join("core.json")).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let pipe = json.get("pipe")?.as_str()?.trim();
    (!pipe.is_empty()).then(|| pipe.to_string())
}

/// §33.10 B2: open the pipe for reading and writing, exactly as the spec spells it out.
#[cfg(windows)]
pub fn connect(pipe: &str) -> io::Result<Pipe> {
    let open = || {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pipe)
    };
    match open() {
        Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
            let wide: Vec<u16> = pipe.encode_utf16().chain([0]).collect();
            // A false return means the wait timed out; the retry then produces the real error for the caller
            // to fail open on, so the return value needs no separate branch.
            unsafe { WaitNamedPipeW(wide.as_ptr(), PIPE_BUSY_WAIT_MS) };
            open()
        }
        other => other,
    }
}

/// The non-Windows stub (§32.5 rule 5): the core listens on a Unix socket in the same desk folder, so the
/// same `core.json` field carries a path here instead of a pipe name.
#[cfg(not(windows))]
pub fn connect(pipe: &str) -> io::Result<Pipe> {
    std::os::unix::net::UnixStream::connect(pipe)
}

/// A frame the core can send back that this request will never be the answer to. 64 of them and the
/// forwarder gives up and fails open, so a chatty or confused core cannot hold the agent forever.
const MAX_SPURIOUS_FRAMES: usize = 64;

/// §33.10 B3: `hello {role: "hook"}`, then `hook.request`, then block for the `hook.response`.
///
/// Both frames go out in one write. The core reads them in order anyway (desk.rs waits for `hello`, answers
/// `pong`, then serves requests), so pipelining them saves a whole round trip on the one path that every
/// agent action waits for -- about half the forwarder's time with a warm core.
///
/// There is deliberately no deadline here. §38.4 gives each event the agent's own timeout (5 s for
/// `PreToolUse`, 300 s for `PermissionRequest`, 130 s for `Stop`) and §33.10 Part D has the core holding a
/// permission card for up to 295 s: a timeout of our own would cut those waits short and break the Inbox.
/// Honestly stated (§28.10): a core that accepts the connection and then never answers will keep the hook
/// waiting until the *agent* times it out. A core that is simply gone fails open at once, which is the case
/// the spec puts a number on.
pub fn round_trip(pipe: &mut Pipe, request: &HookRequest) -> io::Result<HookResponse> {
    // Unique enough to pair a reply with a request, and free: this process makes exactly one.
    let id = format!("hook-{}", std::process::id());
    let mut out = encode(&Frame::Json(Envelope::wrap(
        "hello",
        &Hello { role: Role::Hook },
    )))
    .map_err(bad_data)?;
    out.extend_from_slice(
        &encode(&Frame::Json(Envelope::wrap(id.as_str(), request))).map_err(bad_data)?,
    );
    pipe.write_all(&out)?;
    pipe.flush()?;

    for _ in 0..MAX_SPURIOUS_FRAMES {
        match read_frame(pipe)? {
            // The first `hook.response` wins whatever its id: one request per connection, so there is
            // nothing it could be confused with, and a core that does not echo ids still works.
            Frame::Json(env) if env.kind == "hook.response" => {
                return env.open::<HookResponse>().map_err(bad_data);
            }
            // `error` with our id is the core saying it cannot answer this request -- today's core does
            // exactly that, because `hook.request` arrives with Part C. No answer is coming: fail open.
            Frame::Json(env) if env.kind == "error" && (env.id == id || env.id.is_empty()) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("the core refused the request: {}", env.body),
                ));
            }
            // `pong` for the hello, or anything else: keep reading.
            _ => {}
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "the core sent no hook.response",
    ))
}

fn bad_data<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// One frame: the 5-byte header first, so a bad or oversized length is refused by mewndo-proto before any
/// payload buffer is allocated.
fn read_frame(pipe: &mut Pipe) -> io::Result<Frame> {
    let mut head = [0u8; HEADER];
    pipe.read_exact(&mut head)?;
    let (kind, len) = mewndo_proto::header(&head).map_err(bad_data)?;
    let mut body = vec![0u8; len];
    pipe.read_exact(&mut body)?;
    mewndo_proto::payload(kind, &body).map_err(bad_data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder per test, so tests that set MEWNDO_DESK_DIR-style paths never collide.
    fn temp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("mewndo-hook-pipe-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_pipe_name_comes_from_core_json_and_junk_is_simply_absent() {
        let d = temp("corejson");
        assert_eq!(pipe_name(&d), None, "no core.json: the core is not running");

        std::fs::write(
            d.join("core.json"),
            r#"{"pipe":"\\\\.\\pipe\\mewndo-core-deadbeef","pid":4,"version":"0.1.0","protocol":2}"#,
        )
        .unwrap();
        assert_eq!(pipe_name(&d).unwrap(), r"\\.\pipe\mewndo-core-deadbeef");

        for junk in [r#"{"pipe":""}"#, r#"{"pipe":7}"#, "{", "", "null"] {
            std::fs::write(d.join("core.json"), junk).unwrap();
            assert_eq!(pipe_name(&d), None, "{junk}");
        }
    }

    // MEWNDO_DESK_DIR is not exercised here on purpose: `set_var` is process-wide and `cargo test` runs unit
    // tests in parallel threads, so one test's env change is every other test's bug. The integration tests
    // pass MEWNDO_DESK_DIR to a child forwarder instead, which is also how the real thing is configured.

    #[test]
    fn connecting_to_a_core_that_is_not_there_is_an_error_not_a_hang() {
        let d = temp("nocore");
        let missing = d.join("core-nothing.sock");
        assert!(connect(&missing.to_string_lossy()).is_err());
    }
}
