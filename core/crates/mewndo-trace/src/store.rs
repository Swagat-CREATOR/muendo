// T4 and the stores the rules read (spec §35.5). Everything Receipts needs from the rest of Mewndo is a trait
// here, with an in-memory implementation beside it:
//
//   * `SpanStore`   - the trace's spans. Really the `spans` table of §38.6, in SQLite.
//   * `EngineClient`- `diff(savepoint_id, now)`: what the journal says changed since the trace's save point.
//                     Really the v0 engine through `engine_client`; writing it is the engine's job, not this
//                     crate's (CLAUDE.md rule 1 keeps v0 as the reference until the Rust core passes its tests).
//   * `Disk`        - `std::fs::metadata`, which the T6 rows for Created and Deleted call for.
//
// Why traits and not the real thing: the rules are the part that can wrongly accuse a user's agent, so they have
// to be testable without a database, a watcher or a temp folder. It also keeps rusqlite out of this crate, which
// matters because real SQLite is a C amalgamation and the windows-gnu dev box has no C compiler
// (docs/decisions.md, "desk.db"). The one SQL query §35.5 implies - "the last test span after the last file span"
// - is computed in Rust over `spans(trace_id)` instead, so the trait stays one method and any backend satisfies
// it. A turn has tens of spans, not thousands, so the scan is free.
use crate::Span;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// What the journal says changed since a save point (§35.5 T4).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Changes {
    pub created: Vec<String>,
    pub edited: Vec<String>,
    pub deleted: Vec<String>,
}

impl Changes {
    pub fn total(&self) -> usize {
        self.created.len() + self.edited.len() + self.deleted.len()
    }

    /// Every path, in one iterator, for the Untouched and NoChanges rows of T6.
    pub fn all(&self) -> impl Iterator<Item = &String> {
        self.created
            .iter()
            .chain(self.edited.iter())
            .chain(self.deleted.iter())
    }
}

/// The spans of one trace, in any order (the rules sort what they need).
pub trait SpanStore: Send + Sync {
    fn spans(&self, trace_id: &str) -> Vec<Span>;
}

/// The journal diff for one trace (§35.5 T4). An `Err` means "the engine could not tell us", which T6 turns into
/// an unverified claim rather than a mismatch: a claim we cannot check is not a claim the agent got wrong.
pub trait EngineClient: Send + Sync {
    fn diff(&self, savepoint_id: &str, now: i64) -> Result<Changes, String>;
}

/// Does this path exist now? The T6 rows for Created and Deleted ask `std::fs::metadata`; behind a trait so the
/// rule tests do not have to write real files, and so a caller can answer from a cache if it has one.
pub trait Disk: Send + Sync {
    fn exists(&self, path: &Path) -> bool;
}

/// The real answer: `std::fs::metadata`, as §35.5 T6 says. `metadata` and not `symlink_metadata`, because a
/// claim of "created config/link.json" is satisfied by a link that resolves - but a broken link reads as absent,
/// which is also the honest answer for "did you create the file".
pub struct RealDisk;

impl Disk for RealDisk {
    fn exists(&self, path: &Path) -> bool {
        std::fs::metadata(path).is_ok()
    }
}

/// Spans held in memory. Used by the tests, and by any caller that has the spans in hand already and does not
/// want to go through the database (the Stop handler has just written them).
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, Vec<Span>>>);

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    pub fn insert(&self, span: Span) {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        all.entry(span.trace_id.clone()).or_default().push(span);
    }

    /// Insert several spans at once, for building a trace in a test.
    pub fn extend(&self, spans: impl IntoIterator<Item = Span>) {
        for span in spans {
            self.insert(span);
        }
    }
}

impl SpanStore for MemoryStore {
    fn spans(&self, trace_id: &str) -> Vec<Span> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(trace_id)
            .cloned()
            .unwrap_or_default()
    }
}

/// One fixed answer for every save point, counting how often it was asked. The counter is what proves the
/// per-trace cache below actually caches.
pub struct StaticEngine {
    answer: Result<Changes, String>,
    calls: AtomicUsize,
}

impl StaticEngine {
    pub fn new(changes: Changes) -> StaticEngine {
        StaticEngine {
            answer: Ok(changes),
            calls: AtomicUsize::new(0),
        }
    }

    /// An engine that cannot answer, for the "we could not check" path.
    pub fn broken(reason: &str) -> StaticEngine {
        StaticEngine {
            answer: Err(reason.to_string()),
            calls: AtomicUsize::new(0),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl EngineClient for StaticEngine {
    fn diff(&self, _savepoint_id: &str, _now: i64) -> Result<Changes, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.answer.clone()
    }
}

/// A set of paths that exist, for the Created and Deleted rules.
#[derive(Default)]
pub struct MemoryDisk(Vec<PathBuf>);

impl MemoryDisk {
    pub fn with(paths: impl IntoIterator<Item = impl Into<PathBuf>>) -> MemoryDisk {
        MemoryDisk(paths.into_iter().map(Into::into).collect())
    }
}

impl Disk for MemoryDisk {
    fn exists(&self, path: &Path) -> bool {
        self.0.iter().any(|p| p == path)
    }
}

/// §35.5 T4: "cache the result per trace". The diff walks the journal, and several claims in one turn ask for it
/// ("didn't touch db/", "no changes to config/", "deleted old/notes.md"), so without this the rule pass would
/// pay for the same walk once per claim and blow its 10 ms budget on a busy turn.
pub struct Diffs<'a> {
    engine: &'a dyn EngineClient,
    by_trace: Mutex<HashMap<String, Result<Changes, String>>>,
}

impl<'a> Diffs<'a> {
    pub fn new(engine: &'a dyn EngineClient) -> Diffs<'a> {
        Diffs {
            engine,
            by_trace: Mutex::new(HashMap::new()),
        }
    }

    /// The diff for one trace, asking the engine at most once. A trace with no save point has nothing to diff
    /// against - which should not happen, since §35.4 starts every trace with one - so it reads as "no changes"
    /// rather than as an error, and the claims that depend on it stay unverified through the empty diff.
    pub fn for_trace(
        &self,
        trace_id: &str,
        savepoint_id: Option<&str>,
        now: i64,
    ) -> Result<Changes, String> {
        if let Some(cached) = self
            .by_trace
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(trace_id)
        {
            return cached.clone();
        }
        let answer = match savepoint_id {
            Some(id) => self.engine.diff(id, now),
            None => Err("this trace has no save point to compare against".to_string()),
        };
        self.by_trace
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(trace_id.to_string(), answer.clone());
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_memory_store_groups_spans_by_trace() {
        let store = MemoryStore::new();
        store.extend([
            Span::start("s1", "t1", "Bash", "npm test", 1),
            Span::start("s2", "t1", "Edit", "src/a.ts", 2),
            Span::start("s3", "t2", "Bash", "ls", 3),
        ]);
        assert_eq!(store.spans("t1").len(), 2);
        assert_eq!(store.spans("t2").len(), 1);
        assert!(store.spans("nothing").is_empty());
    }

    #[test]
    fn the_diff_is_fetched_once_per_trace() {
        let engine = StaticEngine::new(Changes {
            edited: vec!["src/a.ts".into()],
            ..Changes::default()
        });
        let diffs = Diffs::new(&engine);
        for _ in 0..5 {
            let changes = diffs.for_trace("t1", Some("sp1"), 100).expect("ok");
            assert_eq!(changes.edited, vec!["src/a.ts".to_string()]);
        }
        assert_eq!(engine.calls(), 1, "§35.5 T4 caches the diff per trace");
        // A different trace is a different question.
        diffs.for_trace("t2", Some("sp2"), 100).expect("ok");
        assert_eq!(engine.calls(), 2);
    }

    #[test]
    fn an_engine_error_is_cached_too_and_stays_an_error() {
        let engine = StaticEngine::broken("engine not running");
        let diffs = Diffs::new(&engine);
        assert!(diffs.for_trace("t1", Some("sp1"), 1).is_err());
        assert!(diffs.for_trace("t1", Some("sp1"), 1).is_err());
        assert_eq!(engine.calls(), 1, "a failing engine is not retried per claim");
    }

    #[test]
    fn a_trace_with_no_save_point_never_reaches_the_engine() {
        let engine = StaticEngine::new(Changes::default());
        let diffs = Diffs::new(&engine);
        assert!(diffs.for_trace("t1", None, 1).is_err());
        assert_eq!(engine.calls(), 0);
    }

    #[test]
    fn changes_counts_and_iterates_everything() {
        let changes = Changes {
            created: vec!["a".into()],
            edited: vec!["b".into(), "c".into()],
            deleted: vec!["d".into()],
        };
        assert_eq!(changes.total(), 4);
        assert_eq!(changes.all().count(), 4);
    }

    #[test]
    fn the_memory_disk_answers_only_for_what_it_holds() {
        let disk = MemoryDisk::with(["/work/src/a.ts"]);
        assert!(disk.exists(Path::new("/work/src/a.ts")));
        assert!(!disk.exists(Path::new("/work/src/b.ts")));
    }
}
