// mewndo-core: Mewndo's background service for version 1. The desktop app starts it, talks to it over a Windows
// named pipe (a Unix socket elsewhere) using the protocol in protocol.rs, checks it is alive and restarts it if it
// stops. Protection still runs in the Node engine; the core does the file work the engine hands it.
//
//   mewndo-core --socket <pipe name or socket path> --log-dir <the app's log folder> [--desk <folder>]
//
// With --desk it also serves the Agent Desk pipe, protocol v2 (desk.rs), from that folder; --data is v0's data
// folder, whose hook server makes the desk's save points (default: the same folder the hook scripts find).
//
// It prints "ready" once it is listening, and stops when asked to, or when its stdin closes (the app is gone),
// so it never outlives the app.
mod agents;
mod cloud_link;
mod decide;
mod desk;
mod desk_agents;
mod engine_client;
mod feed;
mod ledger;
mod log;
mod mcp;
mod paths;
mod policy;
mod process;
mod protocol;
mod restore;
mod scanner;
mod screen;
mod store;
mod writer;

use log::Log;
use protocol::{Info, Session};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::watch;

struct Args {
    socket: String,
    log_dir: PathBuf,
    desk: Option<PathBuf>,
    data: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let (mut socket, mut log_dir, mut desk, mut data) = (None, None, None, None);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => socket = args.next(),
            "--log-dir" => log_dir = args.next().map(PathBuf::from),
            "--desk" => desk = args.next().map(PathBuf::from),
            "--data" => data = args.next().map(PathBuf::from),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    match (socket, log_dir) {
        (Some(socket), Some(log_dir)) => Ok(Args {
            socket,
            log_dir,
            desk,
            data,
        }),
        _ => Err(
            "usage: mewndo-core --socket <pipe name or socket path> --log-dir <folder> [--desk <folder>] [--data <v0 data folder>]"
                .into(),
        ),
    }
}

// Mewndo's data folder, as the hook script finds it: MEWNDO_DATA_DIR, MEWNDO_USER_DATA/data, or the app's own.
fn default_data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("MEWNDO_DATA_DIR") {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::var_os("MEWNDO_USER_DATA") {
        return PathBuf::from(d).join("data");
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default();
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
    };
    base.join("mewndo").join("data")
}

// `mewndo-core mcp [--agent claude|codex|cursor] [--data <folder>]`: the local MCP server on stdio (mcp.rs).
fn run_mcp() -> ExitCode {
    let (mut agent, mut data) = ("claude".to_string(), default_data_dir());
    let mut args = std::env::args().skip(2);
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next()) {
            ("--agent", Some(a)) => agent = a,
            ("--data", Some(d)) => data = PathBuf::from(d),
            _ => {
                eprintln!("usage: mewndo-core mcp [--agent claude|codex|cursor] [--data <folder>]");
                return ExitCode::from(2);
            }
        }
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    match runtime.block_on(mcp::serve(data, agent)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("mewndo-core mcp: {e}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        return run_mcp();
    }
    let args = match parse_args() {
        Ok(args) => args,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    let log = Arc::new(Log::new(&args.log_dir));
    let panic_log = log.clone();
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        panic_log.error(&format!("mewndo-core crashed: {info}"));
        default_hook(info);
    }));
    log.info(&format!(
        "mewndo-core {} starting (protocol {}, pid {})",
        env!("CARGO_PKG_VERSION"),
        protocol::PROTOCOL_VERSION,
        std::process::id()
    ));

    // Before "ready": a second core for the same desk must fail at start, not after the app thinks it's up.
    let desk = match args.desk.as_deref().map(desk::claim).transpose() {
        Ok(desk) => desk,
        Err(e) => {
            log.error(&format!("mewndo-core can't start: {e}"));
            eprintln!("{e}");
            return ExitCode::from(3);
        }
    };

    // More than one thread: a slow stretch of v1 work (the engine's start-up sync) must not hold up the desk pipe,
    // where an agent is waiting on every hook.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let data = args.data.unwrap_or_else(default_data_dir);
    match runtime.block_on(serve(&args.socket, desk, data, log.clone())) {
        Ok(()) => {
            log.info("mewndo-core stopped");
            ExitCode::SUCCESS
        }
        Err(e) => {
            log.error(&format!("mewndo-core stopped: {e}"));
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(
    address: &str,
    desk: Option<desk::Instance>,
    data: PathBuf,
    log: Arc<Log>,
) -> std::io::Result<()> {
    let info = Arc::new(Info::new());
    let (stop, stopped) = watch::channel(false);

    // stdin closes when the app exits or crashes. A plain thread: a blocking read in tokio would hold up shutdown.
    let parent_gone = stop.clone();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        let _ = parent_gone.send(true);
    });

    let desk = desk.map(|d| tokio::spawn(desk::serve(d, data, log.clone(), stopped.clone())));
    let result = listen(address, &log, info, stop.clone(), stopped).await;
    let _ = stop.send(true);
    if let Some(desk) = desk {
        match desk.await {
            Ok(Err(e)) => log.error(&format!("desk pipe stopped: {e}")),
            Err(e) => log.error(&format!("desk pipe crashed: {e}")),
            Ok(Ok(())) => {}
        }
    }
    result
}

#[cfg(unix)]
async fn listen(
    address: &str,
    log: &Arc<Log>,
    info: Arc<Info>,
    stop: watch::Sender<bool>,
    mut stopped: watch::Receiver<bool>,
) -> std::io::Result<()> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    // A socket left behind by a crash. Only ever a socket: anything else at that path is not ours to remove.
    if std::fs::symlink_metadata(address).is_ok_and(|m| m.file_type().is_socket()) {
        std::fs::remove_file(address)?;
    }
    let listener = tokio::net::UnixListener::bind(address)?;
    std::fs::set_permissions(address, std::fs::Permissions::from_mode(0o600))?; // only this user may connect
    ready(log, address);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                tokio::spawn(connection(stream, log.clone(), info.clone(), stop.clone()));
            }
            _ = stopped.wait_for(|s| *s) => break,
        }
    }
    let _ = std::fs::remove_file(address);
    Ok(())
}

#[cfg(windows)]
async fn listen(
    address: &str,
    log: &Arc<Log>,
    info: Arc<Info>,
    stop: watch::Sender<bool>,
    mut stopped: watch::Receiver<bool>,
) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    // first_pipe_instance: fail if another process already made this pipe, rather than share it.
    // Remote clients are rejected by default.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(address)?;
    ready(log, address);
    loop {
        tokio::select! {
            connected = server.connect() => {
                connected?;
                let client = std::mem::replace(&mut server, ServerOptions::new().create(address)?);
                tokio::spawn(connection(client, log.clone(), info.clone(), stop.clone()));
            }
            _ = stopped.wait_for(|s| *s) => break,
        }
    }
    Ok(())
}

fn ready(log: &Log, address: &str) {
    use std::io::Write;
    log.info(&format!("listening on {address}"));
    let mut out = std::io::stdout();
    let _ = writeln!(out, "ready").and_then(|_| out.flush());
}

// One app connection: a request per line, a reply per line, in order. Change feed events for the folders this
// connection watches go out on it too, between replies (see protocol.rs).
async fn connection<S: AsyncRead + AsyncWrite + Send + 'static>(
    stream: S,
    log: Arc<Log>,
    info: Arc<Info>,
    stop: watch::Sender<bool>,
) {
    let (reader, mut writer) = tokio::io::split(stream);
    let (out, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writing = tokio::spawn(async move {
        while let Some(line) = outgoing.recv().await {
            if writer
                .write_all(format!("{line}\n").as_bytes())
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = writer.flush().await;
    });
    let session = Arc::new(Session::new(out.clone()));
    let mut lines = BufReader::new(reader).lines(); // ponytail: no line length cap; the socket is this user's only
    let mut shutdown = false;
    while let Ok(Some(line)) = lines.next_line().await {
        let (info, session) = (info.clone(), session.clone());
        // Slow work (storing, scanning, process control) runs alongside, so a 50,000-file scan never holds up the
        // app's "are you alive" check or a quick request: their replies can come first. Quick ones run in order.
        if protocol::is_slow(&line) {
            let (out, log) = (out.clone(), log.clone());
            tokio::spawn(async move {
                match tokio::task::spawn_blocking(move || protocol::respond(&line, &info, &session))
                    .await
                {
                    Ok((Some(reply), _)) => {
                        if reply.contains(r#""type":"error""#) {
                            log.warn(&format!("refused a request: {reply}"));
                        }
                        let _ = out.send(reply);
                    }
                    Ok((None, _)) => {}
                    Err(_) => log.error("a request handler crashed"),
                }
            });
            continue;
        }
        let Ok((reply, stop_now)) =
            tokio::task::spawn_blocking(move || protocol::respond(&line, &info, &session)).await
        else {
            log.error("a request handler crashed");
            break;
        };
        if let Some(reply) = reply {
            if reply.contains(r#""type":"error""#) {
                log.warn(&format!("refused a request: {reply}"));
            }
            if out.send(reply).is_err() {
                break;
            }
        }
        if stop_now {
            log.info("shutdown requested by the app");
            shutdown = true;
            break;
        }
    }
    drop(session); // stops this connection's watches
    drop(out);
    let _ = writing.await; // every reply, including shutdown's "ok", is written first
    if shutdown {
        let _ = stop.send(true);
    }
}
