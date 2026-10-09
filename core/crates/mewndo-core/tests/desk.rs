// The real mewndo-core binary with --desk, over the real pipe (Windows) or socket: what the hook forwarder and the
// app will see (spec §33.10 Part A).
use mewndo_proto::{Envelope, Frame, HEADER, Hello, Ping, Role, encode, header, payload};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Core {
    child: Child,
    dir: PathBuf,
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn spawn(dir: &std::path::Path, socket: &str) -> Child {
    Command::new(env!("CARGO_BIN_EXE_mewndo-core"))
        .args(["--socket", socket, "--log-dir"])
        .arg(dir.join("logs"))
        .arg("--desk")
        .arg(dir.join("desk"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn v1_socket(dir: &std::path::Path, n: u32) -> String {
    if cfg!(windows) {
        // The folder name is unique per test, and tests run in parallel.
        let test = dir.file_name().unwrap().to_string_lossy();
        format!(r"\\.\pipe\{test}-{n}")
    } else {
        dir.join(format!("v1-{n}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

fn start(name: &str) -> Core {
    let dir = std::env::temp_dir().join(format!("mewndo-desk-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut child = spawn(&dir, &v1_socket(&dir, 1));
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    assert_eq!(first.trim(), "ready");
    Core { child, dir }
}

fn core_json(core: &Core) -> serde_json::Value {
    let path = core.dir.join("desk").join("core.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(bytes) = std::fs::read(&path) {
            return serde_json::from_slice(&bytes).expect("core.json is never half-written");
        }
        assert!(Instant::now() < deadline, "no core.json");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

fn connect(pipe: &str) -> Pipe {
    #[cfg(windows)]
    return std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe)
        .unwrap();
    #[cfg(unix)]
    return std::os::unix::net::UnixStream::connect(pipe).unwrap();
}

fn send(p: &mut Pipe, env: Envelope) {
    p.write_all(&encode(&Frame::Json(env)).unwrap()).unwrap();
}

fn recv(p: &mut Pipe) -> Envelope {
    let mut h = [0u8; HEADER];
    p.read_exact(&mut h).unwrap();
    let (kind, len) = header(&h).unwrap();
    let mut body = vec![0; len];
    p.read_exact(&mut body).unwrap();
    match payload(kind, &body).unwrap() {
        Frame::Json(env) => env,
        other => panic!("not json: {other:?}"),
    }
}

#[test]
fn hello_and_ping_over_the_real_pipe() {
    let core = start("ping");
    let info = core_json(&core);
    assert_eq!(info["protocol"], 2);
    assert_eq!(info["pid"], core.child.id());
    let pipe = info["pipe"].as_str().unwrap();
    if cfg!(windows) {
        assert!(pipe.starts_with(r"\\.\pipe\mewndo-core-"), "{pipe}");
    }

    let mut p = connect(pipe);
    send(&mut p, Envelope::wrap("h", &Hello { role: Role::Hook }));
    assert_eq!(recv(&mut p).kind, "pong");

    let mut times = Vec::new();
    for i in 0..500 {
        let id = i.to_string();
        let t = Instant::now();
        send(&mut p, Envelope::wrap(id.clone(), &Ping {}));
        let back = recv(&mut p);
        times.push(t.elapsed());
        assert_eq!((back.kind.as_str(), back.id), ("pong", id));
    }
    times.sort();
    let (median, p95) = (times[times.len() / 2], times[times.len() * 95 / 100]);
    eprintln!("desk pipe ping -> pong over 500 round trips: median {median:?}, p95 {p95:?}");
    // The spec's target is under 1 ms (§33.10 Part A), measured and reported; this only catches a gross regression
    // on a busy CI runner.
    assert!(median < Duration::from_millis(5), "median {median:?}");
}

#[test]
fn a_second_core_for_the_same_desk_refuses_to_start() {
    let core = start("second");
    let _ = core_json(&core);
    let out = spawn(&core.dir, &v1_socket(&core.dir, 2))
        .wait_with_output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert!(String::from_utf8_lossy(&out.stderr).contains("already running"));
    assert!(
        core.dir.join("desk").join("core.json").exists(),
        "the first core's file is untouched"
    );
}

#[test]
fn closing_stdin_stops_the_core_and_removes_core_json() {
    let mut core = start("stop");
    let _ = core_json(&core);
    drop(core.child.stdin.take()); // the app went away
    let deadline = Instant::now() + Duration::from_secs(10);
    while core.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "the core kept running");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!core.dir.join("desk").join("core.json").exists());
}

#[test]
fn frames_can_arrive_in_pieces() {
    let core = start("pieces");
    let pipe = core_json(&core)["pipe"].as_str().unwrap().to_string();
    let mut p = connect(&pipe);
    let mut bytes = encode(&Frame::Json(Envelope::wrap(
        "h",
        &Hello { role: Role::App },
    )))
    .unwrap();
    bytes.extend(encode(&Frame::Json(Envelope::wrap("p", &Ping {}))).unwrap());
    for b in bytes {
        p.write_all(&[b]).unwrap();
    }
    assert_eq!(recv(&mut p).id, "h");
    assert_eq!(recv(&mut p).id, "p");
}
