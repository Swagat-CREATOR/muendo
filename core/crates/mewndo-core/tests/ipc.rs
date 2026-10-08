// The real mewndo-core binary, over a real socket: the protocol as the app sees it.
#![cfg(unix)]
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

struct Core {
    child: Child,
    dir: PathBuf,
    socket: PathBuf,
}

impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn start(name: &str) -> Core {
    let dir = std::env::temp_dir().join(format!("mewndo-core-ipc-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("core.sock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mewndo-core"))
        .args([
            "--socket",
            socket.to_str().unwrap(),
            "--log-dir",
            dir.join("logs").to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    assert_eq!(first, "ready\n");
    Core { child, dir, socket }
}

fn ask(stream: &mut UnixStream, line: &str) -> Value {
    stream.write_all(format!("{line}\n").as_bytes()).unwrap();
    let mut reply = String::new();
    BufReader::new(stream.try_clone().unwrap())
        .read_line(&mut reply)
        .unwrap();
    serde_json::from_str(&reply).unwrap()
}

#[test]
fn answers_status_refuses_bad_requests_and_shuts_down() {
    let mut core = start("talk");
    let mut s = UnixStream::connect(&core.socket).unwrap();

    let status = ask(&mut s, r#"{"v":1,"id":1,"type":"status"}"#);
    assert_eq!(
        (
            status["v"].clone(),
            status["id"].clone(),
            status["type"].clone()
        ),
        (json!(1), json!(1), json!("status"))
    );
    assert_eq!(status["pid"], core.child.id());

    assert_eq!(
        ask(&mut s, r#"{"v":99,"id":2,"type":"shutdown"}"#)["code"],
        "unsupported_version"
    );
    assert_eq!(ask(&mut s, "garbage")["code"], "bad_request");
    assert_eq!(
        ask(&mut s, r#"{"v":1,"id":3,"type":"nope"}"#)["code"],
        "unknown_type"
    );
    // Still alive after all of that, and a second connection works too.
    let mut s2 = UnixStream::connect(&core.socket).unwrap();
    assert_eq!(
        ask(&mut s2, r#"{"v":1,"id":4,"type":"status"}"#)["type"],
        "status"
    );

    assert_eq!(
        ask(&mut s, r#"{"v":1,"id":5,"type":"shutdown"}"#),
        json!({"v":1,"id":5,"type":"ok"})
    );
    assert!(core.child.wait().unwrap().success());
    assert!(
        !core.socket.exists(),
        "the socket is removed on a clean stop"
    );

    let log = std::fs::read_to_string(core.dir.join("logs/mewndo-core.log")).unwrap();
    for expected in [
        "INFO  mewndo-core 0.1.0 starting (protocol 1",
        "INFO  listening on",
        "WARN  refused a request",
        "INFO  mewndo-core stopped",
    ] {
        assert!(
            log.contains(expected),
            "log is missing {expected:?}:\n{log}"
        );
    }
}

#[test]
fn stops_when_the_app_goes_away() {
    let mut core = start("orphan");
    drop(core.child.stdin.take()); // what happens when the app exits or crashes
    assert!(core.child.wait().unwrap().success());
}

#[test]
fn replaces_a_socket_left_by_a_crash_but_never_a_file() {
    let mut crashed = start("stale");
    crashed.child.kill().unwrap();
    crashed.child.wait().unwrap();
    assert!(crashed.socket.exists());
    let mut again = Command::new(env!("CARGO_BIN_EXE_mewndo-core"))
        .args([
            "--socket",
            crashed.socket.to_str().unwrap(),
            "--log-dir",
            crashed.dir.join("logs").to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut first = String::new();
    BufReader::new(again.stdout.take().unwrap())
        .read_line(&mut first)
        .unwrap();
    assert_eq!(first, "ready\n");
    again.kill().unwrap();
    again.wait().unwrap();

    let file = crashed.dir.join("not-a-socket");
    std::fs::write(&file, "user data").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_mewndo-core"))
        .args([
            "--socket",
            file.to_str().unwrap(),
            "--log-dir",
            crashed.dir.join("logs").to_str().unwrap(),
        ])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "user data");
}
