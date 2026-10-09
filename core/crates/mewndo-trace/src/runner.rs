// T2 exit codes and T3 the test-command detector (spec §35.5). Both are "what we know about test runners",
// which is one table, so they live in one file.
//
// T3 answers "was this shell command a test run?", because every T6 rule about tests needs to find the last test
// span after the last edit. T2 answers "did it pass?" when the agent's hook payload carried no exit code - field
// names differ between Claude Code, Codex and Cursor, and some payloads have none at all - by reading the
// runner's own summary line out of the output tail and setting `exit_code_inferred`.
//
// Two deliberate differences from the §35.5 T2 table, both to stop a false accusation:
//
//   * every count must be non-zero. dotnet prints `Failed:     0` and cargo prints `0 failed;` on a *green* run,
//     so the table's literal `Failed: N` would read a passing suite as a failing one. A wrong "your tests
//     failed" on a Receipt card is worse than no receipt at all.
//   * inference scans every runner's lines, not just the one the command named. `npm test`, `pnpm test` and
//     `yarn test` only forward to jest, vitest or mocha, and a monorepo script runs several (§35.5 "Pitfalls":
//     any test command counts as test evidence). A failure line from any runner is a failure.
//
// When nothing matches, the result stays unknown. It does not become a pass: T6 turns an unknown test result
// into a soft "unverified" claim, which is the honest answer (CLAUDE.md rule 5).
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// The runners §35.5 T2 names, plus `Other` for a test command whose output we cannot read (Maven, Gradle,
/// `node --test`, `deno test` and the user's own commands have no row in the T2 table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Runner {
    JestVitest,
    Pytest,
    Cargo,
    Go,
    Dotnet,
    Mocha,
    /// npm, pnpm, yarn: a wrapper that forwards to one of the others.
    Npm,
    Other,
}

/// The §35.5 T2 failure line per runner, the matching success line, and the T9 regex that pulls failing test
/// names out of the tail. `None` means that runner prints no such line.
struct Lines {
    runner: Runner,
    fail: &'static str,
    pass: Option<&'static str>,
    names: Option<&'static str>,
}

const LINES: &[Lines] = &[
    Lines {
        runner: Runner::JestVitest,
        // Jest writes `Tests:       2 failed, 3 passed, 5 total`; Vitest writes `Tests  2 failed | 3 passed`.
        fail: r"(?i)\btests?:?\s+[1-9]\d*\s+failed",
        pass: Some(r"(?i)\btests?:?\s+[1-9]\d*\s+passed"),
        // Jest marks a failing test with a bullet or a cross, both of which it prints with the full name path.
        names: Some(r"(?m)^\s*(?:\u{25cf}|\u{2715}|\u{00d7}|\u{2717}|\u{2716})\s+(.+?)\s*$"),
    },
    Lines {
        runner: Runner::Pytest,
        fail: r"(?i)\b[1-9]\d*\s+failed\b",
        pass: Some(r"(?i)\b[1-9]\d*\s+passed\b"),
        // The "short test summary info" block: `FAILED tests/test_date.py::test_iso - assert ...`.
        names: Some(r"(?m)^(?:FAILED|ERROR)\s+(\S+)"),
    },
    Lines {
        runner: Runner::Cargo,
        fail: r"(?i)test result:\s*FAILED",
        pass: Some(r"(?i)test result:\s*ok"),
        names: Some(r"(?m)^test\s+(\S+)\s+\.\.\.\s+FAILED"),
    },
    Lines {
        runner: Runner::Go,
        // Line-anchored: `FAIL` alone, or `--- FAIL: TestX`. `\b` keeps it off "FAILED".
        fail: r"(?m)^(?:---\s+)?FAIL\b",
        pass: Some(r"(?m)^(?:ok|PASS)\b"),
        names: Some(r"(?m)^\s*---\s+FAIL:\s+(\S+)"),
    },
    Lines {
        runner: Runner::Dotnet,
        fail: r"(?i)\bfailed:\s*[1-9]\d*\b",
        // `Passed!` is dotnet's banner; `Passed:   5` is the counts line, which is all that survives when the
        // banner falls off the top of a 2 KB tail.
        pass: Some(r"(?i)(?:\bpassed!|\bpassed:\s*[1-9]\d*\b)"),
        names: Some(r"(?m)^\s*(?:Failed|X)\s+([^\s\[]+)"),
    },
    Lines {
        runner: Runner::Mocha,
        fail: r"(?i)\b[1-9]\d*\s+failing\b",
        pass: Some(r"(?i)\b[1-9]\d*\s+passing\b"),
        names: Some(r"(?m)^\s*\d+\)\s*(.+?)\s*$"),
    },
    Lines {
        runner: Runner::Npm,
        // npm only reports that the script it forwarded to exited non-zero. There is no matching success line,
        // which is why the inner runner's lines are scanned too.
        fail: r"npm ERR!",
        pass: None,
        names: None,
    },
];

struct Compiled {
    runner: Runner,
    fail: Regex,
    pass: Option<Regex>,
    names: Option<Regex>,
}

/// Compiled once: ~20 patterns, and the Stop hook may run several times a minute.
fn compiled() -> &'static [Compiled] {
    static COMPILED: OnceLock<Vec<Compiled>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        LINES
            .iter()
            .map(|l| Compiled {
                runner: l.runner,
                fail: Regex::new(l.fail).expect("a built-in failure pattern compiles"),
                pass: l
                    .pass
                    .map(|p| Regex::new(p).expect("a built-in success pattern compiles")),
                names: l
                    .names
                    .map(|p| Regex::new(p).expect("a built-in name pattern compiles")),
            })
            .collect()
    })
}

/// T2. Infer a test command's exit code from its output tail: `Some(1)` when any runner's failure line is there,
/// `Some(0)` when only a success line is, `None` when neither. Call it only for test commands (T3) with no exit
/// code in the payload, and set `exit_code_inferred` when it answers.
pub fn infer_exit_code(tail: &str) -> Option<i32> {
    if compiled().iter().any(|c| c.fail.is_match(tail)) {
        return Some(1);
    }
    if compiled()
        .iter()
        .any(|c| c.pass.as_ref().is_some_and(|p| p.is_match(tail)))
    {
        return Some(0);
    }
    None
}

/// How many tests the summary line says failed, for the T9 send-back message. `None` when the runner printed no
/// count (cargo's `test result: FAILED` and `npm ERR!` do not), in which case the message says so instead of
/// guessing a number.
pub fn failure_count(tail: &str) -> Option<u32> {
    static COUNT: OnceLock<Regex> = OnceLock::new();
    let re = COUNT.get_or_init(|| {
        Regex::new(r"(?i)(?:\b([1-9]\d*)\s+(?:failed|failing)\b|\bfailed:\s*([1-9]\d*)\b)")
            .expect("the failure-count pattern compiles")
    });
    let caps = re.captures(tail)?;
    caps.get(1)
        .or_else(|| caps.get(2))?
        .as_str()
        .parse()
        .ok()
}

/// T9. The first `limit` failing test names in the tail. A wrapper (`Npm`) or an unknown runner (`Other`) has no
/// pattern of its own, so every runner's pattern is tried - which is also right for a monorepo script.
pub fn failing_tests(runner: Runner, tail: &str, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let own = compiled().iter().find(|c| c.runner == runner);
    // The named runner first, so its own naming wins when two patterns both match.
    let order = own
        .into_iter()
        .chain(compiled().iter().filter(|c| c.runner != runner));
    for c in order {
        let Some(names) = c.names.as_ref() else {
            continue;
        };
        for caps in names.captures_iter(tail) {
            let name = caps
                .get(1)
                .map(|m| m.as_str().trim())
                .unwrap_or("")
                .trim_end_matches(':')
                .trim();
            if name.is_empty() || out.iter().any(|n| n == name) {
                continue;
            }
            out.push(name.to_string());
            if out.len() >= limit {
                return out;
            }
        }
        if !out.is_empty() {
            // One runner produced names; mixing in another runner's pattern would only add noise.
            return out;
        }
    }
    out
}

/// T3. The test commands this crate recognizes: the §35.5 T3 list, plus the user's own from `rules.toml`
/// `[tests] commands` (§34.9 R1).
pub struct Tests {
    /// Normalized phrase to the runner it names, in checking order.
    phrases: Vec<(String, Runner)>,
}

/// The §35.5 T3 list. `bun test` is read as jest/vitest because its summary lines copy theirs; Maven, Gradle,
/// `node --test` and `deno test` are `Other` because the T2 table has no line for them, so without a payload
/// exit code their result stays unknown rather than guessed.
const BUILTIN: &[(&str, Runner)] = &[
    ("npx jest", Runner::JestVitest),
    ("npx vitest", Runner::JestVitest),
    ("bun test", Runner::JestVitest),
    ("python -m pytest", Runner::Pytest),
    ("pytest", Runner::Pytest),
    ("cargo test", Runner::Cargo),
    ("go test", Runner::Go),
    ("dotnet test", Runner::Dotnet),
    ("mvn test", Runner::Other),
    // One phrase covers `gradle test`, `./gradlew test` and `gradlew test`: the boundary check only asks that
    // the character before the phrase is not part of a word, and `/` is not.
    ("gradlew test", Runner::Other),
    ("gradle test", Runner::Other),
    ("node --test", Runner::Other),
    ("deno test", Runner::Other),
    ("npm run test", Runner::Npm),
    ("npm test", Runner::Npm),
    ("pnpm run test", Runner::Npm),
    ("pnpm test", Runner::Npm),
    ("yarn test", Runner::Npm),
];

impl Default for Tests {
    fn default() -> Self {
        Tests::builtin()
    }
}

impl Tests {
    pub fn builtin() -> Tests {
        Tests {
            phrases: BUILTIN
                .iter()
                .map(|(p, r)| ((*p).to_string(), *r))
                .collect(),
        }
    }

    /// Add `[tests] commands` from a rules.toml. They go last, so the built-in runner knowledge still wins for a
    /// command we already understand and the user's list only adds commands we did not know.
    pub fn with_rules_toml(mut self, src: &str) -> Result<Tests, String> {
        #[derive(Deserialize, Default)]
        struct Section {
            #[serde(default)]
            commands: Vec<String>,
        }
        #[derive(Deserialize)]
        struct File {
            #[serde(default)]
            tests: Section,
        }
        let file: File = toml::from_str(src).map_err(|e| format!("rules.toml: {e}"))?;
        for command in file.tests.commands {
            let phrase = normalize(&command);
            if !phrase.is_empty() {
                // `Other`: the user's command may run anything, so its result is inferred from whichever
                // runner's lines turn up in the output rather than assumed.
                self.phrases.push((phrase, Runner::Other));
            }
        }
        Ok(self)
    }

    /// Which runner this command names, or `None` when it is not a test command.
    pub fn detect(&self, command: &str) -> Option<Runner> {
        let normalized = normalize(command);
        self.phrases
            .iter()
            .find(|(phrase, _)| contains_phrase(&normalized, phrase))
            .map(|(_, runner)| *runner)
    }
}

/// Lowercased, quotes and Windows wrappers dropped, whitespace collapsed. `cd api && npm.cmd "test"` becomes
/// `cd api && npm test`, so one phrase list matches Bash and PowerShell, and a chained command still counts.
pub fn normalize(command: &str) -> String {
    let mut s = command.to_lowercase();
    for ext in [".cmd", ".exe", ".ps1", ".bat"] {
        if s.contains(ext) {
            s = s.replace(&format!("{ext} "), " ");
            if let Some(stripped) = s.strip_suffix(ext) {
                s = stripped.to_string();
            }
        }
    }
    let mut out = String::with_capacity(s.len());
    let mut at_space = true;
    for c in s.chars() {
        let c = if c.is_whitespace() || c == '"' || c == '\'' {
            ' '
        } else {
            c
        };
        if c == ' ' {
            if !at_space {
                out.push(' ');
            }
            at_space = true;
        } else {
            out.push(c);
            at_space = false;
        }
    }
    out.trim().to_string()
}

/// `contains`, but the phrase may not start inside a word. Without this, `pnpm test` matches the phrase
/// `npm test` (it contains it) and `mynpm test` would count as a test run.
fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    let mut from = 0;
    while let Some(offset) = haystack[from..].find(phrase) {
        let at = from + offset;
        let starts_a_word = haystack[..at]
            .chars()
            .next_back()
            .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '-');
        if starts_a_word {
            return true;
        }
        from = at + phrase.len();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // One tail per runner, in the shape the runner really prints.
    const JEST_FAIL: &str = "FAIL  src/date.spec.ts\n  \u{25cf} date.spec.ts \u{203a} parses ISO\n\nTests:       2 failed, 3 passed, 5 total\nTime:        1.42 s";
    const JEST_PASS: &str = "PASS  src/date.spec.ts\nTests:       5 passed, 5 total";
    const PYTEST_FAIL: &str = "=========== short test summary info ===========\nFAILED tests/test_date.py::test_iso - assert 1 == 2\n=========== 1 failed, 4 passed in 0.31s ===========";
    const PYTEST_PASS: &str = "=========== 5 passed in 0.12s ===========";
    const CARGO_FAIL: &str =
        "test date::parses_iso ... FAILED\n\nfailures:\n    date::parses_iso\n\ntest result: FAILED. 4 passed; 1 failed; 0 ignored";
    const CARGO_PASS: &str = "test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured";
    const GO_FAIL: &str = "--- FAIL: TestParseISO (0.00s)\n    date_test.go:12: want 1 got 2\nFAIL\nFAIL\texample.com/date\t0.012s";
    const GO_PASS: &str = "ok  \texample.com/date\t0.012s";
    const DOTNET_FAIL: &str =
        "  Failed DateTests.ParsesIso [3 ms]\nFailed!  - Failed:     2, Passed:     5, Skipped:     0";
    const DOTNET_PASS: &str = "Passed!  - Failed:     0, Passed:     5, Skipped:     0";
    const MOCHA_FAIL: &str = "  3 passing (21ms)\n  1 failing\n\n  1) date parses ISO:\n     AssertionError";
    const MOCHA_PASS: &str = "  4 passing (18ms)";
    const NPM_FAIL: &str = "npm ERR! Test failed.  See above for more details.";

    #[test]
    fn t2_infers_a_failure_for_every_runner() {
        for (name, tail) in [
            ("jest/vitest", JEST_FAIL),
            ("pytest", PYTEST_FAIL),
            ("cargo", CARGO_FAIL),
            ("go", GO_FAIL),
            ("dotnet", DOTNET_FAIL),
            ("mocha", MOCHA_FAIL),
            ("npm", NPM_FAIL),
        ] {
            assert_eq!(infer_exit_code(tail), Some(1), "{name} failure not inferred");
        }
    }

    #[test]
    fn t2_infers_a_pass_for_every_runner_that_prints_one() {
        for (name, tail) in [
            ("jest/vitest", JEST_PASS),
            ("pytest", PYTEST_PASS),
            ("cargo", CARGO_PASS),
            ("go", GO_PASS),
            ("dotnet", DOTNET_PASS),
            ("mocha", MOCHA_PASS),
        ] {
            assert_eq!(infer_exit_code(tail), Some(0), "{name} pass not inferred");
        }
    }

    #[test]
    fn a_zero_count_is_not_a_failure() {
        // The reason for the non-zero counts: these are green runs that the literal T2 lines would fail.
        assert_eq!(infer_exit_code("Failed:     0, Passed:     5"), Some(0));
        assert_eq!(infer_exit_code("test result: ok. 5 passed; 0 failed"), Some(0));
        assert_eq!(infer_exit_code("Tests: 0 failed, 5 passed"), Some(0));
    }

    #[test]
    fn an_unreadable_tail_stays_unknown() {
        assert_eq!(infer_exit_code(""), None);
        assert_eq!(infer_exit_code("Building...\nDone in 4.2s"), None);
        // Maven and Gradle have no T2 line, so a run we cannot read is reported as unknown, not as a pass.
        assert_eq!(infer_exit_code("[INFO] BUILD SUCCESS"), None);
    }

    #[test]
    fn failure_counts_come_from_the_summary_line() {
        assert_eq!(failure_count(JEST_FAIL), Some(2));
        assert_eq!(failure_count(PYTEST_FAIL), Some(1));
        assert_eq!(failure_count(DOTNET_FAIL), Some(2));
        assert_eq!(failure_count(MOCHA_FAIL), Some(1));
        assert_eq!(failure_count(NPM_FAIL), None, "npm prints no count");
    }

    #[test]
    fn t9_pulls_the_failing_test_names() {
        assert_eq!(
            failing_tests(Runner::JestVitest, JEST_FAIL, 3),
            vec!["date.spec.ts \u{203a} parses ISO"]
        );
        assert_eq!(
            failing_tests(Runner::Pytest, PYTEST_FAIL, 3),
            vec!["tests/test_date.py::test_iso"]
        );
        assert_eq!(
            failing_tests(Runner::Cargo, CARGO_FAIL, 3),
            vec!["date::parses_iso"]
        );
        assert_eq!(failing_tests(Runner::Go, GO_FAIL, 3), vec!["TestParseISO"]);
        assert_eq!(
            failing_tests(Runner::Dotnet, DOTNET_FAIL, 3),
            vec!["DateTests.ParsesIso"]
        );
        assert_eq!(
            failing_tests(Runner::Mocha, MOCHA_FAIL, 3),
            vec!["date parses ISO"]
        );
    }

    #[test]
    fn a_wrapper_finds_the_inner_runners_names() {
        // `npm test` forwarding to jest: the Npm runner has no pattern of its own.
        assert_eq!(
            failing_tests(Runner::Npm, JEST_FAIL, 3),
            vec!["date.spec.ts \u{203a} parses ISO"]
        );
    }

    #[test]
    fn only_the_first_three_names_are_reported() {
        let tail = "--- FAIL: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- FAIL: TestC (0.00s)\n--- FAIL: TestD (0.00s)\nFAIL";
        assert_eq!(failing_tests(Runner::Go, tail, 3), vec!["TestA", "TestB", "TestC"]);
    }

    #[test]
    fn t3_detects_the_whole_spec_list() {
        let tests = Tests::builtin();
        for (command, expected) in [
            ("npm test", Runner::Npm),
            ("npm run test", Runner::Npm),
            ("pnpm test", Runner::Npm),
            ("yarn test", Runner::Npm),
            ("bun test", Runner::JestVitest),
            ("npx jest", Runner::JestVitest),
            ("npx vitest run", Runner::JestVitest),
            ("pytest -q", Runner::Pytest),
            ("python -m pytest", Runner::Pytest),
            ("cargo test -p mewndo-trace", Runner::Cargo),
            ("go test ./...", Runner::Go),
            ("dotnet test", Runner::Dotnet),
            ("mvn test", Runner::Other),
            ("gradle test", Runner::Other),
            ("./gradlew test", Runner::Other),
            ("node --test", Runner::Other),
            ("deno test", Runner::Other),
        ] {
            assert_eq!(tests.detect(command), Some(expected), "{command}");
        }
    }

    #[test]
    fn t3_ignores_what_is_not_a_test_command() {
        let tests = Tests::builtin();
        for command in ["git status", "npm install", "ls -la", "cargo build", "npm run lint"] {
            assert_eq!(tests.detect(command), None, "{command}");
        }
    }

    #[test]
    fn t3_sees_through_windows_wrappers_quotes_and_chains() {
        let tests = Tests::builtin();
        assert_eq!(tests.detect("npm.cmd test"), Some(Runner::Npm));
        assert_eq!(tests.detect("NPM TEST"), Some(Runner::Npm));
        assert_eq!(tests.detect("cd api && npm run \"test\""), Some(Runner::Npm));
        assert_eq!(tests.detect("C:\\tools\\pytest.exe -q"), Some(Runner::Pytest));
    }

    #[test]
    fn a_phrase_may_not_start_inside_a_word() {
        let tests = Tests::builtin();
        // `pnpm test` really does contain the substring `npm test`; the boundary check is what keeps
        // `mynpm test` out while letting `pnpm test` match its own phrase.
        assert_eq!(tests.detect("pnpm test"), Some(Runner::Npm));
        assert_eq!(tests.detect("mynpm testing"), None);
    }

    #[test]
    fn t3_adds_the_users_own_commands() {
        let tests = Tests::builtin()
            .with_rules_toml("[tests]\ncommands = [\"make check\", \"bazel test //...\"]")
            .expect("a well-formed rules.toml");
        assert_eq!(tests.detect("make check"), Some(Runner::Other));
        assert_eq!(tests.detect("bazel test //..."), Some(Runner::Other));
        // The built-in knowledge still wins for a command we already understand.
        assert_eq!(tests.detect("cargo test"), Some(Runner::Cargo));
        // A rules.toml with no [tests] section is fine; a broken one is an error, not a panic.
        assert!(Tests::builtin().with_rules_toml("[deny]\ncommands = []").is_ok());
        assert!(Tests::builtin().with_rules_toml("[tests").is_err());
    }
}
