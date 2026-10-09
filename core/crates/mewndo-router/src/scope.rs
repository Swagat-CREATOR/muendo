// R3: what the brief lets the agent touch (spec §34.9 R3).
//
// The brief is English, not a config file, so this is a best-effort read of a few phrases people actually
// write: "don't touch the db folder", "do not modify config/", "only in api/". It is deliberately small and
// deliberately conservative: a phrase it does not understand leaves the scope at its default, which is the
// cwd subtree, and the result of a *wrong* guess is an extra question in the Inbox, never a silent allow.
//
// What it cannot do, honestly (§28.10): no negation beyond those phrases, no "except", no glob patterns, no
// understanding of "the tests" or "the database" as anything but words. The model is asked `in_scope` on
// every action precisely because this function is not clever (§34.3).

use crate::normalize::{inside, norm_path};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The folders the brief covers. Both lists hold normalized paths (see [`norm_path`]), so a comparison here
/// is a string comparison. Stored on the trace (§34.9 R3) so a decision can be explained later.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Scope {
    /// Where work may happen. Defaults to the cwd subtree.
    pub allowed: Vec<String>,
    /// Named in the brief as off limits. Checked first: "only in api/, don't touch api/secrets" means both.
    pub forbidden: Vec<String>,
}

/// Phrases that close a folder off. Longest first, so "do not modify" is not read as "do not".
const FORBID: [&str; 10] = [
    "don't touch",
    "dont touch",
    "do not touch",
    "don't modify",
    "dont modify",
    "do not modify",
    "don't change",
    "do not change",
    "never touch",
    "stay out of",
];

/// Phrases that narrow the scope to exactly what follows.
const ONLY: [&str; 6] = [
    "only in",
    "only inside",
    "only touch",
    "work only in",
    "only edit",
    "only under",
];

impl Scope {
    /// The default scope: the cwd subtree (§34.9 R3). An empty brief does not mean "anywhere".
    pub fn cwd(cwd: &Path) -> Scope {
        Scope {
            allowed: vec![norm_path(".", cwd)],
            forbidden: Vec::new(),
        }
    }

    pub fn from_brief(brief: &str, cwd: &Path) -> Scope {
        let lower = brief.to_lowercase();
        let mut scope = Scope::cwd(cwd);
        let mut only: Vec<String> = Vec::new();
        for phrase in FORBID {
            for tail in tails(&lower, phrase) {
                scope
                    .forbidden
                    .extend(path_tokens(tail).iter().map(|t| norm_path(t, cwd)));
            }
        }
        for phrase in ONLY {
            for tail in tails(&lower, phrase) {
                only.extend(path_tokens(tail).iter().map(|t| norm_path(t, cwd)));
            }
        }
        // "only in api/" replaces the default rather than adding to it: that is the whole point of the word
        // "only". If no "only" phrase named anything we could resolve, the cwd subtree stands.
        if !only.is_empty() {
            scope.allowed = only;
        }
        scope.forbidden.sort();
        scope.forbidden.dedup();
        scope.allowed.sort();
        scope.allowed.dedup();
        scope
    }

    /// True when `path` is somewhere the brief does not cover. Forbidden wins over allowed, because a brief
    /// that says both is a brief that means "not there".
    pub fn outside(&self, path: &str) -> bool {
        if self.forbidden.iter().any(|f| inside(path, f)) {
            return true;
        }
        !self.allowed.is_empty() && !self.allowed.iter().any(|a| inside(path, a))
    }
}

/// Every piece of text that follows `phrase`, cut at the end of its clause. One brief can say "don't touch"
/// twice.
fn tails<'a>(haystack: &'a str, phrase: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = haystack[from..].find(phrase) {
        let start = from + at + phrase.len();
        let end = haystack[start..]
            .find(['.', ';', '\n', '!', '?'])
            .map(|e| start + e)
            .unwrap_or(haystack.len());
        out.push(&haystack[start..end]);
        from = start.max(from + at + 1);
    }
    out
}

/// Words in a clause that could be a folder. "the db folder" -> "db"; "config/ and src/" -> both.
/// Filler words are dropped rather than guessed at, because a scope entry of "the" would forbid nothing and
/// an allowed entry of "the" would forbid everything.
fn path_tokens(clause: &str) -> Vec<String> {
    const FILLER: [&str; 14] = [
        "the", "a", "an", "any", "my", "our", "folder", "folders", "directory", "directories", "dir", "and",
        "or", "files",
    ];
    let mut out = Vec::new();
    for raw in clause.split(|c: char| c.is_whitespace() || c == ',' || c == '`' || c == '"') {
        let w = raw.trim_matches(|c: char| "'()[]:".contains(c));
        let w = w.strip_suffix('.').unwrap_or(w);
        if w.is_empty() || FILLER.contains(&w) {
            continue;
        }
        // A word that is plainly prose ("needed", "anything") is still accepted when it is the only thing
        // there: a folder really can be called `anything`. What is rejected is punctuation and numbers.
        if w.chars().any(|c| c.is_alphanumeric()) {
            out.push(w.to_string());
        }
        // Only the first run of words is a path; "don't touch db because it is shared" must not forbid
        // `because`. Stop at the first word that is clearly prose glue.
        if out.len() >= 3 {
            break;
        }
    }
    // "don't touch db because ..." -> keep "db". The heuristic: stop at the first stop-word after a token.
    const STOP: [&str; 12] = [
        "because", "since", "unless", "it", "they", "that", "which", "when", "but", "so", "under", "without",
    ];
    if let Some(cut) = out.iter().position(|w| STOP.contains(&w.as_str())) {
        out.truncate(cut);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cwd() -> PathBuf {
        PathBuf::from("C:/work/shop")
    }

    #[test]
    fn the_default_scope_is_the_cwd_subtree() {
        let s = Scope::from_brief("Fix the failing date tests.", &cwd());
        assert_eq!(s.allowed, vec!["c:/work/shop".to_string()]);
        assert!(!s.outside("c:/work/shop/api/date.ts"));
        assert!(s.outside("c:/work/other/x.ts"));
    }

    #[test]
    fn reads_dont_touch_and_only_in() {
        // The §34.3 example brief, word for word.
        let s = Scope::from_brief(
            "Fix the failing date tests in api/. Don't touch the db folder.",
            &cwd(),
        );
        assert_eq!(s.forbidden, vec!["c:/work/shop/db".to_string()]);
        assert!(s.outside("c:/work/shop/db/migrations"));
        assert!(!s.outside("c:/work/shop/api/date.ts"));

        let only = Scope::from_brief("Work only in api/. Do not modify config/.", &cwd());
        assert_eq!(only.allowed, vec!["c:/work/shop/api".to_string()]);
        assert!(only.outside("c:/work/shop/src/x.ts"), "outside the only-in folder");
        assert!(only.outside("c:/work/shop/config/a.json"));
        assert!(!only.outside("c:/work/shop/api/date.ts"));
    }

    #[test]
    fn forbidden_wins_over_allowed() {
        let s = Scope::from_brief("Only in src. Don't touch src/vendor.", &cwd());
        assert!(!s.outside("c:/work/shop/src/a.ts"));
        assert!(s.outside("c:/work/shop/src/vendor/lib.js"));
    }
}
