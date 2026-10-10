// The Agent Desk pipe: protocol v2 (spec §33.10 Part A, §38.5), framed by mewndo-proto. It runs alongside the v1
// JSON-lines socket the app and engine use today (protocol.rs), and only when the core is started with
// `--desk <folder>`, normally %LOCALAPPDATA%\Mewndo (docs/decisions.md, "Pipe protocol v2").
//
// In that folder: core.json = {pipe, pid, version, protocol}, so the hook forwarder and the app can find the pipe,
// and desk.db (writer.rs). One core per folder: a named mutex on Windows, a lock file elsewhere.
//
// Every connection starts with `hello {role}`. App connections also receive everything published to the desk;
// hook, computer and overlay connections are request and response.
use crate::desk_agents::{Agents, Publisher};
use crate::desk_lanes::DeskLanes;
use crate::log::Log;
use crate::writer::{self, Writer};
use mewndo_proto::{
    self as proto, Body, ComputerAction, Envelope, ErrorBody, Frame, HEADER, Hello, HookRequest,
    InboxAnswer, InboxUndo, LaneAttach, LaneBrake, LaneClose, LaneOpen, LaneReply, LaneResize,
    Ping, Pong, Role, RouteRequest, VERSION,
};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc, watch};

// Generous: the app's main thread can be busy for seconds at start-up before its connect callback runs; this only
// drops connections that never say anything.
const HELLO_WAIT: Duration = Duration::from_secs(30);

pub struct Desk {
    events: broadcast::Sender<Arc<Vec<u8>>>,
    writer: Arc<Writer>,
    agents: Agents,
    lanes: DeskLanes,
    log: Arc<Log>,
}

impl Desk {
    /// `dir`: the desk folder. `data_dir`: v0's data folder (save points go through its hook server).
    /// `rules_file`: the user's rules.toml, or None to use the built-in rules and keep habits in memory.
    pub fn new(dir: &Path, data_dir: PathBuf, rules_file: Option<PathBuf>, log: Arc<Log>) -> Desk {
        let events = broadcast::channel(1024).0;
        let writer = Arc::new(writer::start(&dir.join("desk.db"), log.clone()));
        Desk {
            agents: Agents::start(
                data_dir,
                rules_file,
                writer.clone(),
                Publisher(events.clone()),
                log.clone(),
            ),
            lanes: DeskLanes::new(Publisher(events.clone()), log.clone()),
            events,
            writer,
            log,
        }
    }
}

// --- one core per desk folder -------------------------------------------------------------------------------------

/// Held for as long as the core runs; a second core for the same folder can't get one.
pub struct Instance {
    pub dir: PathBuf,
    #[cfg(unix)]
    _lock: std::fs::File,
}

#[cfg(unix)]
pub fn claim(dir: &Path) -> io::Result<Instance> {
    use std::os::unix::io::AsRawFd;
    std::fs::create_dir_all(dir)?;
    let lock = std::fs::File::create(dir.join("core.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(already_running(dir));
    }
    Ok(Instance {
        dir: dir.to_path_buf(),
        _lock: lock,
    })
}

#[cfg(windows)]
pub fn claim(dir: &Path) -> io::Result<Instance> {
    use windows_sys::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::System::Threading::CreateMutexW;
    std::fs::create_dir_all(dir)?;
    let name = wide(&mutex_name(dir));
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(already_running(dir));
    }
    // The handle is never closed: Windows releases the mutex when this process ends, however it ends.
    Ok(Instance {
        dir: dir.to_path_buf(),
    })
}

/// `Local\MewndoCore` for the real desk folder (§33.10 A3); any other folder (tests, a second Windows user's
/// session has its own Local namespace anyway) gets its own name, so cores for different folders don't collide.
#[cfg(windows)]
fn mutex_name(dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let real = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Mewndo"));
    let key = dir.to_string_lossy().to_lowercase();
    if real.is_some_and(|r| r.to_string_lossy().to_lowercase() == key) {
        return r"Local\MewndoCore".into();
    }
    let hash = Sha256::digest(key.as_bytes());
    format!(
        r"Local\MewndoCore-{:02x}{:02x}{:02x}{:02x}",
        hash[0], hash[1], hash[2], hash[3]
    )
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn already_running(dir: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::AddrInUse,
        format!(
            "another mewndo-core is already running for {}",
            crate::paths::display(dir)
        ),
    )
}

// --- the pipe -----------------------------------------------------------------------------------------------------

pub async fn serve(
    instance: Instance,
    data_dir: PathBuf,
    rules_file: Option<PathBuf>,
    computer_use: bool,
    log: Arc<Log>,
    stopped: watch::Receiver<bool>,
) -> io::Result<()> {
    let desk = Arc::new(Desk::new(&instance.dir, data_dir, rules_file, log.clone()));
    if computer_use {
        desk.agents.computer().enable();
    }
    // ponytail: 32 random bits from a ULID (rand's CSPRNG); the name only has to be unguessable before core.json
    // is written, and the pipe refuses everyone but this user anyway.
    let tag = format!("{:08x}", ulid::Ulid::new().random() as u32);
    let result = listen(&instance.dir, &tag, desk.clone(), stopped).await;
    remove_core_json(&instance.dir);
    desk.lanes.close_all();
    desk.writer.flush();
    result
}

#[cfg(unix)]
async fn listen(
    dir: &Path,
    tag: &str,
    desk: Arc<Desk>,
    mut stopped: watch::Receiver<bool>,
) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let address = dir.join(format!("core-{tag}.sock"));
    let listener = tokio::net::UnixListener::bind(&address)?;
    std::fs::set_permissions(&address, std::fs::Permissions::from_mode(0o600))?; // only this user may connect
    write_core_json(dir, &address.to_string_lossy())?;
    desk.log
        .info(&format!("desk pipe listening on {}", address.display()));
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                tokio::spawn(connection(stream, desk.clone()));
            }
            _ = stopped.wait_for(|s| *s) => break,
        }
    }
    let _ = std::fs::remove_file(&address);
    Ok(())
}

#[cfg(windows)]
async fn listen(
    dir: &Path,
    tag: &str,
    desk: Arc<Desk>,
    mut stopped: watch::Receiver<bool>,
) -> io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let address = format!(r"\\.\pipe\mewndo-core-{tag}");
    let mut sa = acl::CurrentUserOnly::new()?;
    // Safety: `sa` outlives every pipe instance created from it (it lives until this function returns).
    let create = |first: bool, sa: &mut acl::CurrentUserOnly| unsafe {
        ServerOptions::new()
            .first_pipe_instance(first) // fail rather than share a pipe someone else already made
            .create_with_security_attributes_raw(&address, sa.as_ptr())
    };
    let mut server = create(true, &mut sa)?;
    write_core_json(dir, &address)?;
    desk.log.info(&format!("desk pipe listening on {address}"));
    loop {
        tokio::select! {
            connected = server.connect() => {
                connected?;
                // The next instance exists before this one is served, so a client never finds no pipe.
                let client = std::mem::replace(&mut server, create(false, &mut sa)?);
                tokio::spawn(connection(client, desk.clone()));
            }
            _ = stopped.wait_for(|s| *s) => break,
        }
    }
    Ok(())
}

#[cfg(windows)]
mod acl {
    // A security descriptor that lets only the current user open the pipe: SDDL D:P(A;;GA;;;<user SID>)
    // (§33.10 A4). Without it, the default pipe DACL lets other local accounts read it.
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub struct CurrentUserOnly {
        sa: SECURITY_ATTRIBUTES,
        sd: PSECURITY_DESCRIPTOR,
    }

    // Safety: the descriptor is built once, never changed, and freed only in Drop.
    unsafe impl Send for CurrentUserOnly {}

    impl CurrentUserOnly {
        pub fn new() -> io::Result<CurrentUserOnly> {
            let sddl = format!("D:P(A;;GA;;;{})", current_user_sid()?);
            let wide = super::wide(&sddl);
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide.as_ptr(),
                    SDDL_REVISION_1,
                    &mut sd,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(CurrentUserOnly {
                sa: SECURITY_ATTRIBUTES {
                    nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: sd,
                    bInheritHandle: 0,
                },
                sd,
            })
        }

        pub fn as_ptr(&mut self) -> *mut core::ffi::c_void {
            &mut self.sa as *mut SECURITY_ATTRIBUTES as *mut _
        }
    }

    impl Drop for CurrentUserOnly {
        fn drop(&mut self) {
            unsafe { LocalFree(self.sd) };
        }
    }

    pub fn current_user_sid() -> io::Result<String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8)]; // u64: TOKEN_USER holds pointers
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text: *mut u16 = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
                return Err(io::Error::last_os_error());
            }
            let n = (0..).take_while(|&i| *text.add(i) != 0).count();
            let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            LocalFree(text.cast());
            Ok(sid)
        }
    }
}

// core.json is written to a temp file and renamed into place, so a reader never sees half of it.
fn write_core_json(dir: &Path, pipe: &str) -> io::Result<()> {
    let body = serde_json::json!({
        "pipe": pipe,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": VERSION,
    });
    let tmp = dir.join(format!("core.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body.to_string())?;
    std::fs::rename(&tmp, dir.join("core.json"))
}

// Only if it is still ours: a newer core may have replaced it.
fn remove_core_json(dir: &Path) {
    let path = dir.join("core.json");
    let ours = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["pid"] == std::process::id());
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

// --- one connection -----------------------------------------------------------------------------------------------

async fn read_frame<R: AsyncRead + Unpin>(
    r: &mut R,
) -> io::Result<Option<Result<Frame, proto::Error>>> {
    let mut h = [0u8; HEADER];
    match r.read_exact(&mut h).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    // A bad header means the framing is lost: the connection ends. A bad payload is answered and skipped.
    let (kind, len) =
        proto::header(&h).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let mut p = vec![0; len];
    r.read_exact(&mut p).await?;
    Ok(Some(proto::payload(kind, &p)))
}

fn reply<B: Body>(id: &str, body: &B) -> Arc<Vec<u8>> {
    Arc::new(proto::encode(&Frame::Json(Envelope::wrap(id, body))).expect("replies are small"))
}

fn error(id: &str, message: String) -> Arc<Vec<u8>> {
    reply(id, &ErrorBody { message })
}

// The answer to one request, if it has one: an app's answers and undos are acted on without a reply (the Inbox's
// own events follow), a hook's request always gets its response. A hook may wait minutes for the user, so every
// request runs on its own task and a slow one never holds up the next.
async fn respond(env: Envelope, role: Role, desk: Arc<Desk>) -> Option<Arc<Vec<u8>>> {
    if env.v != VERSION {
        return Some(error(
            &env.id,
            proto::Error::WrongVersion(env.v).to_string(),
        ));
    }
    let refuse = |why: String| Some(error(&env.id, why));
    match (env.kind.as_str(), role) {
        (Ping::TYPE, _) => Some(reply(&env.id, &Pong {})),
        (Hello::TYPE, _) => refuse("hello was already sent".into()),
        (HookRequest::TYPE, Role::Hook) => match env.open::<HookRequest>() {
            Ok(req) => Some(reply(&env.id, &desk.agents.hook(&req).await)),
            Err(e) => refuse(e.to_string()),
        },
        (InboxAnswer::TYPE, Role::App) => match env.open::<InboxAnswer>() {
            Ok(answer) => desk.agents.answer(answer).await.err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (InboxUndo::TYPE, Role::App) => match env.open::<InboxUndo>() {
            Ok(undo) => desk.agents.undo(undo).await.err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (RouteRequest::TYPE, Role::App) => match env.open::<RouteRequest>() {
            Ok(req) => Some(reply(&env.id, &desk.agents.route(&req.text))),
            Err(e) => refuse(e.to_string()),
        },
        // Guarded computer use (§36.6 U5): only a mewndo-computer proxy asks, and it always gets a verdict.
        (ComputerAction::TYPE, Role::Computer) => match env.open::<ComputerAction>() {
            Ok(action) => Some(reply(
                &env.id,
                &desk.agents.computer().decide(&action).await,
            )),
            Err(e) => refuse(e.to_string()),
        },
        (LaneOpen::TYPE, Role::App) => match env.open::<LaneOpen>() {
            Ok(open) => match desk.lanes.open(open).await {
                Ok(opened) => Some(reply(&env.id, &opened)),
                Err(e) => refuse(e),
            },
            Err(e) => refuse(e.to_string()),
        },
        (LaneReply::TYPE, Role::App) => match env.open::<LaneReply>() {
            Ok(r) => desk.lanes.reply(&r).err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (LaneBrake::TYPE, Role::App) => match env.open::<LaneBrake>() {
            Ok(b) => desk.lanes.brake(&b).err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (LaneResize::TYPE, Role::App) => match env.open::<LaneResize>() {
            Ok(r) => desk.lanes.resize(&r).err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (LaneAttach::TYPE, Role::App) => match env.open::<LaneAttach>() {
            Ok(a) => match desk.lanes.attach(&a.lane_id) {
                Ok(bytes) => Some(Arc::new(bytes)),
                Err(e) => refuse(e),
            },
            Err(e) => refuse(e.to_string()),
        },
        (LaneClose::TYPE, Role::App) => match env.open::<LaneClose>() {
            Ok(c) => desk.lanes.close(&c.lane_id).err().and_then(refuse),
            Err(e) => refuse(e.to_string()),
        },
        (other, role) => refuse(format!(
            "unknown message type {other} for a {role:?} connection"
        )),
    }
}

async fn connection<S: AsyncRead + AsyncWrite + Send + 'static>(stream: S, desk: Arc<Desk>) {
    let (mut r, mut w) = tokio::io::split(stream);
    let (out, mut outgoing) = mpsc::unbounded_channel::<Arc<Vec<u8>>>();
    let writing = tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if w.write_all(&frame).await.is_err() || w.flush().await.is_err() {
                break;
            }
        }
    });

    let hello = match tokio::time::timeout(HELLO_WAIT, read_frame(&mut r)).await {
        Ok(Ok(Some(Ok(Frame::Json(env))))) => env,
        _ => {
            desk.log
                .warn("desk pipe: a connection sent no hello; closed");
            drop(out);
            let _ = writing.await;
            return;
        }
    };
    let role = match hello.open::<Hello>() {
        Ok(h) => h.role,
        Err(e) => {
            let _ = out.send(error(
                &hello.id,
                format!("the first message must be hello: {e}"),
            ));
            drop(out);
            let _ = writing.await;
            return;
        }
    };
    let _ = out.send(reply(&hello.id, &Pong {}));
    if role == Role::App {
        for card in desk.agents.open_cards().await {
            let _ = out.send(reply(&ulid::Ulid::new().to_string(), &card));
        }
        let budget = desk.agents.budget_state();
        if budget.rules_only {
            let _ = out.send(reply(&ulid::Ulid::new().to_string(), &budget));
        }
        for lane in desk.lanes.all() {
            let _ = out.send(reply(&ulid::Ulid::new().to_string(), &lane));
        }
    }

    let events = (role == Role::App).then(|| {
        let (mut rx, out, log) = (desk.events.subscribe(), out.clone(), desk.log.clone());
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        if out.send(frame).is_err() {
                            break;
                        }
                    }
                    // ponytail: a stalled app skips what it missed; resync on reconnect if that ever matters.
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        log.warn(&format!("desk pipe: a slow app missed {n} events"))
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    });
    // Lane output, on its own channel (desk_lanes.rs). An app that falls behind loses terminal bytes, never cards;
    // its lane window can lane.attach to redraw from the replay buffer.
    let lane_output = (role == Role::App).then(|| {
        let (mut rx, out, log) = (desk.lanes.subscribe(), out.clone(), desk.log.clone());
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(frame) => {
                        if out.send(frame).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => log.warn(&format!(
                        "desk pipe: a slow app missed {n} lane frames; its lane window should re-attach"
                    )),
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    });

    loop {
        match read_frame(&mut r).await {
            Ok(Some(Ok(Frame::Json(env)))) => {
                let (out, desk) = (out.clone(), desk.clone());
                tokio::spawn(async move {
                    if let Some(frame) = respond(env, role, desk).await {
                        let _ = out.send(frame);
                    }
                });
            }
            // Keystrokes typed into a lane window. Only an app may type into a lane.
            Ok(Some(Ok(Frame::Lane { lane, data }))) => {
                let refused = if role == Role::App {
                    desk.lanes.write(&lane, &data).err()
                } else {
                    Some(format!("a {role:?} connection cannot type into a lane"))
                };
                if let Some(why) = refused
                    && out.send(error("", why)).is_err()
                {
                    break;
                }
            }
            Ok(Some(Err(e))) => {
                if out.send(error("", e.to_string())).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                desk.log
                    .warn(&format!("desk pipe: connection dropped: {e}"));
                break;
            }
        }
    }
    for task in [events, lane_output].into_iter().flatten() {
        task.abort();
    }
    drop(out);
    let _ = writing.await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::{AgentStatus, LaneClosed, LaneOpened, encode};
    use tokio::io::DuplexStream;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mewndo-desk-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn desk(name: &str) -> Arc<Desk> {
        let d = temp(name);
        Arc::new(Desk::new(
            &d,
            d.join("v0"),
            None,
            Arc::new(Log::new(&d.join("logs"))),
        ))
    }

    async fn send<B: Body>(c: &mut DuplexStream, id: &str, body: &B) {
        c.write_all(&encode(&Frame::Json(Envelope::wrap(id, body))).unwrap())
            .await
            .unwrap();
    }

    async fn recv(c: &mut DuplexStream) -> Envelope {
        match read_frame(c).await.unwrap().unwrap().unwrap() {
            Frame::Json(env) => env,
            other => panic!("not json: {other:?}"),
        }
    }

    async fn connect(desk: &Arc<Desk>, role: Role) -> DuplexStream {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        tokio::spawn(connection(server, desk.clone()));
        send(&mut client, "h", &Hello { role }).await;
        assert_eq!(recv(&mut client).await.kind, "pong");
        client
    }

    #[tokio::test]
    async fn hello_then_ping_gets_pong_with_the_same_id() {
        let d = desk("ping");
        let mut c = connect(&d, Role::Hook).await;
        send(&mut c, "42", &Ping {}).await;
        let back = recv(&mut c).await;
        assert_eq!(
            (back.v, back.id.as_str(), back.kind.as_str()),
            (2, "42", "pong")
        );
    }

    #[tokio::test]
    async fn the_first_message_must_be_hello() {
        let d = desk("nohello");
        let (mut c, server) = tokio::io::duplex(4096);
        tokio::spawn(connection(server, d));
        send(&mut c, "1", &Ping {}).await;
        let back = recv(&mut c).await;
        assert_eq!(back.kind, "error");
        assert!(back.body["message"].as_str().unwrap().contains("hello"));
        assert!(
            read_frame(&mut c).await.unwrap().is_none(),
            "then the connection closes"
        );
    }

    #[tokio::test]
    async fn unknown_types_old_versions_and_bad_json_get_errors_and_the_connection_stays_up() {
        let d = desk("errors");
        let mut c = connect(&d, Role::Hook).await;
        let unknown = Envelope {
            v: 2,
            id: "u".into(),
            kind: "launch.rockets".into(),
            body: Default::default(),
        };
        c.write_all(&encode(&Frame::Json(unknown)).unwrap())
            .await
            .unwrap();
        assert!(
            recv(&mut c).await.body["message"]
                .as_str()
                .unwrap()
                .contains("unknown message type")
        );

        let old = Envelope {
            v: 1,
            ..Envelope::wrap("o", &Ping {})
        };
        c.write_all(&encode(&Frame::Json(old)).unwrap())
            .await
            .unwrap();
        let back = recv(&mut c).await;
        assert_eq!((back.id.as_str(), back.kind.as_str()), ("o", "error"));

        c.write_all(&[0, 3, 0, 0, 0, b'{', b'{', b'{'])
            .await
            .unwrap();
        assert_eq!(recv(&mut c).await.kind, "error");

        send(&mut c, "still", &Ping {}).await;
        assert_eq!(recv(&mut c).await.id, "still");
    }

    #[tokio::test]
    async fn a_bad_header_ends_the_connection() {
        let d = desk("badheader");
        let mut c = connect(&d, Role::Hook).await;
        c.write_all(&[7, 0, 0, 0, 0]).await.unwrap();
        assert!(read_frame(&mut c).await.unwrap().is_none());
    }

    /// A desk whose lanes may start `sh` (an agent stand-in on Linux and in WSL).
    #[cfg(unix)]
    fn desk_with_sh(name: &str) -> Arc<Desk> {
        let d = temp(name);
        let mut desk = Desk::new(&d, d.join("v0"), None, Arc::new(Log::new(&d.join("logs"))));
        desk.lanes =
            DeskLanes::new(Publisher(desk.events.clone()), desk.log.clone()).allowing(&["sh"]);
        Arc::new(desk)
    }

    /// Reads frames until `done` says so, keeping every lane byte seen on the way. Fails after 10 s.
    async fn until(
        c: &mut DuplexStream,
        mut done: impl FnMut(&Frame, &[u8]) -> bool,
    ) -> (Frame, Vec<u8>) {
        let mut seen = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let frame = read_frame(c).await.unwrap().unwrap().unwrap();
                if let Frame::Lane { data, .. } = &frame {
                    seen.extend_from_slice(data);
                }
                if done(&frame, &seen) {
                    return (frame, seen.clone());
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "timed out; lane output so far: {}",
                String::from_utf8_lossy(&seen)
            )
        })
    }

    fn json(frame: &Frame, kind: &str) -> bool {
        matches!(frame, Frame::Json(env) if env.kind == kind)
    }

    fn has(seen: &[u8], text: &str) -> bool {
        String::from_utf8_lossy(seen).contains(text)
    }

    /// The same path on every platform, so Windows CI runs it through ConPTY and `cmd`.
    #[tokio::test]
    async fn a_lane_over_the_pipe_on_every_platform() {
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        let d = temp("lanes-any");
        let mut desk = Desk::new(&d, d.join("v0"), None, Arc::new(Log::new(&d.join("logs"))));
        desk.lanes =
            DeskLanes::new(Publisher(desk.events.clone()), desk.log.clone()).allowing(&[shell]);
        let desk = Arc::new(desk);
        let mut c = connect(&desk, Role::App).await;
        let open = LaneOpen {
            program: shell.into(),
            args: vec![],
            cwd: d.to_string_lossy().into(),
            env: vec![],
        };
        send(&mut c, "o", &open).await;
        let (opened, _) = until(&mut c, |f, _| json(f, "lane.opened")).await;
        let Frame::Json(opened) = opened else {
            unreachable!()
        };
        let id = opened.open::<LaneOpened>().unwrap().lane_id;
        // The typed line holds "6*7000+1"; only the shell's answer holds 42001.
        let sum = if cfg!(windows) {
            "set /a 6*7000+1"
        } else {
            "echo $((6*7000+1))"
        };
        send(
            &mut c,
            "r",
            &LaneReply {
                lane_id: id.clone(),
                text: sum.into(),
            },
        )
        .await;
        until(&mut c, |_, seen| has(seen, "42001")).await;
        send(
            &mut c,
            "x",
            &LaneReply {
                lane_id: id.clone(),
                text: "exit 7".into(),
            },
        )
        .await;
        let (ended, _) = until(&mut c, |f, _| json(f, "lane.closed")).await;
        let Frame::Json(ended) = ended else {
            unreachable!()
        };
        assert_eq!(ended.open::<LaneClosed>().unwrap().exit_code, Some(7));
        send(&mut c, "c", &LaneClose { lane_id: id }).await;
        let (gone, _) = until(&mut c, |f, _| json(f, "lane.closed")).await;
        let Frame::Json(gone) = gone else {
            unreachable!()
        };
        assert!(gone.open::<LaneClosed>().unwrap().removed);
    }

    // sh, stty and SIGINT: Unix only, like mewndo-pty's own resize and brake tests.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lane_takes_replies_keys_resizes_and_the_brake_and_replays_to_a_new_window() {
        let d = desk_with_sh("lanes");
        let folder = temp("lanes-cwd");
        let mut c = connect(&d, Role::App).await;

        // Only the agents of §33.7 (here: sh) can be started, and only in a real folder.
        let open = |program: &str, cwd: &std::path::Path| LaneOpen {
            program: program.into(),
            args: vec![],
            cwd: cwd.to_string_lossy().into(),
            env: vec![],
        };
        send(&mut c, "bad", &open("rm", &folder)).await;
        let (refused, _) = until(&mut c, |f, _| json(f, "error")).await;
        let Frame::Json(refused) = refused else {
            unreachable!()
        };
        assert!(
            refused.body["message"]
                .as_str()
                .unwrap()
                .contains("can only start sh")
        );
        send(&mut c, "nofolder", &open("sh", &folder.join("missing"))).await;
        let (refused, _) = until(&mut c, |f, _| json(f, "error")).await;
        let Frame::Json(refused) = refused else {
            unreachable!()
        };
        assert!(
            refused.body["message"]
                .as_str()
                .unwrap()
                .contains("is not a folder")
        );

        send(&mut c, "o", &open("sh", &folder)).await;
        let (opened, _) = until(&mut c, |f, _| json(f, "lane.opened")).await;
        let Frame::Json(opened) = opened else {
            unreachable!()
        };
        let opened: LaneOpened = opened.open().unwrap();
        assert_eq!((opened.program.as_str(), opened.running), ("sh", true));
        let id = opened.lane_id.clone();

        // A reply is typed in with Enter; the output comes back as lane frames.
        send(
            &mut c,
            "r",
            &LaneReply {
                lane_id: id.clone(),
                text: "echo lane-$((40+2))".into(),
            },
        )
        .await;
        until(&mut c, |_, seen| has(seen, "lane-42")).await;

        // Keystrokes from the lane window's terminal go in as they are.
        c.write_all(
            &encode(&Frame::Lane {
                lane: id.clone(),
                data: b"echo typed-$((1+1))\r".to_vec(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        until(&mut c, |_, seen| has(seen, "typed-2")).await;

        send(
            &mut c,
            "s",
            &LaneResize {
                lane_id: id.clone(),
                rows: 40,
                cols: 100,
            },
        )
        .await;
        send(
            &mut c,
            "r2",
            &LaneReply {
                lane_id: id.clone(),
                text: "stty size".into(),
            },
        )
        .await;
        until(&mut c, |_, seen| has(seen, "40 100")).await;

        // The brake interrupts what is running and the lane carries on.
        send(
            &mut c,
            "r3",
            &LaneReply {
                lane_id: id.clone(),
                text: "sleep 30; echo not-braked".into(),
            },
        )
        .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        send(
            &mut c,
            "b",
            &LaneBrake {
                lane_id: id.clone(),
            },
        )
        .await;
        send(
            &mut c,
            "r4",
            &LaneReply {
                lane_id: id.clone(),
                text: "echo after-$((2*3))".into(),
            },
        )
        .await;
        let (_, seen) = until(&mut c, |_, seen| has(seen, "after-6")).await;
        // The terminal echoes the typed line, so "not-braked" appears once; a second time would be the echo's output.
        assert_eq!(
            String::from_utf8_lossy(&seen).matches("not-braked").count(),
            1,
            "{}",
            String::from_utf8_lossy(&seen)
        );

        // A window that opens now gets the replay buffer, then lane.opened, and a newly connected app is told
        // the lane exists.
        let mut late = connect(&d, Role::App).await;
        let (_, _) = until(&mut late, |f, _| json(f, "lane.opened")).await;
        send(
            &mut late,
            "a",
            &LaneAttach {
                lane_id: id.clone(),
            },
        )
        .await;
        let (_, replay) = until(&mut late, |f, _| json(f, "lane.opened")).await;
        assert!(has(&replay, "lane-42") && has(&replay, "after-6"));

        // A hook connection cannot type into a lane.
        let mut hook = connect(&d, Role::Hook).await;
        hook.write_all(
            &encode(&Frame::Lane {
                lane: id.clone(),
                data: b"echo no\r".to_vec(),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(recv(&mut hook).await.kind, "error");

        // The agent ending is lane.closed with its exit code; closing the lane removes it.
        send(
            &mut c,
            "x",
            &LaneReply {
                lane_id: id.clone(),
                text: "exit 7".into(),
            },
        )
        .await;
        let (ended, _) = until(&mut c, |f, _| json(f, "lane.closed")).await;
        let Frame::Json(ended) = ended else {
            unreachable!()
        };
        let ended: LaneClosed = ended.open().unwrap();
        assert_eq!((ended.exit_code, ended.removed), (Some(7), false));
        send(
            &mut c,
            "c",
            &LaneClose {
                lane_id: id.clone(),
            },
        )
        .await;
        let (gone, _) = until(&mut c, |f, _| json(f, "lane.closed")).await;
        let Frame::Json(gone) = gone else {
            unreachable!()
        };
        assert!(gone.open::<LaneClosed>().unwrap().removed);
        assert!(d.lanes.all().is_empty());
        send(&mut c, "c2", &LaneClose { lane_id: id }).await;
        let (_, _) = until(&mut c, |f, _| json(f, "error")).await;
    }

    #[tokio::test]
    async fn a_computer_proxy_gets_a_verdict_and_computer_use_is_off_by_default() {
        let d = desk("computer");
        let action = mewndo_proto::ComputerAction {
            session: "mewndo-claude-1".into(),
            tool: "get_desktop_state".into(),
            args_redacted: serde_json::json!({}),
            point: None,
            agent: "claude".into(),
        };
        let mut c = connect(&d, Role::Computer).await;
        send(&mut c, "a", &action).await;
        let back = recv(&mut c).await;
        assert_eq!(
            (back.id.as_str(), back.kind.as_str()),
            ("a", "computer.verdict")
        );
        let verdict: mewndo_proto::ComputerVerdict = back.open().unwrap();
        assert_eq!(verdict.verdict, mewndo_proto::Verdict::Deny);
        assert_eq!(verdict.reason.as_deref(), Some(crate::computer::OFF));

        d.agents.computer().enable();
        send(&mut c, "b", &action).await;
        let verdict: mewndo_proto::ComputerVerdict = recv(&mut c).await.open().unwrap();
        assert_eq!(
            verdict.verdict,
            mewndo_proto::Verdict::Allow,
            "a read, with computer use on"
        );

        // Only a computer connection may ask.
        let mut app = connect(&d, Role::App).await;
        send(&mut app, "x", &action).await;
        assert_eq!(recv(&mut app).await.kind, "error");
    }

    #[tokio::test]
    async fn only_apps_receive_what_the_desk_publishes() {
        let d = desk("publish");
        let mut app = connect(&d, Role::App).await;
        let mut hook = connect(&d, Role::Hook).await;
        let status = AgentStatus {
            agent_id: "a1".into(),
            kind: "claude-code".into(),
            name: "Claude".into(),
            connection: "hooked".into(),
            status: "working".into(),
            last_line: None,
        };
        Publisher(d.events.clone()).send(&status);
        assert_eq!(recv(&mut app).await.open::<AgentStatus>().unwrap(), status);

        send(&mut hook, "p", &Ping {}).await;
        assert_eq!(
            recv(&mut hook).await.kind,
            "pong",
            "the hook's next frame is its own reply, not the event"
        );
    }

    #[tokio::test]
    async fn an_app_that_connects_after_a_card_was_made_still_gets_it() {
        let d = desk("late-app");
        let mut hook = connect(&d, Role::Hook).await;
        let req = HookRequest {
            agent: "claude".into(),
            event: "permission".into(),
            session_id: None,
            pid: None,
            cwd: Some("/work/shop".into()),
            lane_id: None,
            payload: serde_json::json!({
                "session_id": "s1", "cwd": "/work/shop", "hook_event_name": "PermissionRequest",
                "tool_name": "Bash", "tool_input": {"command": "git push --force"}
            }),
        };
        send(&mut hook, "r1", &req).await;
        // The card exists before the app is there to hear it.
        for _ in 0..200 {
            if !d.agents.open_cards().await.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let mut app = connect(&d, Role::App).await;
        let card = recv(&mut app).await;
        assert_eq!(card.kind, "inbox.card");
        assert_eq!(card.body["grace_ms"], 2000);
    }

    #[test]
    fn core_json_is_written_whole_and_removed_only_by_its_owner() {
        let d = temp("corejson");
        write_core_json(&d, "pipe-name").unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(d.join("core.json")).unwrap()).unwrap();
        assert_eq!(
            (v["pipe"].as_str(), v["protocol"].as_u64()),
            (Some("pipe-name"), Some(2))
        );
        assert_eq!(v["pid"], std::process::id());
        assert_eq!(
            std::fs::read_dir(&d).unwrap().count(),
            1,
            "no temp file left behind"
        );

        std::fs::write(d.join("core.json"), r#"{"pipe":"x","pid":1}"#).unwrap();
        remove_core_json(&d);
        assert!(
            d.join("core.json").exists(),
            "another core's file is left alone"
        );
        write_core_json(&d, "pipe-name").unwrap();
        remove_core_json(&d);
        assert!(!d.join("core.json").exists());
    }

    #[test]
    fn a_second_core_for_the_same_folder_is_refused() {
        let d = temp("instance");
        let first = claim(&d).unwrap();
        assert_eq!(
            claim(&d).err().map(|e| e.kind()),
            Some(io::ErrorKind::AddrInUse)
        );
        let other = temp("instance-other");
        let _second = claim(&other).expect("another folder is another desk");
        drop(first);
        #[cfg(unix)] // on Windows the mutex lives until the process ends
        claim(&d).expect("free again once the first core is gone");
    }
}
