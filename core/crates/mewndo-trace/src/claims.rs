// T5: pull claims out of the agent's final message (spec §35.5). This is the piece that decides whether a user
// ever hears that an agent said "all tests pass" over a red test run, so it is deliberately cautious: a claim we
// miss costs the user a warning, a claim we invent costs the user their trust in every warning. When in doubt,
// drop the claim.
//
// Three things are thrown away before any pattern runs, because each one is a sentence the agent is not asserting
// (§35.5 "Pitfalls"):
//   1. fenced code blocks  - a pasted test log says "2 tests failed" about the past, not about now;
//   2. blockquoted lines   - the agent is repeating the user's words, or a log, back at them;
//   3. double-quoted runs  - "I was asked to make sure the tests pass" is a quotation of the brief.
// Inline code spans are kept: real claims are written as "`npm test` passes" and "didn't touch `db/`", so
// stripping backticks would throw away most of the claims worth checking.
//
// What is left is split into clauses, and each pattern runs per clause, because the negation check only makes
// sense inside one statement: "No changes to db/ and all tests pass" must not read as a negated "tests pass".
// Patterns are ordered (claims.toml) and at most 10 claims are kept, so the order is the priority the cap drops.
use crate::ClaimType;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;

/// §35.5 T5. A turn with more claims than this is a summary, not a promise; checking the first 10 keeps the rule
/// pass inside its 10 ms budget and keeps the Router call (T7) inside its 600-token state.
pub const MAX_CLAIMS: usize = 10;

/// One thing the agent said it did, with the path, folder or recipient it said it about.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, Deserialize)]
pub struct Claim {
    pub kind: ClaimType,
    /// The path, folder (always with a trailing `/`) or recipient. `None` for claims that have no subject.
    pub subject: Option<String>,
    /// The words that matched, for the warning card and for the Router's `state` (T7).
    pub text: String,
}

/// What a pattern's `subj` group is allowed to be. The pattern stays a dumb `[^\s,;:!?]+`; the judging happens
/// here, where it can be read and tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Subject {
    /// The pattern has no subject group.
    None,
    /// A path: it must contain a separator or an extension, so "the database" is not read as a path.
    Path,
    /// A file name, which §35.5 T5 says must have an extension.
    File,
    /// A bare directory name from wording like "the db folder", normalized to `db/`.
    Folder,
    /// An address or a person's name: anything non-empty.
    Name,
}

impl Subject {
    /// Clean up a captured subject and accept or reject it. `None` means "this is not the claim it looks like",
    /// which drops the match rather than inventing a path.
    fn accept(self, raw: &str) -> Option<Option<String>> {
        if self == Subject::None {
            return Some(None);
        }
        // Agents wrap paths in backticks, quotes, brackets and bold markers; a sentence leaves punctuation stuck
        // to the end. A trailing `/` is kept: it is the difference between a file and a folder.
        let s = raw.trim_matches(|c: char| "`'\"()[]{}<>*_".contains(c));
        let s = s.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
        if s.is_empty() {
            return None;
        }
        let ok = match self {
            Subject::None => true,
            Subject::Path => s.contains('/') || s.contains('\\') || has_extension(s),
            Subject::File => has_extension(s),
            Subject::Folder => !s.contains('/') && !s.contains('\\'),
            Subject::Name => true,
        };
        if !ok {
            return None;
        }
        Some(Some(if self == Subject::Folder {
            format!("{s}/")
        } else {
            s.to_string()
        }))
    }
}

/// `a.ts` yes, `db/` no, `database` no. Short and alphanumeric so a sentence's last word ("it.") is not an
/// extension and a version ("v1.2") is allowed to be one - a wrong yes here only means we check a path that
/// doesn't exist, which the T6 rule reports honestly.
fn has_extension(s: &str) -> bool {
    s.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty()
            && !ext.is_empty()
            && ext.len() <= 6
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

/// Words that turn a claim into its opposite. Checked against the four words before a match, not the whole
/// clause: "No changes to db/ and all tests pass" has a negation in it, but not of "all tests pass".
const NEGATIONS: &[&str] = &[
    "not",
    "no",
    "never",
    "none",
    "nothing",
    "dont",
    "don't",
    "doesnt",
    "doesn't",
    "didnt",
    "didn't",
    "havent",
    "haven't",
    "hasnt",
    "hasn't",
    "isnt",
    "isn't",
    "arent",
    "aren't",
    "wasnt",
    "wasn't",
    "werent",
    "weren't",
    "wont",
    "won't",
    "cant",
    "can't",
    "cannot",
    "couldnt",
    "couldn't",
    "shouldnt",
    "shouldn't",
    "unable",
    "failed",
    "unverified",
    "unsure",
    "doubt",
    "whether",
];

/// How many words before a match are read for a negation. Four reaches "I haven't been able to check that <the
/// tests pass>" without reaching into the previous statement.
const NEGATION_WORDS: usize = 4;

/// The compiled pattern list.
pub struct Claims {
    rules: Vec<Rule>,
}

struct Rule {
    kind: ClaimType,
    re: Regex,
    subject: Subject,
}

#[derive(Deserialize)]
struct File {
    #[serde(default)]
    claim: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
    #[serde(rename = "type")]
    kind: String,
    pattern: String,
    #[serde(default)]
    subject: String,
}

impl Claims {
    /// The shipped patterns, compiled once. A broken pattern in the embedded file is a build-time mistake, so it
    /// panics here with the offending pattern rather than silently checking nothing.
    pub fn builtin() -> &'static Claims {
        static BUILTIN: OnceLock<Claims> = OnceLock::new();
        BUILTIN.get_or_init(|| {
            Claims::parse(include_str!("../claims.toml")).expect("the embedded claims.toml compiles")
        })
    }

    /// Compile a claims.toml. Used for the user's override file, so a typo in it is an error the caller reports
    /// and then carries on with `builtin()` - never a crash at Stop.
    pub fn parse(src: &str) -> Result<Claims, String> {
        let file: File = toml::from_str(src).map_err(|e| format!("claims.toml: {e}"))?;
        let mut rules = Vec::with_capacity(file.claim.len());
        for entry in file.claim {
            let kind = ClaimType::parse(&entry.kind)
                .ok_or_else(|| format!("claims.toml: unknown claim type {:?}", entry.kind))?;
            let subject = match entry.subject.as_str() {
                "" => Subject::None,
                "path" => Subject::Path,
                "file" => Subject::File,
                "folder" => Subject::Folder,
                "name" => Subject::Name,
                other => return Err(format!("claims.toml: unknown subject {other:?}")),
            };
            let re = Regex::new(&entry.pattern)
                .map_err(|e| format!("claims.toml: pattern {:?}: {e}", entry.pattern))?;
            if subject != Subject::None && !re.capture_names().any(|n| n == Some("subj")) {
                return Err(format!(
                    "claims.toml: pattern {:?} has subject {:?} but no (?<subj>...) group",
                    entry.pattern, entry.subject
                ));
            }
            rules.push(Rule { kind, re, subject });
        }
        Ok(Claims { rules })
    }

    /// Every claim the message makes, in pattern order, at most `MAX_CLAIMS`.
    pub fn extract(&self, message: &str) -> Vec<Claim> {
        let text = scannable(message);
        let clauses = clauses(&text);
        let mut out: Vec<Claim> = Vec::new();
        // The same claim said twice ("the tests pass... all tests pass") is one claim; checking it twice would
        // also ask the Router the same question twice.
        let mut seen: HashSet<(ClaimType, Option<String>)> = HashSet::new();
        for rule in &self.rules {
            for clause in &clauses {
                for caps in rule.re.captures_iter(clause) {
                    let whole = caps.get(0).expect("group 0 always matches");
                    if negated(clause, whole.start()) {
                        continue;
                    }
                    let raw = caps.name("subj").map(|m| m.as_str()).unwrap_or("");
                    let Some(subject) = rule.subject.accept(raw) else {
                        continue;
                    };
                    if !seen.insert((rule.kind, subject.clone())) {
                        continue;
                    }
                    out.push(Claim {
                        kind: rule.kind,
                        subject,
                        text: whole.as_str().trim().to_string(),
                    });
                    if out.len() >= MAX_CLAIMS {
                        return out;
                    }
                }
            }
        }
        out
    }
}

/// Drop fenced code blocks, blockquotes and quoted runs, keeping line breaks so clause splitting still works.
fn scannable(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut fenced = false;
    for line in message.lines() {
        let trimmed = line.trim_start();
        // A fence toggles, and both fence lines are dropped. An unclosed fence swallows the rest of the message:
        // that is the safe direction, because an unclosed fence means we cannot tell prose from output.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || trimmed.starts_with('>') {
            continue;
        }
        let mut quoted = false;
        for c in line.chars() {
            match c {
                '"' | '\u{201c}' | '\u{201d}' => {
                    quoted = !quoted;
                    out.push(' ');
                }
                // Quoted text is blanked rather than removed so words either side do not join into a new claim.
                _ => out.push(if quoted { ' ' } else { c }),
            }
        }
        out.push('\n');
    }
    out
}

/// Split into statements. Sentence punctuation only counts when whitespace or the end follows it, so `src/a.ts`
/// and `3.5s` stay in one piece. Commas are not boundaries: "didn't touch db/, config/" is one statement.
fn clauses(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..bytes.len() {
        let c = bytes[i];
        let boundary = c == b'\n'
            || (matches!(c, b'.' | b';' | b':' | b'!' | b'?')
                && bytes.get(i + 1).is_none_or(|n| n.is_ascii_whitespace()));
        if boundary {
            if start < i {
                out.push(&text[start..i]);
            }
            start = i + 1;
        }
    }
    if start < bytes.len() {
        out.push(&text[start..]);
    }
    out
}

/// Is the match at `at` negated by the words just before it? The scan stops at a comma or a conjunction, so a
/// negation belonging to an earlier statement in the same sentence is not borrowed.
fn negated(clause: &str, at: usize) -> bool {
    let lower = clause[..at].to_lowercase();
    let mut cut = 0;
    for sep in [",", " and ", " but ", " or ", " then ", " while ", " so ", "("] {
        if let Some(i) = lower.rfind(sep) {
            cut = cut.max(i + sep.len());
        }
    }
    lower[cut..]
        .split_whitespace()
        .rev()
        .take(NEGATION_WORDS)
        .any(|w| {
            let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'');
            NEGATIONS.contains(&w)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(message: &str) -> Vec<Claim> {
        Claims::builtin().extract(message)
    }
    fn kinds(message: &str) -> Vec<ClaimType> {
        extract(message).into_iter().map(|c| c.kind).collect()
    }
    fn subject(message: &str, kind: ClaimType) -> Option<String> {
        extract(message)
            .into_iter()
            .find(|c| c.kind == kind)
            .and_then(|c| c.subject)
    }

    #[test]
    fn the_embedded_patterns_compile() {
        assert!(
            Claims::builtin().rules.len() >= 8,
            "every §35.5 T5 claim type needs at least one pattern"
        );
    }

    #[test]
    fn a_broken_claims_file_is_an_error_not_a_panic() {
        assert!(Claims::parse("[[claim]]\ntype = \"nope\"\npattern = 'x'").is_err());
        assert!(Claims::parse("[[claim]]\ntype = \"tests_pass\"\npattern = '('").is_err());
        assert!(
            Claims::parse("[[claim]]\ntype = \"created\"\nsubject = \"file\"\npattern = 'x'").is_err(),
            "a subject with no (?<subj>) group would silently never match"
        );
        assert!(Claims::parse("").is_ok(), "an empty override file is legal");
    }

    #[test]
    fn finds_the_plain_claims() {
        assert_eq!(kinds("All tests pass now."), vec![ClaimType::TestsPass]);
        assert_eq!(kinds("The test passes."), vec![ClaimType::TestsPass]);
        assert_eq!(kinds("The tests are green."), vec![ClaimType::TestsPass]);
        assert_eq!(kinds("2 tests still fail."), vec![ClaimType::TestsFail]);
        assert_eq!(kinds("The build succeeds."), vec![ClaimType::BuildOk]);
    }

    #[test]
    fn finds_subjects() {
        assert_eq!(
            subject("I didn't touch db/schema.sql.", ClaimType::Untouched).as_deref(),
            Some("db/schema.sql")
        );
        assert_eq!(
            subject("I haven't modified `db/`.", ClaimType::Untouched).as_deref(),
            Some("db/")
        );
        // The bare-name wording becomes a folder, so T6 compares it as a prefix.
        assert_eq!(
            subject("I didn't touch the db folder.", ClaimType::Untouched).as_deref(),
            Some("db/")
        );
        assert_eq!(
            subject("No changes to the config directory.", ClaimType::NoChanges).as_deref(),
            Some("config/")
        );
        assert_eq!(
            subject("No changes to api/routes.ts.", ClaimType::NoChanges).as_deref(),
            Some("api/routes.ts")
        );
        assert_eq!(
            subject("Created a new file src/date.ts.", ClaimType::Created).as_deref(),
            Some("src/date.ts")
        );
        assert_eq!(
            subject("Deleted old/notes.md.", ClaimType::Deleted).as_deref(),
            Some("old/notes.md")
        );
        assert_eq!(
            subject("Sent the email to sarah@example.com.", ClaimType::EmailSent).as_deref(),
            Some("sarah@example.com")
        );
    }

    #[test]
    fn a_subject_that_is_not_a_path_drops_the_claim() {
        // "the database" is prose. Reading it as a path would have us check a file nobody named.
        assert!(extract("I didn't touch the database.").is_empty());
        // §35.5 T5: a Created subject needs an extension, so this is not a file claim.
        assert!(extract("I added a test for it.").is_empty());
        assert!(extract("I removed the duplication.").is_empty());
    }

    #[test]
    fn negations_are_ignored() {
        // The spec's own example. The pattern needs `tests <pass>`; "don't" sits between them, so it never
        // matches - and the word check below catches the forms that do match.
        assert!(extract("The tests don't pass yet.").is_empty());
        assert!(extract("Not all tests pass yet.").is_empty());
        assert!(extract("I haven't checked that the tests pass.").is_empty());
        assert!(extract("I can't say the build succeeds.").is_empty());
        assert!(extract("I'm unsure whether the tests pass.").is_empty());
    }

    #[test]
    fn a_negation_in_an_earlier_statement_is_not_borrowed() {
        // The dangerous false negative: a true claim sitting after an unrelated "no".
        assert!(kinds("No changes to db/ and all tests pass.").contains(&ClaimType::TestsPass));
        assert!(kinds("The build does not matter here, but the tests pass.").contains(&ClaimType::TestsPass));
        assert!(
            kinds("I didn't touch db/schema.sql. All tests pass.").contains(&ClaimType::TestsPass),
            "a new sentence starts a new statement"
        );
    }

    #[test]
    fn fenced_code_blocks_are_skipped() {
        let message = "Here is the run:\n\n```\n$ npm test\nTests: 2 failed, 3 passed\nall tests pass\n```\n\nI will look at it next.";
        assert!(
            extract(message).is_empty(),
            "a pasted log is not a claim: {:?}",
            extract(message)
        );
    }

    #[test]
    fn a_claim_outside_a_fence_still_counts() {
        let message = "```\nsome log\n```\nAll tests pass.";
        assert_eq!(kinds(message), vec![ClaimType::TestsPass]);
    }

    #[test]
    fn tilde_fences_and_an_unclosed_fence_are_skipped() {
        assert!(extract("~~~\nall tests pass\n~~~").is_empty());
        assert!(
            extract("Log follows:\n```\nall tests pass").is_empty(),
            "an unclosed fence means we cannot tell prose from output"
        );
    }

    #[test]
    fn quoted_text_is_skipped() {
        assert!(
            extract("You asked me to \"make sure all tests pass\" before stopping.").is_empty(),
            "repeating the brief is not a claim"
        );
        assert!(
            extract("> Tests: all tests pass\nI am still working on it.").is_empty(),
            "a blockquote is the user's words or a log"
        );
    }

    #[test]
    fn inline_code_is_kept_because_real_claims_use_it() {
        assert_eq!(kinds("`npm test`: all tests pass."), vec![ClaimType::TestsPass]);
        assert_eq!(
            subject("I didn't touch `db/migrations/`.", ClaimType::Untouched).as_deref(),
            Some("db/migrations/")
        );
    }

    #[test]
    fn at_most_ten_claims_are_kept() {
        let mut message = String::from("All tests pass. The build succeeds. ");
        for i in 0..40 {
            message.push_str(&format!("Created src/file{i}.ts. "));
        }
        let claims = extract(&message);
        assert_eq!(claims.len(), MAX_CLAIMS);
        // Pattern order is priority, so the claims that can warn about a red test run survive the cap.
        assert_eq!(claims[0].kind, ClaimType::TestsPass);
        assert_eq!(claims[1].kind, ClaimType::BuildOk);
    }

    #[test]
    fn the_same_claim_twice_is_one_claim() {
        let claims = extract("All tests pass. The tests pass. Tests are green.");
        assert_eq!(claims.len(), 1, "{claims:?}");
    }

    #[test]
    fn several_claims_in_one_message() {
        let kinds = kinds(
            "I created src/date.ts, deleted old/date.js, didn't touch db/ and all tests pass. \
             I sent the email to sarah@example.com.",
        );
        for expected in [
            ClaimType::TestsPass,
            ClaimType::Untouched,
            ClaimType::Created,
            ClaimType::Deleted,
            ClaimType::EmailSent,
        ] {
            assert!(kinds.contains(&expected), "{expected:?} missing from {kinds:?}");
        }
    }

    #[test]
    fn clauses_do_not_split_paths_or_durations() {
        let c = clauses("Created src/a.ts in 1.5s. Done.");
        assert_eq!(c.len(), 2, "{c:?}");
        assert!(c[0].contains("src/a.ts"), "{c:?}");
    }

    #[test]
    fn extraction_is_fast_enough_for_the_stop_hook() {
        // §35.2: claim extraction is budgeted under 5 ms. Generous, and deliberately so: docs/known-issues.md
        // records that a tight timing assert flakes on a freshly built test binary's first run, where the time
        // is the thread waiting to be scheduled rather than the work.
        let message = "All tests pass. ".repeat(200);
        let start = std::time::Instant::now();
        let claims = extract(&message);
        assert_eq!(claims.len(), 1);
        assert!(
            start.elapsed() < std::time::Duration::from_millis(10),
            "claim extraction took {:?}",
            start.elapsed()
        );
    }
}
