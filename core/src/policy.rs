// Policy engine (spec §24.1): turns a brief's scope and rules into checks, and judges an agent's planned action
// before it runs: allow, deny or ask, with a short reason the agent can read. Rules only: deterministic, well
// under 5 ms. (What rules can't decide goes to the decision model later, Phase 4.)
//
// Checked in this order; the first that applies decides:
//   1. Secrets: reading or writing .env files, keys, SSH folders, browser profiles, password stores    deny
//   2. Writes and deletes outside the brief's folders                                                  deny
//   3. Recursive or wildcard deletes, git reset --hard, git clean, force-push                          ask
//      (allow if the brief says so)
//   4. Deleting a file the brief doesn't name                                                          deny
//      (allow if the brief allows deletes)
//   5. Bursts: more than N deletes or M changes in 60 s in one session (v0's thresholds)               deny
//   otherwise                                                                                          allow
// Shell commands are read for what they do: a delete command is a delete of each path it names.
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A brief's scope and rules (spec §6A), as the app sends it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Brief {
    /// Folders the agent may change.
    pub roots: Vec<PathBuf>,
    /// Files the brief names (absolute, or relative to the first root). Only these may be deleted.
    pub files: Vec<String>,
    /// The brief's text (task and rules); file names in it count as named too.
    pub text: String,
    /// The brief allows deleting files it doesn't name.
    pub allow_deletes: bool,
    /// The brief allows recursive or wildcard deletes, hard resets, git clean and force-pushes.
    pub allow_destructive: bool,
    /// Burst thresholds; v0's defaults when 0.
    pub max_deletes: usize,
    pub max_changes: usize,
}

/// An action an agent is about to take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Read {
        path: PathBuf,
    },
    Write {
        path: PathBuf,
    },
    Delete {
        path: PathBuf,
    },
    /// A shell command, run in `cwd`.
    Shell {
        command: String,
        cwd: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub decision: Decision,
    /// Which rule decided: secret, outside_scope, destructive, unnamed_delete, burst, or none.
    pub rule: String,
    /// For the agent: why, and what to do instead.
    pub reason: String,
    /// How many files it deletes (an allowed delete gets a save point first).
    pub deletes: usize,
}

fn verdict(decision: Decision, rule: &str, reason: impl Into<String>) -> Verdict {
    Verdict {
        decision,
        rule: rule.to_string(),
        reason: reason.into(),
        deletes: 0,
    }
}

const DEFAULT_MAX_DELETES: usize = 50;
const DEFAULT_MAX_CHANGES: usize = 300;
const BURST_WINDOW: Duration = Duration::from_secs(60);

/// Lowercased on Windows, '/'-separated, . and .. resolved as text.
fn norm(p: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prefix = String::new();
    for c in p.components() {
        match c {
            Component::Prefix(x) => prefix = x.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => {}
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(n) => parts.push(n.to_string_lossy().into_owned()),
        }
    }
    let s = format!("{prefix}/{}", parts.join("/")).replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn inside(path: &str, root: &str) -> bool {
    path == root
        || path.strip_prefix(root).is_some_and(|r| r.starts_with('/'))
        || root.ends_with('/') && path.starts_with(root)
}

/// .env files, keys, SSH folders, cloud credentials, browser profiles and password stores.
fn secret(path: &str) -> Option<&'static str> {
    let path = path.to_lowercase();
    let name = path.rsplit('/').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').collect();
    if name == ".env"
        || name.starts_with(".env.") && !name.ends_with(".example") && !name.ends_with(".sample")
    {
        return Some("an environment file with secrets");
    }
    if [
        "id_rsa",
        "id_dsa",
        "id_ecdsa",
        "id_ed25519",
        ".netrc",
        ".pgpass",
        ".git-credentials",
        "credentials",
    ]
    .contains(&name)
        || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".kdbx",
            ".keychain",
            ".keychain-db",
        ]
        .iter()
        .any(|e| name.ends_with(e))
    {
        return Some("a key or credentials file");
    }
    if parts.iter().any(|p| {
        [
            ".ssh",
            ".gnupg",
            ".aws",
            ".azure",
            ".password-store",
            "1password",
        ]
        .contains(p)
    }) {
        return Some("a folder of keys or passwords");
    }
    let profiles = [
        "/google/chrome/user data",
        "/microsoft/edge/user data",
        "/bravesoftware/brave-browser/user data",
        "/mozilla/firefox/profiles",
        "/.mozilla/firefox",
        "/.config/google-chrome",
        "/library/application support/google/chrome",
    ];
    if profiles.iter().any(|p| path.contains(p)) {
        return Some("a browser profile (saved passwords and cookies)");
    }
    None
}

/// Split a command line into words, keeping quoted parts together. Good enough for judging, not for running.
fn words(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() || c == ';' || c == '&' || c == '|' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                if c != ' ' && c != '\t' {
                    out.push(c.to_string()); // separators end a command
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// What one shell command does that the rules care about.
#[derive(Debug, Default, PartialEq)]
struct ShellEffect {
    destructive: Option<&'static str>,
    deletes: Vec<String>,
    writes: Vec<String>,
    reads: Vec<String>,
}

fn shell_effect(command: &str) -> ShellEffect {
    let mut effect = ShellEffect::default();
    let all = words(command);
    for cmd in all.split(|w| [";", "&", "|"].contains(&w.as_str())) {
        let Some(program) = cmd.first() else { continue };
        let program = program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(program)
            .to_lowercase();
        let program = program.trim_end_matches(".exe");
        let args: Vec<&str> = cmd[1..].iter().map(String::as_str).collect();
        let flags: Vec<String> = args
            .iter()
            .filter(|a| a.starts_with('-') || a.starts_with('/'))
            .map(|a| a.to_lowercase())
            .collect();
        let paths = || {
            args.iter()
                .filter(|a| !a.starts_with('-') && !(a.starts_with('/') && a.len() <= 3))
                .map(|a| a.to_string())
        };
        // -r, -R, -rf, -fr, --recursive, /s, -Recurse (flags are lowercased)
        let recursive = flags.iter().any(|f| {
            ["--recursive", "/s", "-recurse"].contains(&f.as_str())
                || (f.len() <= 4
                    && f.starts_with('-')
                    && !f.starts_with("--")
                    && f[1..].chars().all(|c| c.is_ascii_alphabetic())
                    && f.contains('r'))
        });
        let wildcard = args
            .iter()
            .any(|a| !a.starts_with('-') && (a.contains('*') || a.contains('?')));
        match program {
            "rm" | "rmdir" | "del" | "erase" | "rd" | "remove-item" | "ri" | "unlink" | "shred" => {
                if recursive {
                    effect.destructive = Some("a recursive delete");
                } else if wildcard {
                    effect.destructive = Some("a wildcard delete");
                }
                effect.deletes.extend(paths());
            }
            "git" => {
                let sub = args.first().map(|s| s.to_lowercase()).unwrap_or_default();
                match sub.as_str() {
                    "reset" if flags.iter().any(|f| f == "--hard") => {
                        effect.destructive = Some("git reset --hard")
                    }
                    "clean" if !flags.iter().any(|f| f == "-n" || f == "--dry-run") => {
                        effect.destructive = Some("git clean")
                    }
                    "push"
                        if flags.iter().any(|f| f == "-f" || f.starts_with("--force"))
                            || args.iter().any(|a| a.starts_with('+')) =>
                    {
                        effect.destructive = Some("a force-push")
                    }
                    "checkout" | "restore" if args.contains(&".") => {
                        effect.destructive = Some("discarding every uncommitted change")
                    }
                    _ => {}
                }
            }
            "cat" | "type" | "get-content" | "gc" | "less" | "more" | "head" | "tail" | "cp"
            | "copy" | "scp" => {
                effect.reads.extend(paths());
            }
            "mv" | "move" | "move-item" | "ren" | "rename" => effect
                .deletes
                .extend(paths().take(args.len().saturating_sub(1))),
            "touch" | "tee" | "set-content" | "out-file" => effect.writes.extend(paths()),
            _ => {}
        }
        // Redirection: `> file` writes it.
        for (i, w) in cmd.iter().enumerate() {
            if (w == ">" || w == ">>")
                && let Some(t) = cmd.get(i + 1)
            {
                effect.writes.push(t.clone());
            } else if let Some(t) = w
                .strip_prefix(">>")
                .or_else(|| w.strip_prefix('>'))
                .filter(|t| !t.is_empty())
            {
                effect.writes.push(t.to_string());
            }
        }
    }
    effect
}

/// One agent session's policy and recent activity (for bursts).
pub struct Session {
    brief: Brief,
    roots: Vec<String>,
    named: Vec<String>,
    /// A brief with nothing in it (no folders, files or text) can't say what's unnamed.
    empty: bool,
    deletes: VecDeque<Instant>,
    changes: VecDeque<Instant>,
}

impl Session {
    pub fn new(brief: Brief) -> Session {
        let roots: Vec<String> = brief.roots.iter().map(|r| norm(r)).collect();
        let base = brief.roots.first().cloned().unwrap_or_default();
        let mut named: Vec<String> = brief.files.iter().map(|f| norm(&base.join(f))).collect();
        // File names the brief's text mentions ("delete old/notes.md") count as named.
        for w in brief
            .text
            .split(|c: char| c.is_whitespace() || "`'\",;()".contains(c))
        {
            let w = w.trim_end_matches(['.', ':']);
            if w.contains('.') && w.len() > 2 && !w.starts_with("http") {
                named.push(norm(&base.join(w)));
            }
        }
        let empty =
            brief.roots.is_empty() && brief.files.is_empty() && brief.text.trim().is_empty();
        Session {
            brief,
            roots,
            named,
            empty,
            deletes: VecDeque::new(),
            changes: VecDeque::new(),
        }
    }

    fn abs(&self, p: &Path, cwd: Option<&Path>) -> String {
        let base = cwd
            .map(Path::to_path_buf)
            .or_else(|| self.brief.roots.first().cloned())
            .unwrap_or_default();
        norm(&base.join(p))
    }

    fn in_scope(&self, p: &str) -> bool {
        self.roots.iter().any(|r| inside(p, r))
    }

    /// Judge one action. `now` is when it happens (bursts count the last 60 s).
    pub fn check(&mut self, action: &Action, now: Instant) -> Verdict {
        let (reads, writes, deletes, destructive, cwd) = match action {
            Action::Read { path } => (vec![self.abs(path, None)], vec![], vec![], None, None),
            Action::Write { path } => (vec![], vec![self.abs(path, None)], vec![], None, None),
            Action::Delete { path } => (vec![], vec![], vec![self.abs(path, None)], None, None),
            Action::Shell { command, cwd } => {
                let e = shell_effect(command);
                let at = |v: Vec<String>| {
                    v.iter()
                        .map(|p| self.abs(Path::new(p), cwd.as_deref()))
                        .collect::<Vec<_>>()
                };
                (
                    at(e.reads),
                    at(e.writes),
                    at(e.deletes),
                    e.destructive,
                    cwd.clone(),
                )
            }
        };
        let _ = cwd;
        for p in reads.iter().chain(&writes).chain(&deletes) {
            if let Some(what) = secret(p) {
                return verdict(
                    Decision::Deny,
                    "secret",
                    format!(
                        "{p} is {what}. Mewndo never lets agents read or change secrets. Ask the user to do it, or to give you only what the task needs."
                    ),
                );
            }
        }
        if !self.roots.is_empty()
            && let Some(p) = writes.iter().chain(&deletes).find(|p| !self.in_scope(p))
        {
            return verdict(
                Decision::Deny,
                "outside_scope",
                format!(
                    "{p} is outside the folders your brief covers ({}). Work only inside them, or ask the user to widen the brief.",
                    self.brief
                        .roots
                        .iter()
                        .map(|r| r.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
        }
        if let Some(what) = destructive
            && !self.brief.allow_destructive
        {
            return verdict(
                Decision::Ask,
                "destructive",
                format!(
                    "This is {what}, which can remove work that can't be recovered from git. The brief doesn't allow it: the user must confirm."
                ),
            );
        }
        if !self.brief.allow_deletes
            && !self.empty
            && let Some(p) = deletes.iter().find(|p| !self.named.contains(p))
        {
            return verdict(
                Decision::Deny,
                "unnamed_delete",
                format!(
                    "Your brief doesn't name {p}, so it may not be deleted. Leave it, or ask the user to add it to the brief."
                ),
            );
        }
        // Bursts: only actions that are going ahead count.
        let window = |q: &mut VecDeque<Instant>| {
            while q
                .front()
                .is_some_and(|t| now.duration_since(*t) > BURST_WINDOW)
            {
                q.pop_front();
            }
        };
        window(&mut self.deletes);
        window(&mut self.changes);
        let max_deletes = if self.brief.max_deletes == 0 {
            DEFAULT_MAX_DELETES
        } else {
            self.brief.max_deletes
        };
        let max_changes = if self.brief.max_changes == 0 {
            DEFAULT_MAX_CHANGES
        } else {
            self.brief.max_changes
        };
        if self.deletes.len() + deletes.len() > max_deletes
            || self.changes.len() + writes.len() + deletes.len() > max_changes
        {
            return verdict(
                Decision::Deny,
                "burst",
                format!(
                    "Too many changes at once: over {max_deletes} deletes or {max_changes} changes in a minute. Stop and tell the user what you're doing."
                ),
            );
        }
        self.deletes.extend(std::iter::repeat_n(now, deletes.len()));
        self.changes
            .extend(std::iter::repeat_n(now, writes.len() + deletes.len()));
        Verdict {
            deletes: deletes.len(),
            ..verdict(Decision::Allow, "none", "Inside the brief.")
        }
    }
}

/// Sessions by id, for the protocol. A session starts with the brief sent with its first check.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Session>>);

impl Sessions {
    pub fn check(&self, id: &str, brief: Option<Brief>, action: &Action) -> Verdict {
        let mut all = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(b) = brief {
            all.insert(id.to_string(), Session::new(b)); // a brief (re)starts the session's policy
        }
        let session = all
            .entry(id.to_string())
            .or_insert_with(|| Session::new(Brief::default()));
        session.check(action, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Projects\app")
        } else {
            PathBuf::from("/home/me/app")
        }
    }
    fn brief() -> Brief {
        Brief {
            roots: vec![root()],
            files: vec!["old/notes.md".into()],
            text: "Tidy the docs and delete legacy.txt.".into(),
            ..Brief::default()
        }
    }
    fn check(b: Brief, a: Action) -> Verdict {
        let t = Instant::now();
        let v = Session::new(b).check(&a, Instant::now());
        assert!(
            t.elapsed() < Duration::from_millis(5),
            "rules answer in under 5 ms: {:?}",
            t.elapsed()
        );
        v
    }
    fn p(rel: &str) -> PathBuf {
        root().join(rel)
    }
    fn shell(cmd: &str) -> Action {
        Action::Shell {
            command: cmd.into(),
            cwd: Some(root()),
        }
    }

    #[test]
    fn allows_work_inside_the_brief() {
        assert_eq!(
            check(
                brief(),
                Action::Write {
                    path: p("src/app.js")
                }
            )
            .decision,
            Decision::Allow
        );
        assert_eq!(
            check(
                brief(),
                Action::Read {
                    path: p("README.md")
                }
            )
            .decision,
            Decision::Allow
        );
        assert_eq!(check(brief(), shell("npm test")).decision, Decision::Allow);
        assert_eq!(
            check(
                brief(),
                Action::Delete {
                    path: p("old/notes.md")
                }
            )
            .decision,
            Decision::Allow,
            "named in files"
        );
        assert_eq!(
            check(brief(), shell("rm legacy.txt")).decision,
            Decision::Allow,
            "named in the text"
        );
    }

    #[test]
    fn denies_deleting_a_file_the_brief_does_not_name() {
        let v = check(
            brief(),
            Action::Delete {
                path: p("src/app.js"),
            },
        );
        assert_eq!(
            (v.decision, v.rule.as_str()),
            (Decision::Deny, "unnamed_delete")
        );
        assert!(v.reason.contains("doesn't name"), "{}", v.reason);
        assert_eq!(
            check(brief(), shell("rm src/app.js")).rule,
            "unnamed_delete"
        );
        assert_eq!(
            check(brief(), shell("mv src/app.js /tmp/x")).decision,
            Decision::Deny,
            "moving it away deletes it"
        );
        let allowed = Brief {
            allow_deletes: true,
            ..brief()
        };
        assert_eq!(
            check(
                allowed,
                Action::Delete {
                    path: p("src/app.js")
                }
            )
            .decision,
            Decision::Allow
        );
    }

    #[test]
    fn denies_writes_outside_the_scope() {
        let outside = if cfg!(windows) {
            r"C:\Users\me\Documents\x.txt"
        } else {
            "/home/me/Documents/x.txt"
        };
        let v = check(
            brief(),
            Action::Write {
                path: PathBuf::from(outside),
            },
        );
        assert_eq!(
            (v.decision, v.rule.as_str()),
            (Decision::Deny, "outside_scope")
        );
        assert_eq!(
            check(
                brief(),
                Action::Write {
                    path: p("../other/x.txt")
                }
            )
            .rule,
            "outside_scope",
            ".. can't escape"
        );
        assert_eq!(
            check(brief(), shell("echo hi > ../escape.txt")).rule,
            "outside_scope"
        );
        assert_eq!(
            check(
                brief(),
                Action::Write {
                    path: p("../app2/x.txt")
                }
            )
            .rule,
            "outside_scope",
            "a sibling with the same prefix"
        );
    }

    #[test]
    fn asks_before_recursive_or_wildcard_deletes() {
        for cmd in [
            "rm -rf build",
            "rm -r -f build",
            "Remove-Item -Recurse -Force dist",
            "del /s /q *.log",
            "rmdir /s build",
            "rm *.tmp",
        ] {
            let v = check(
                Brief {
                    allow_deletes: true,
                    ..brief()
                },
                shell(cmd),
            );
            assert_eq!(
                (v.decision, v.rule.as_str()),
                (Decision::Ask, "destructive"),
                "{cmd}"
            );
        }
        let allowed = Brief {
            allow_deletes: true,
            allow_destructive: true,
            ..brief()
        };
        assert_eq!(
            check(allowed, shell("rm -rf build")).decision,
            Decision::Allow
        );
    }

    #[test]
    fn asks_before_git_reset_hard_git_clean_and_force_push() {
        for (cmd, what) in [
            ("git reset --hard HEAD~3", "reset"),
            ("git clean -fdx", "clean"),
            ("git push --force origin main", "force"),
            ("git push -f", "force"),
            ("git push origin +main", "force"),
            ("cd sub && git reset --hard", "reset"),
        ] {
            let v = check(brief(), shell(cmd));
            assert_eq!(
                (v.decision, v.rule.as_str()),
                (Decision::Ask, "destructive"),
                "{cmd}"
            );
            assert!(
                v.reason.to_lowercase().contains(what),
                "{cmd}: {}",
                v.reason
            );
        }
        for cmd in [
            "git reset HEAD file",
            "git clean -n",
            "git push origin main",
            "git status",
        ] {
            assert_eq!(
                check(brief(), shell(cmd)).decision,
                Decision::Allow,
                "{cmd}"
            );
        }
    }

    #[test]
    fn always_denies_secret_files() {
        for rel in [
            ".env",
            ".env.local",
            "config/server.key",
            "certs/site.pem",
            ".ssh/id_ed25519",
            "vault.kdbx",
        ] {
            let v = check(
                Brief {
                    allow_deletes: true,
                    allow_destructive: true,
                    ..brief()
                },
                Action::Read { path: p(rel) },
            );
            assert_eq!(
                (v.decision, v.rule.as_str()),
                (Decision::Deny, "secret"),
                "{rel}"
            );
        }
        assert_eq!(check(brief(), shell("cat .env")).rule, "secret");
        assert_eq!(
            check(
                brief(),
                Action::Read {
                    path: p(".env.example")
                }
            )
            .decision,
            Decision::Allow,
            "an example file has no secrets"
        );
        let chrome = if cfg!(windows) {
            r"C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data"
        } else {
            "/home/me/.config/google-chrome/Default/Login Data"
        };
        assert_eq!(
            check(
                brief(),
                Action::Read {
                    path: PathBuf::from(chrome)
                }
            )
            .rule,
            "secret"
        );
    }

    #[test]
    fn denies_bursts_in_one_session() {
        let mut s = Session::new(Brief {
            allow_deletes: true,
            max_deletes: 3,
            max_changes: 5,
            ..brief()
        });
        let t = Instant::now();
        for i in 0..3 {
            assert_eq!(
                s.check(
                    &Action::Delete {
                        path: p(&format!("f{i}"))
                    },
                    t
                )
                .decision,
                Decision::Allow
            );
        }
        let v = s.check(&Action::Delete { path: p("f3") }, t);
        assert_eq!((v.decision, v.rule.as_str()), (Decision::Deny, "burst"));
        // A minute later the window has passed.
        assert_eq!(
            s.check(
                &Action::Delete { path: p("f4") },
                t + Duration::from_secs(61)
            )
            .decision,
            Decision::Allow
        );
        let mut w = Session::new(Brief {
            max_changes: 2,
            ..brief()
        });
        assert_eq!(
            w.check(&Action::Write { path: p("a") }, t).decision,
            Decision::Allow
        );
        assert_eq!(
            w.check(&Action::Write { path: p("b") }, t).decision,
            Decision::Allow
        );
        assert_eq!(w.check(&Action::Write { path: p("c") }, t).rule, "burst");
    }

    #[test]
    fn sessions_keep_their_brief_between_checks() {
        let sessions = Sessions::default();
        let first = sessions.check("s1", Some(brief()), &Action::Delete { path: p("x.js") });
        assert_eq!(first.rule, "unnamed_delete");
        assert_eq!(
            sessions
                .check("s1", None, &Action::Delete { path: p("x.js") })
                .rule,
            "unnamed_delete"
        );
        assert_eq!(
            sessions
                .check("s2", None, &Action::Delete { path: p("x.js") })
                .decision,
            Decision::Allow,
            "no brief: no scope to judge by"
        );
    }
}
