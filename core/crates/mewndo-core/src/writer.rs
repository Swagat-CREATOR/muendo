// desk.db (spec §38.6): the Agent Desk's own database: agents, traces, spans, cards, decisions, habits, skills.
// One writer thread owns every write. Callers queue statements without waiting; the thread commits whatever
// arrived in each 10 ms window as one transaction (§33.10 Part A step 7), so the hook path never waits on disk.
//
// Real SQLite is a C build, so it needs a C compiler: Linux and Windows-MSVC (CI) have one, the windows-gnu dev
// box hasn't. There the writer is a sink that keeps nothing, so everything else still builds and runs
// (docs/decisions.md, "desk.db").
use crate::log::Log;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};

#[cfg_attr(
    all(windows, not(target_env = "msvc")),
    allow(dead_code, reason = "the windows-gnu sink keeps nothing")
)]
enum Command {
    Exec(&'static str, Vec<Value>),
    Flush(Sender<()>),
}

pub struct Writer {
    tx: Sender<Command>,
}

impl Writer {
    /// Queue one statement. It is committed with the rest of its 10 ms batch; a statement that fails is logged
    /// and the rest of the batch still commits.
    #[cfg_attr(
        any(not(test), all(windows, not(target_env = "msvc"))),
        expect(
            dead_code,
            reason = "first writers: hooks (Part C) and the Inbox (Part D)"
        )
    )]
    pub fn write(&self, sql: &'static str, params: Vec<Value>) {
        let _ = self.tx.send(Command::Exec(sql, params));
    }

    /// Wait until everything queued before this call is committed.
    pub fn flush(&self) {
        let (done, wait) = channel();
        if self.tx.send(Command::Flush(done)).is_ok() {
            let _ = wait.recv();
        }
    }
}

#[cfg(any(unix, all(windows, target_env = "msvc")))]
const BATCH: std::time::Duration = std::time::Duration::from_millis(10);

#[cfg(any(unix, all(windows, target_env = "msvc")))]
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agents    (id TEXT PRIMARY KEY, kind TEXT, name TEXT, connection TEXT, mode TEXT DEFAULT 'shadow',
                                      pid INTEGER, cwd TEXT, status TEXT, last_event_at INTEGER);
CREATE TABLE IF NOT EXISTS traces    (id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT, prompt TEXT, brief TEXT,
                                      savepoint_id TEXT, started_at INTEGER, ended_at INTEGER, final_message TEXT,
                                      receipt_json TEXT);
CREATE TABLE IF NOT EXISTS spans     (id TEXT PRIMARY KEY, trace_id TEXT, parent_id TEXT, kind TEXT, name TEXT,
                                      input_digest TEXT, output_tail TEXT, exit_code INTEGER, files_json TEXT,
                                      savepoint_id TEXT, started_at INTEGER, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS cards     (id TEXT PRIMARY KEY, agent_id TEXT, trace_id TEXT, kind TEXT, title TEXT, body TEXT,
                                      options_json TEXT, risk INTEGER, state TEXT, answer_json TEXT, via TEXT,
                                      created_at INTEGER, answered_at INTEGER, released_at INTEGER, savepoint_id TEXT);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, span_id TEXT, rules_verdict TEXT, model_verdict TEXT,
                                      final_verdict TEXT, answers_json TEXT, backend TEXT, latency_ms INTEGER,
                                      deadline_met INTEGER, fallback_used INTEGER, shadow INTEGER, user_answer TEXT,
                                      created_at INTEGER);
CREATE TABLE IF NOT EXISTS habits    (id TEXT PRIMARY KEY, agent_kind TEXT, project TEXT, action_sig TEXT, rule TEXT,
                                      count INTEGER, created_at INTEGER);
CREATE TABLE IF NOT EXISTS skills    (id TEXT PRIMARY KEY, name TEXT, app TEXT, path TEXT, steps INTEGER, created_at INTEGER);
";

#[cfg(any(unix, all(windows, target_env = "msvc")))]
pub fn start(path: &Path, log: Arc<Log>) -> Writer {
    let (tx, rx) = channel::<Command>();
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        let db = match open(&path) {
            Ok(db) => Some(db),
            Err(e) => {
                // Fail open (§32.5 rule 7): the desk still runs, it just remembers nothing.
                log.error(&format!(
                    "desk.db can't be opened ({e}); nothing will be stored"
                ));
                None
            }
        };
        let mut db = db;
        while let Ok(first) = rx.recv() {
            let deadline = std::time::Instant::now() + BATCH;
            let mut batch = vec![first];
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(c) => batch.push(c),
                    Err(_) => break,
                }
            }
            if let Some(db) = db.as_mut()
                && let Err(e) = commit(db, &batch, &log)
            {
                log.error(&format!("desk.db: a batch of {} failed: {e}", batch.len()));
            }
            for c in batch {
                if let Command::Flush(done) = c {
                    let _ = done.send(());
                }
            }
        }
    });
    Writer { tx }
}

#[cfg(any(unix, all(windows, target_env = "msvc")))]
fn open(path: &Path) -> rusqlite::Result<rusqlite::Connection> {
    let db = rusqlite::Connection::open(path)?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.pragma_update(None, "synchronous", "NORMAL")?; // WAL + NORMAL: a crash loses at most the last batch
    db.execute_batch(SCHEMA)?;
    Ok(db)
}

#[cfg(any(unix, all(windows, target_env = "msvc")))]
fn commit(db: &mut rusqlite::Connection, batch: &[Command], log: &Log) -> rusqlite::Result<()> {
    use rusqlite::types::Value as Sql;
    let tx = db.transaction()?;
    for c in batch {
        let Command::Exec(sql, params) = c else {
            continue;
        };
        let params = params.iter().map(|v| match v {
            Value::Null => Sql::Null,
            Value::Bool(b) => Sql::Integer(*b as i64),
            Value::Number(n) => n
                .as_i64()
                .map(Sql::Integer)
                .unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(0.0))),
            Value::String(s) => Sql::Text(s.clone()),
            other => Sql::Text(other.to_string()), // arrays and objects are stored as JSON text (*_json columns)
        });
        let done = tx
            .prepare_cached(sql)
            .and_then(|mut s| s.execute(rusqlite::params_from_iter(params)));
        if let Err(e) = done {
            log.warn(&format!("desk.db: a write was dropped: {e}"));
        }
    }
    tx.commit()
}

#[cfg(all(windows, not(target_env = "msvc")))]
pub fn start(_path: &Path, log: Arc<Log>) -> Writer {
    log.warn("desk.db: this build has no SQLite (windows-gnu); the desk stores nothing");
    let (tx, rx) = channel::<Command>();
    std::thread::spawn(move || {
        while let Ok(c) = rx.recv() {
            if let Command::Flush(done) = c {
                let _ = done.send(());
            }
        }
    });
    Writer { tx }
}

#[cfg(all(test, any(unix, all(windows, target_env = "msvc"))))]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mewndo-writer-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_are_batched_and_a_bad_one_does_not_lose_the_rest() {
        let d = temp("batch");
        let db = d.join("desk.db");
        let w = start(&db, Arc::new(Log::new(&d.join("logs"))));
        for i in 0..1000 {
            w.write(
                "INSERT INTO cards (id, kind, risk, options_json) VALUES (?1, ?2, ?3, ?4)",
                vec![
                    json!(format!("c{i}")),
                    json!("permission"),
                    json!(i % 5),
                    json!(["Allow", "Deny"]),
                ],
            );
        }
        w.write("INSERT INTO no_such_table VALUES (1)", vec![]);
        w.write(
            "INSERT INTO cards (id) VALUES (?1)",
            vec![json!("after-the-bad-one")],
        );
        w.flush();

        let read = rusqlite::Connection::open(&db).unwrap();
        let n: i64 = read
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1001);
        let (risk, options): (i64, String) = read
            .query_row(
                "SELECT risk, options_json FROM cards WHERE id = 'c7'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((risk, options.as_str()), (2, r#"["Allow","Deny"]"#));
        let mode: String = read
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_database_that_cannot_be_opened_fails_open() {
        let d = temp("unopenable");
        let w = start(&d, Arc::new(Log::new(&d.join("logs")))); // a folder, not a file
        w.write("INSERT INTO cards (id) VALUES ('x')", vec![]);
        w.flush(); // returns: the writer keeps running with nothing to write to
        let _ = std::fs::remove_dir_all(&d);
    }
}
