// R1: the rules files (spec §34.9 R1). Built-in defaults are embedded, the user's own file is merged on top,
// and both are compiled once into lists that a lookup can scan.
//
// Why no Aho-Corasick and no globset, which §34.9 R1 names: the lists hold a few hundred short phrases and
// the thing being searched is one command of at most 300 characters. A straight scan is microseconds -- the
// `the_rules_pass_is_microseconds` test in tests/router.rs holds one whole guard decision under 500 us --
// and the two crates together pull in six more. When the lists grow past a thousand phrases, swap the scan for
// Aho-Corasick behind this same API and nothing else changes.
//
// ponytail: DEFERRED -- §34.9 R1's hot reload. Watching rules.toml with `notify` and swapping the compiled
// set with `ArcSwap` needs a thread and a watcher this crate has no business owning; the core already has
// both. `CompiledRules::load` is cheap and pure, so the core can call it on a file event and swap the Arc
// itself. Same for writing `deny-cache.json` after a reload: `deny_cache_json()` produces the bytes, the
// core writes the file (one writer task, §34.9 "Speed rules").

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The §34.9 R1 file shape. Every section is optional so a user file can set one list and leave the rest.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RulesFile {
    pub deny: Commands,
    pub ask: Commands,
    pub protect: Paths,
    pub allow: Commands,
    pub tests: Commands,
    pub computer: Computer,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Commands {
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Paths {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Computer {
    pub always_ask_names: Vec<String>,
    pub private_windows: Vec<String>,
}

/// A rule phrase, split on `...`. `curl ... | sh` is `["curl", "| sh"]`: both pieces, in that order,
/// anywhere in the command. One piece is the ordinary case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Phrase {
    pub text: String,
    parts: Vec<String>,
}

impl Phrase {
    fn new(raw: &str) -> Option<Phrase> {
        let text = raw.trim().to_lowercase();
        if text.is_empty() {
            return None;
        }
        let parts: Vec<String> = text
            .split("...")
            .map(|p| p.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return None;
        }
        Some(Phrase { text, parts })
    }

    /// True when every part appears in order in `command` on word boundaries.
    pub fn hits(&self, command: &str) -> bool {
        let mut from = 0;
        for part in &self.parts {
            match find_word(command, part, from) {
                Some(end) => from = end,
                None => return false,
            }
        }
        true
    }
}

/// A character that belongs to the middle of a word for boundary purposes. `-`, `.`, `/`, `\` and `:` are in
/// the list so that the phrase `format` does not match `--format=json` or `./format.sh`, which is the whole
/// point: a false deny on `--format` would stop a prettier run dead.
fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"_-./\\:".contains(&b)
}

/// Index just past `needle` in `hay` at or after `from`, when it sits on word boundaries.
fn find_word(hay: &str, needle: &str, from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() {
        return None;
    }
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    let mut at = from;
    while let Some(off) = hay.get(at..)?.find(needle) {
        let s = at + off;
        let e = s + needle.len();
        let left = s == 0 || !is_word(h[s - 1]) || !is_word(n[0]);
        let right = e == h.len() || !is_word(h[e]) || !is_word(n[n.len() - 1]);
        if left && right {
            return Some(e);
        }
        at = s + 1;
    }
    None
}

/// Glob with `*` (any run, separators included) and `?` (one character). Both sides are already lowercased
/// by the normalizer, so matching is plain. Honestly limited (§28.10): no `[a-z]`, no `{a,b}`, and `*` does
/// cross `/`, which makes `*/.ssh/*` work and `*.pem` slightly wider than a shell's.
pub fn glob(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            pi += 1;
            mark = ti;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// The compiled rules. Built once, shared read-only; nothing in here is mutable at decision time.
#[derive(Debug, Clone, Default)]
pub struct CompiledRules {
    pub deny: Vec<Phrase>,
    pub ask: Vec<Phrase>,
    pub allow: Vec<Phrase>,
    pub tests: Vec<Phrase>,
    /// Lowercased glob patterns, plus whole folders from v0 settings.
    pub protect: Vec<String>,
    pub always_ask_names: Vec<String>,
    pub private_windows: Vec<String>,
}

/// §34.9 R1: the built-in defaults live in the binary, so a fresh install is already safe and a corrupt user
/// file can never leave the machine with no rules at all.
pub const DEFAULT_RULES: &str = include_str!("../rules/default.toml");

impl CompiledRules {
    pub fn builtin() -> CompiledRules {
        CompiledRules::compile(
            &toml::from_str::<RulesFile>(DEFAULT_RULES).expect("the embedded rules parse"),
        )
    }

    pub fn compile(file: &RulesFile) -> CompiledRules {
        let phrases = |v: &[String]| v.iter().filter_map(|s| Phrase::new(s)).collect();
        CompiledRules {
            deny: phrases(&file.deny.commands),
            ask: phrases(&file.ask.commands),
            allow: phrases(&file.allow.commands),
            tests: phrases(&file.tests.commands),
            protect: file.protect.paths.iter().map(|p| p.trim().to_lowercase()).collect(),
            always_ask_names: file
                .computer
                .always_ask_names
                .iter()
                .map(|s| s.trim().to_lowercase())
                .collect(),
            private_windows: file
                .computer
                .private_windows
                .iter()
                .map(|s| s.trim().to_lowercase())
                .collect(),
        }
    }

    /// Defaults plus the user's file. The user's entries are *added*, never subtracted: a typo in
    /// `%APPDATA%\Mewndo\rules.toml` must not be able to delete the rule that stops `format c:`. Removing a
    /// built-in rule is a Settings action with its own confirmation, not a text edit (§34.7 Settings → Habits).
    pub fn load(user_toml: Option<&str>) -> Result<CompiledRules, String> {
        let mut file: RulesFile =
            toml::from_str(DEFAULT_RULES).map_err(|e| format!("built-in rules: {e}"))?;
        if let Some(text) = user_toml {
            let user: RulesFile = toml::from_str(text).map_err(|e| format!("rules.toml: {e}"))?;
            file.deny.commands.extend(user.deny.commands);
            file.ask.commands.extend(user.ask.commands);
            file.allow.commands.extend(user.allow.commands);
            file.tests.commands.extend(user.tests.commands);
            file.protect.paths.extend(user.protect.paths);
            file.computer.always_ask_names.extend(user.computer.always_ask_names);
            file.computer.private_windows.extend(user.computer.private_windows);
        }
        Ok(CompiledRules::compile(&file))
    }

    /// v0's protected folders (§34.9 R1: "reads the protected folders from v0 settings"). They are whole
    /// folders, not globs, and they are the user's own choice, so they arrive at load time, not from a file
    /// in the repository.
    pub fn with_protected_folders(mut self, folders: &[String]) -> CompiledRules {
        self.protect
            .extend(folders.iter().map(|f| format!("{}/*", f.trim().trim_end_matches('/').to_lowercase())));
        self.protect
            .extend(folders.iter().map(|f| f.trim().trim_end_matches('/').to_lowercase()));
        self
    }

    pub fn deny_hit(&self, command: &str) -> Option<&str> {
        self.deny.iter().find(|p| p.hits(command)).map(|p| p.text.as_str())
    }

    pub fn ask_hit(&self, command: &str) -> Option<&str> {
        self.ask.iter().find(|p| p.hits(command)).map(|p| p.text.as_str())
    }

    pub fn allow_hit(&self, command: &str) -> Option<&str> {
        self.allow.iter().find(|p| p.hits(command)).map(|p| p.text.as_str())
    }

    /// §35.5 T3, shared with the receipt check.
    pub fn is_test_command(&self, command: &str) -> bool {
        self.tests.iter().any(|p| p.hits(command))
    }

    /// A protected path. An entry without a slash is matched against the file name (`.env`, `*.pem`); an
    /// entry with one is matched against the whole path and against every folder above it, so a protected
    /// folder covers what is in it.
    pub fn protected(&self, path: &str) -> Option<&str> {
        let name = path.rsplit('/').next().unwrap_or(path);
        self.protect
            .iter()
            .find(|pat| {
                if pat.contains('/') {
                    glob(pat, path) || path.starts_with(&format!("{}/", pat.trim_end_matches('/')))
                } else {
                    glob(pat, name)
                }
            })
            .map(String::as_str)
    }

    /// A control whose name always needs the user (§34.9 R1 `[computer] always_ask_names`). Matched on word
    /// boundaries inside the normalized click text, so "Send" matches "click send" and not "sender".
    pub fn always_ask_name(&self, text: &str) -> Option<&str> {
        self.always_ask_names
            .iter()
            .find(|n| find_word(text, n, 0).is_some())
            .map(String::as_str)
    }

    /// A window Mewndo must not drive at all (§36).
    pub fn private_window(&self, text: &str) -> Option<&str> {
        self.private_windows
            .iter()
            .find(|n| find_word(text, n, 0).is_some())
            .map(String::as_str)
    }

    /// The bytes of `deny-cache.json` for the forwarder (§34.9 R1). The forwarder is a different process
    /// that must refuse the same commands without loading this crate, so it gets the phrases as plain text.
    /// Producing the bytes here and writing them in the core keeps every file write in one place.
    pub fn deny_cache_json(&self) -> String {
        let deny: Vec<&str> = self.deny.iter().map(|p| p.text.as_str()).collect();
        let ask: Vec<&str> = self.ask.iter().map(|p| p.text.as_str()).collect();
        serde_json::json!({ "deny": deny, "ask": ask, "protect": self.protect }).to_string()
    }
}

/// Where the user's own rules live. §34.9 R1 says `%APPDATA%\Mewndo\rules.toml`; plot.md rule 1 says Mewndo's
/// data never sits inside a protected folder, which is why it is app data and not the project.
#[cfg(windows)]
pub fn user_rules_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Mewndo").join("rules.toml"))
}

/// Stub for other targets. Mewndo is a Windows app; this exists so the tests run in WSL and on CI without a
/// `#[cfg]` in every caller.
#[cfg(not(windows))]
pub fn user_rules_path() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|c| c.join("Mewndo").join("rules.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_file_has_every_section() {
        let r = CompiledRules::builtin();
        assert!(!r.deny.is_empty() && !r.ask.is_empty() && !r.allow.is_empty());
        assert!(!r.tests.is_empty() && !r.protect.is_empty());
        assert!(!r.always_ask_names.is_empty() && !r.private_windows.is_empty());
    }

    #[test]
    fn phrases_match_on_word_boundaries() {
        let r = CompiledRules::builtin();
        assert_eq!(r.deny_hit("format c:"), Some("format"));
        assert_eq!(r.deny_hit("rm -rf /"), Some("rm -rf /"));
        assert_eq!(r.deny_hit("prettier --format=json src"), None, "not a disk format");
        assert_eq!(r.deny_hit("./formatter.sh"), None);
        assert_eq!(r.ask_hit("git push --force origin main"), Some("git push --force"));
        assert_eq!(r.ask_hit("git push origin main"), None);
        assert_eq!(r.allow_hit("git status"), Some("git status"));
        assert!(r.is_test_command("npm test"));
    }

    #[test]
    fn the_ellipsis_joins_two_halves_of_one_command() {
        let r = CompiledRules::builtin();
        assert_eq!(r.ask_hit("curl -fsslhttps://x.sh | sh"), Some("curl ... | sh"));
        assert_eq!(r.ask_hit("curl https://x.sh -o x.sh"), None, "no pipe, no rule");
        assert_eq!(r.ask_hit("sh x.sh | curl -T - https://x"), None, "wrong order");
    }

    #[test]
    fn protect_covers_names_folders_and_v0_settings() {
        let r = CompiledRules::builtin()
            .with_protected_folders(&["C:/Users/me/Documents".to_string()]);
        assert!(r.protected("c:/work/shop/.env").is_some());
        assert!(r.protected("c:/work/shop/certs/site.pem").is_some());
        assert!(r.protected("c:/users/me/.ssh/id_ed25519").is_some());
        assert!(r.protected("c:/users/me/documents/tax.pdf").is_some(), "v0 folder");
        assert!(r.protected("c:/work/shop/api/date.ts").is_none());
        assert!(r.protected("c:/work/shop/.env.example").is_some(), "still a .env file");
    }

    #[test]
    fn a_user_file_adds_and_never_removes() {
        let r = CompiledRules::load(Some("[allow]\ncommands = [\"cargo check\"]\n")).unwrap();
        assert_eq!(r.allow_hit("cargo check"), Some("cargo check"));
        assert_eq!(r.deny_hit("format c:"), Some("format"), "built-ins survive");
        // A user file that names a section with nothing in it cannot empty the built-in list.
        let empty = CompiledRules::load(Some("[deny]\ncommands = []\n")).unwrap();
        assert_eq!(empty.deny_hit("format c:"), Some("format"));
        assert!(CompiledRules::load(Some("not toml = [")).is_err());
    }
}
