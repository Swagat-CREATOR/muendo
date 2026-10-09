// T1 spans (spec §35.5). One span is one thing the agent did inside a turn. mewndo-core opens it on `PreToolUse`
// and closes it on `PostToolUse`; the fields are exactly the `spans` table of §38.6 plus `exit_code_inferred`,
// which T2 needs in order to be honest about where an exit code came from.
//
// Two decisions worth knowing:
//
//   * `output_tail` is the last 2 KB of stdout followed by the last 1 KB of stderr, in one string. Keeping them
//     apart would mean every T2 and T9 pattern had to be tried twice, and runners disagree about which stream
//     their summary goes to (cargo and go write it to stdout, npm writes its errors to stderr, pytest can do
//     either under a pipe). The cut is moved forward to a character boundary: a tail cut mid-character would
//     panic the Stop hook on any output with a box-drawing character in it, which is most test runners.
//   * `output_hash` hashes the tail with timestamps and durations removed, so the same failure twice in a row
//     hashes the same. That is what the Router's loop brake compares (§34.9 R5 `same_action_failed_recently`):
//     without the stripping, a clock reading makes every identical failure look new.
use crate::runner::{self, Runner};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// §35.5 T1: the last 2 KB of stdout.
pub const STDOUT_TAIL: usize = 2048;
/// §35.5 T1: the last 1 KB of stderr.
pub const STDERR_TAIL: usize = 1024;

/// What kind of thing the span is, from the tool name (§35.5 T1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpanKind {
    Shell,
    File,
    Mcp,
    Subagent,
    Computer,
    /// A tool we have no mapping for: a read, a search, a web fetch. Kept, because the trace is also the
    /// agent's history, but no rule reads it.
    Other,
}

impl SpanKind {
    /// Map a tool name, in the order §35.5 T1 gives. The order matters for one real case: `mcp__computer__click`
    /// is an MCP call by this mapping, because `mcp__*` is listed before `computer_*`. The computer-use proxy
    /// labels its own spans `computer` directly (§36.6), so nothing is lost.
    ///
    /// Matching is case-insensitive: Claude Code sends `Bash`, Cursor and Codex send other spellings of the same
    /// tools, and a span whose kind is wrong is a rule that never fires.
    pub fn from_tool(tool: &str) -> SpanKind {
        let tool = tool.trim().to_lowercase();
        if matches!(tool.as_str(), "bash" | "powershell" | "pwsh" | "shell" | "terminal") {
            SpanKind::Shell
        } else if matches!(tool.as_str(), "edit" | "write" | "multiedit" | "notebookedit") {
            SpanKind::File
        } else if tool.starts_with("mcp__") {
            SpanKind::Mcp
        } else if matches!(tool.as_str(), "task" | "agent" | "subagent") {
            SpanKind::Subagent
        } else if tool.starts_with("computer_") {
            SpanKind::Computer
        } else {
            SpanKind::Other
        }
    }
}

/// One thing done inside a turn. Times are milliseconds since the epoch, as §38.6 stores them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub id: String,
    pub trace_id: String,
    pub parent_id: Option<String>,
    pub kind: SpanKind,
    /// The tool name, or for a `shell` span the command line itself: that is what the Receipt line prints
    /// ("npm test passed after the last edit") and what T3 reads to decide whether this was a test run.
    pub name: String,
    pub output_tail: String,
    pub exit_code: Option<i32>,
    /// True when T2 read the exit code off a summary line instead of the hook payload. A Receipt that says
    /// "tests failed" on an inferred code should be able to say so.
    pub exit_code_inferred: bool,
    pub output_hash: String,
    /// Paths this span touched, when the tool names them (`Edit`, `Write`, `MultiEdit`). The authoritative list
    /// of what changed is still the journal diff (T4): a shell command changes files it never names.
    pub files: Vec<String>,
    pub savepoint_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

impl Span {
    /// `PreToolUse`: open a span. The kind comes from the tool name; everything the result fills in is empty.
    pub fn start(
        id: impl Into<String>,
        trace_id: impl Into<String>,
        tool: &str,
        name: impl Into<String>,
        started_at: i64,
    ) -> Span {
        Span {
            id: id.into(),
            trace_id: trace_id.into(),
            parent_id: None,
            kind: SpanKind::from_tool(tool),
            name: name.into(),
            output_tail: String::new(),
            exit_code: None,
            exit_code_inferred: false,
            output_hash: String::new(),
            files: Vec::new(),
            savepoint_id: None,
            started_at,
            ended_at: None,
        }
    }

    /// `PostToolUse`: close a span. `exit_code` is whatever the payload carried, which for many agents and many
    /// tools is nothing; T2 then infers it, but only for a test command, because only a test runner prints a
    /// summary line we can read with any confidence.
    pub fn finish(
        &mut self,
        stdout: &str,
        stderr: &str,
        exit_code: Option<i32>,
        ended_at: i64,
        tests: &runner::Tests,
    ) {
        self.output_tail = tail(stdout, stderr);
        self.output_hash = output_hash(&self.output_tail);
        self.ended_at = Some(ended_at);
        self.exit_code = exit_code;
        self.exit_code_inferred = false;
        if exit_code.is_none()
            && self.kind == SpanKind::Shell
            && tests.detect(&self.name).is_some()
            && let Some(inferred) = runner::infer_exit_code(&self.output_tail)
        {
            self.exit_code = Some(inferred);
            self.exit_code_inferred = true;
        }
    }

    /// When this span happened, for ordering. A span that never got its `PostToolUse` (the agent was stopped
    /// mid-tool) is ordered by when it started, which is the only time it has.
    pub fn at(&self) -> i64 {
        self.ended_at.unwrap_or(self.started_at)
    }

    /// Which test runner this span ran, or `None` when it is not a test command (§35.5 T3).
    pub fn test_runner(&self, tests: &runner::Tests) -> Option<Runner> {
        if self.kind != SpanKind::Shell {
            return None;
        }
        tests.detect(&self.name)
    }
}

/// The last 2 KB of stdout plus the last 1 KB of stderr (§35.5 T1).
pub fn tail(stdout: &str, stderr: &str) -> String {
    let out = last_bytes(stdout, STDOUT_TAIL);
    let err = last_bytes(stderr, STDERR_TAIL);
    match (out.is_empty(), err.is_empty()) {
        (_, true) => out.to_string(),
        (true, false) => err.to_string(),
        (false, false) => format!("{out}\n{err}"),
    }
}

/// The last `n` bytes, moved forward to a character boundary. Slicing a `&str` at an arbitrary byte offset
/// panics, and test runners print box-drawing characters, arrows and ticks constantly.
fn last_bytes(s: &str, n: usize) -> &str {
    if s.len() <= n {
        return s;
    }
    let mut at = s.len() - n;
    while at < s.len() && !s.is_char_boundary(at) {
        at += 1;
    }
    &s[at..]
}

/// Timestamps, clock times, durations and percentages: everything that differs between two runs of the same
/// command with the same result. Built once; the alternation is cheap compared with compiling it per span.
fn volatile() -> &'static Regex {
    static VOLATILE: OnceLock<Regex> = OnceLock::new();
    VOLATILE.get_or_init(|| {
        Regex::new(
            r"(?ix)
              \d{4}-\d{2}-\d{2}[T\ ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?  # ISO timestamps
            | \b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:am|pm)?                          # clock times
            | \b\d+(?:[.,]\d+)?\s*                                                       # durations
              (?:ms|us|ns|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs)\b
            | \(\s*\d+(?:[.,]\d+)?\s*[a-z]*\s*\)                                         # (1.42 s), (21ms)
            | \b\d+(?:[.,]\d+)?%                                                         # progress
            ",
        )
        .expect("the volatile-text pattern compiles")
    })
}

/// blake3 of the tail with the volatile parts replaced, truncated to 16 bytes of hex. Equality is all anyone
/// asks of this hash (§34.9 R4 truncates its own signature the same way), and a 32-character column is half the
/// row of a 64-character one in a table that keeps 30 days of spans.
pub fn output_hash(tail: &str) -> String {
    let stable = volatile().replace_all(tail, "<t>");
    let hash = blake3::hash(stable.as_bytes());
    hash.to_hex()[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_map_to_kinds() {
        for (tool, kind) in [
            ("Bash", SpanKind::Shell),
            ("PowerShell", SpanKind::Shell),
            ("bash", SpanKind::Shell),
            ("Edit", SpanKind::File),
            ("Write", SpanKind::File),
            ("MultiEdit", SpanKind::File),
            ("mcp__gmail__send_email", SpanKind::Mcp),
            ("Task", SpanKind::Subagent),
            ("Agent", SpanKind::Subagent),
            ("computer_click", SpanKind::Computer),
            ("Read", SpanKind::Other),
            ("WebFetch", SpanKind::Other),
        ] {
            assert_eq!(SpanKind::from_tool(tool), kind, "{tool}");
        }
    }

    #[test]
    fn the_tail_is_the_last_2kb_of_stdout_and_1kb_of_stderr() {
        let out = "o".repeat(5000);
        let err = "e".repeat(5000);
        let tail = tail(&out, &err);
        assert_eq!(tail.len(), STDOUT_TAIL + 1 + STDERR_TAIL);
        assert!(tail.starts_with("oo") && tail.ends_with("ee"));
        // Short output is kept whole, and an empty stream adds no separator.
        assert_eq!(super::tail("out", ""), "out");
        assert_eq!(super::tail("", "err"), "err");
        assert_eq!(super::tail("out", "err"), "out\nerr");
    }

    #[test]
    fn the_tail_cut_never_splits_a_character() {
        // A runner's tick is three bytes; cutting at an arbitrary byte offset would panic.
        let out = "\u{2713}".repeat(2000);
        let tail = tail(&out, "");
        assert!(tail.len() <= STDOUT_TAIL);
        assert!(tail.chars().all(|c| c == '\u{2713}'));
    }

    #[test]
    fn the_hash_ignores_timestamps_and_durations() {
        let first = "test result: ok. 5 passed; 0 failed; finished in 1.42s\n2026-10-09T11:08:30Z done";
        let second = "test result: ok. 5 passed; 0 failed; finished in 3.91s\n2026-10-09T11:59:02Z done";
        assert_eq!(output_hash(first), output_hash(second));
        assert_eq!(output_hash("Done (21ms)"), output_hash("Done (4.10 s)"));
        assert_eq!(output_hash("Progress 12%"), output_hash("Progress 97%"));
    }

    #[test]
    fn the_hash_still_separates_different_results() {
        // The whole point of the loop brake: two different failures must not look like one repeated failure.
        assert_ne!(
            output_hash("Tests: 2 failed in 1.0s"),
            output_hash("Tests: 3 failed in 1.0s")
        );
        assert_ne!(
            output_hash("test result: ok"),
            output_hash("test result: FAILED")
        );
        assert_eq!(output_hash("x").len(), 32);
    }

    #[test]
    fn a_shell_span_with_no_payload_exit_code_infers_one_for_a_test_command() {
        let tests = runner::Tests::builtin();
        let mut span = Span::start("s1", "t1", "Bash", "npm test", 1_000);
        span.finish("Tests:       2 failed, 3 passed, 5 total", "", None, 2_000, &tests);
        assert_eq!(span.exit_code, Some(1));
        assert!(span.exit_code_inferred);
        assert_eq!(span.ended_at, Some(2_000));
        assert_eq!(span.test_runner(&tests), Some(Runner::Npm));
    }

    #[test]
    fn a_payload_exit_code_is_never_overridden() {
        // §35.5 T2: take the payload's code when there is one. A runner that prints "1 failed" for a flaky
        // retry it then passed must not turn a 0 into a 1.
        let tests = runner::Tests::builtin();
        let mut span = Span::start("s1", "t1", "Bash", "npm test", 1_000);
        span.finish("1 failed, 4 passed", "", Some(0), 2_000, &tests);
        assert_eq!(span.exit_code, Some(0));
        assert!(!span.exit_code_inferred);
    }

    #[test]
    fn nothing_is_inferred_for_a_command_that_is_not_a_test_run() {
        // "1 failed" in a deploy log is not a test result.
        let tests = runner::Tests::builtin();
        let mut span = Span::start("s1", "t1", "Bash", "npm run deploy", 1_000);
        span.finish("1 failed to upload", "", None, 2_000, &tests);
        assert_eq!(span.exit_code, None);
        assert!(!span.exit_code_inferred);
        assert_eq!(span.test_runner(&tests), None);
    }

    #[test]
    fn a_span_that_never_finished_is_ordered_by_its_start() {
        let span = Span::start("s1", "t1", "Bash", "npm test", 1_000);
        assert_eq!(span.at(), 1_000);
        assert_eq!(span.ended_at, None);
    }
}
