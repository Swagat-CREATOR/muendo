// Fail open (spec §33.10 B5, §38.4 "Fail open", §32.5 rule 7).
//
// This is the part of the forwarder that matters most. When the core is missing, dead, or refuses the
// request, the agent must carry on exactly as if Mewndo were never installed -- no output, exit 0 -- with one
// single exception: a pre-action event whose payload touches a protected path is denied from a list cached on
// disk, because losing a .env or an SSH key is the one harm the user cannot undo by waiting.
//
// Three deliberate limits, stated honestly as §28.10 asks:
//
//  1. Only the `protect` list from `deny-cache.json` is applied, never its `deny` or `ask` command phrases.
//     §33.10 B5 and §38.4 both say "only the deny list for protected paths". Refusing commands from here
//     would mean a broken Mewndo blocking a user's `git push --force` -- a false deny is the one failure fail
//     open must never produce, and v0's save points already cover a destructive command the user can undo.
//  2. Only `PreToolUse` and `beforeShellExecution` (and the short argv names §38.4 uses for them). A deny
//     after the fact is pointless, and `PermissionRequest` is a question, not an action.
//  3. The payload scan is bounded (`SCAN_BYTES`, `SCAN_CANDIDATES`). A protected path hidden past the bound
//     inside a multi-megabyte payload is not caught with the core down. The forwarder has a 20 ms budget and
//     this path runs with no core to help it; an unbounded scan of a 4 MB payload would blow that budget,
//     which would itself block the agent.
//
// The protect matcher below is a deliberate copy of `mewndo_router::rules::{glob, protected}`, not a
// dependency on it. rules.rs says why in its own comment on `deny_cache_json`: "The forwarder is a different
// process that must refuse the same commands without loading this crate, so it gets the phrases as plain
// text." Loading the router would pull blake3, regex, toml and shell-words into a binary whose whole purpose
// is to start in a few milliseconds. If the matching rules in rules.rs change, change them here too -- the
// `the_matcher_agrees_with_the_router` test below pins the cases both sides must agree on.
use crate::args::Args;
use crate::{Outcome, pipe};
use serde_json::Value;
use std::path::Path;

/// How much payload text the scan will look at, and how many candidates it will test. See limit 3 above.
const SCAN_BYTES: usize = 64 * 1024;
const SCAN_CANDIDATES: usize = 4096;
/// One string longer than this is tested token by token but not as a whole: glob backtracking over a
/// megabyte of text is not worth the microseconds, and a real path is never this long.
const MAX_WHOLE: usize = 4096;
/// Nesting guard for the walk. serde_json refuses deeper than 128 by default, so this cannot be reached by a
/// parsed payload; it is here so the recursion can never be the thing that crashes the forwarder.
const MAX_DEPTH: usize = 64;
/// The quoted path in a deny reason is for a human to read, not a transcript.
const REASON_PATH_CHARS: usize = 160;

/// `%LOCALAPPDATA%\Mewndo\deny-cache.json`, written by the core whenever the rules change (§33.10 B5). Its
/// shape is `{"deny":[…],"ask":[…],"protect":[…]}` -- `mewndo_router::rules::CompiledRules::deny_cache_json`
/// produces exactly those bytes. Only `protect` is read here (limit 1 above).
#[derive(Debug, Clone, Default)]
pub struct Cache {
    protect: Vec<String>,
}

impl Cache {
    /// A missing, half-written or junk file means nothing is protected, not an error: the core writes it, and
    /// if the core has never run there is nothing to protect yet.
    pub fn load(dir: &Path) -> Cache {
        std::fs::read(dir.join("deny-cache.json"))
            .ok()
            .map(|bytes| Cache::from_json(&bytes))
            .unwrap_or_default()
    }

    pub fn from_json(bytes: &[u8]) -> Cache {
        let Ok(json) = serde_json::from_slice::<Value>(bytes) else {
            return Cache::default();
        };
        let protect = json
            .get("protect")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    // The core lowercases these when it compiles the rules, but a hand-written cache might
                    // not, and a case-sensitive match on Windows paths would quietly protect nothing.
                    .map(|p| p.trim().to_lowercase())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Cache { protect }
    }

    pub fn is_empty(&self) -> bool {
        self.protect.is_empty()
    }

    /// The pattern a path matches, if any. Same rule as the router: an entry without a slash is matched
    /// against the file name (`.env`, `*.pem`), an entry with one against the whole path and against every
    /// folder above it, so a protected folder covers what is inside it.
    pub fn protected(&self, path: &str) -> Option<&str> {
        let name = path.rsplit('/').next().unwrap_or(path);
        self.protect
            .iter()
            .find(|pat| {
                if pat.contains('/') {
                    let folder = pat.trim_end_matches('/');
                    glob(pat, path)
                        || path
                            .strip_prefix(folder)
                            .is_some_and(|rest| rest.starts_with('/'))
                } else {
                    glob(pat, name)
                }
            })
            .map(String::as_str)
    }

    /// The first protected path anywhere in a hook payload, as (what matched, the pattern it matched).
    ///
    /// Every string in the payload is a candidate, and every whitespace- or shell-separated word inside it.
    /// Nothing here knows a field name: §32.5 rule 2 forbids coding against payload shapes nobody has
    /// captured, the three agents disagree about them anyway (`tool_input.file_path`, `command`, Cursor's own
    /// shape), and a new agent or a new tool would silently stop being checked. A string scan cannot go out
    /// of date like that.
    pub fn first_protected(&self, payload: &Value) -> Option<(String, String)> {
        if self.is_empty() {
            return None;
        }
        let mut budget = Budget {
            bytes: SCAN_BYTES,
            candidates: SCAN_CANDIDATES,
        };
        self.walk(payload, 0, &mut budget)
    }

    fn walk(&self, v: &Value, depth: usize, budget: &mut Budget) -> Option<(String, String)> {
        if depth > MAX_DEPTH || budget.spent() {
            return None;
        }
        match v {
            Value::String(s) => self.scan(s, budget),
            Value::Array(items) => items.iter().find_map(|i| self.walk(i, depth + 1, budget)),
            // Keys are field names, not values; they are never a path, and §32.5 rule 2 says not to read
            // meaning into them.
            Value::Object(fields) => fields
                .values()
                .find_map(|i| self.walk(i, depth + 1, budget)),
            _ => None,
        }
    }

    /// One string: the whole thing first (so `*/.ssh/*` matches inside `rm -rf ~/.ssh/id_rsa`), then each
    /// word (so a name-only pattern like `.env` matches the `.env` argument of a longer command).
    fn scan(&self, s: &str, budget: &mut Budget) -> Option<(String, String)> {
        budget.bytes = budget.bytes.saturating_sub(s.len());
        let text = normalize(s);
        if text.len() <= MAX_WHOLE {
            budget.candidates = budget.candidates.saturating_sub(1);
            if let Some(pattern) = self.protected(&text) {
                return Some((text.clone(), pattern.to_string()));
            }
        }
        for word in text.split(is_separator).filter(|w| !w.is_empty()) {
            if budget.candidates == 0 {
                return None;
            }
            budget.candidates -= 1;
            let word = word.trim_matches(is_edge);
            if word.is_empty() {
                continue;
            }
            if let Some(pattern) = self.protected(word) {
                return Some((word.to_string(), pattern.to_string()));
            }
        }
        None
    }
}

struct Budget {
    bytes: usize,
    candidates: usize,
}

impl Budget {
    fn spent(&self) -> bool {
        self.bytes == 0 || self.candidates == 0
    }
}

/// Lowercase, and Windows separators turned into `/` so one set of patterns covers `C:\work\.env` and
/// `C:/work/.env` and `c:\\work\\.env` as the agents variously write them. The router normalizes paths the
/// same way before matching.
fn normalize(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\\' => '/',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

/// Where one word ends in a command line. Shell metacharacters and `=` are separators so that
/// `--env-file=.env` and `cat <.env` both yield `.env`; `:` and `.` are not, because `c:/x` and `.env` are
/// one word each.
fn is_separator(c: char) -> bool {
    c.is_whitespace() || matches!(c, ';' | '|' | '&' | '<' | '>' | '(' | ')' | '=' | ',' | '`')
}

/// Punctuation a word can be wrapped in, which is not part of a path.
fn is_edge(c: char) -> bool {
    matches!(c, '"' | '\'' | '{' | '}' | '[' | ']' | ':' | ';' | ',')
}

/// Glob with `*` (any run, separators included) and `?` (one character), copied from
/// `mewndo_router::rules::glob` so both processes refuse the same paths. Honestly limited, as that crate says:
/// no `[a-z]`, no `{a,b}`, and `*` does cross `/`, which is what makes `*/.ssh/*` work.
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

/// §33.10 B5: "for pre-action events only (`PreToolUse`, `beforeShellExecution`)".
///
/// Both the agents' own event names and the short names the config files put in argv are accepted, because
/// the forwarder sees the latter: §38.4 spells `claude pre-tool`, and §33.10 Part F step 4 spells
/// `cursor shell` for `beforeShellExecution`. The check is agent-independent -- the names do not collide --
/// so a fourth agent wired up later is covered without a code change.
pub fn is_pre_action(event: &str) -> bool {
    let e = event.trim().to_ascii_lowercase();
    matches!(
        e.as_str(),
        "pre-tool" | "pretool" | "pretooluse" | "pre_tool_use" | "shell" | "beforeshellexecution"
    )
}

/// The deny JSON for one agent, or `None` for an agent whose shape Mewndo does not know -- in which case the
/// forwarder says nothing, because printing the wrong shape at an agent is worse than printing nothing.
///
/// Exit code 0 in every case: the decision travels in the JSON on stdout, which is how all three agents read
/// it. (Codex also accepts exit code 2 per §33.10, but a bare 2 carries no reason the model can read.)
pub fn deny_json(agent: &str, reason: &str) -> Option<String> {
    let json = match agent.trim().to_ascii_lowercase().as_str() {
        // §33.10 Part C and §34.8: `permissionDecision` with a reason the agent can read back.
        // `hookEventName` is `PreToolUse` because that is Claude Code's only pre-action event (§38.4).
        "claude" => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }),
        // Verified from Codex 0.156.1's own hook schema (docs/samples/codex/schema/hook-schemas.json): the same
        // nesting as Claude's, and no other field, because Codex refuses unknown ones.
        "codex" => serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }),
        // §33.10: Cursor's `beforeShellExecution` returns `{"permission": "deny", "agent_message": "…"}`.
        // No event name in the shape, so none is sent.
        "cursor" => serde_json::json!({
            "permission": "deny",
            "agent_message": reason,
        }),
        _ => return None,
    };
    Some(json.to_string())
}

/// What the agent is told. Short, honest, and it names the cached rule, so a user who sees it in a transcript
/// can find the line in their own rules file.
pub fn reason(hit: &str, pattern: &str) -> String {
    let path: String = hit.chars().take(REASON_PATH_CHARS).collect();
    format!(
        "Mewndo is not running, so it could not take a save point. \"{path}\" matches the protected-path rule \"{pattern}\" in Mewndo's cached deny list, so this is denied. Ask the user, or start Mewndo and try again."
    )
}

/// The whole of §33.10 B5, in order: pre-action events only, then the cache, then this agent's deny JSON.
/// Everything else -- and every failure on the way -- is silence and exit 0.
pub fn answer(args: &Args, payload: &Value) -> Outcome {
    if !is_pre_action(&args.event) {
        return Outcome::silent();
    }
    let Some(dir) = pipe::desk_dir() else {
        return Outcome::silent();
    };
    let Some((hit, pattern)) = Cache::load(&dir).first_protected(payload) else {
        return Outcome::silent();
    };
    let Some(stdout) = deny_json(&args.agent, &reason(&hit, &pattern)) else {
        return Outcome::silent();
    };
    Outcome {
        stdout,
        exit_code: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The §34.9 R1 defaults, as `CompiledRules::deny_cache_json` writes them out.
    fn cache() -> Cache {
        Cache::from_json(
            br#"{"deny":["format","rm -rf /"],"ask":["git push --force"],
                 "protect":[".env",".env.*","*.pem","*.key","id_rsa*","id_ed25519*",".netrc",
                            "*/.ssh/*","*/.aws/credentials","*/user data/*","c:/users/me/documents"]}"#,
        )
    }

    #[test]
    fn a_missing_or_junk_cache_protects_nothing() {
        for junk in [
            &b"{"[..],
            b"",
            b"null",
            br#"{"protect":"all"}"#,
            br#"{"deny":[".env"]}"#,
        ] {
            assert!(Cache::from_json(junk).is_empty(), "{:?}", junk);
        }
        let dir = std::env::temp_dir().join(format!("mewndo-hook-nocache-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(
            Cache::load(&dir).is_empty(),
            "no file: nothing is protected"
        );
    }

    #[test]
    fn the_matcher_agrees_with_the_router() {
        // The same cases mewndo-router's `protect_covers_names_folders_and_v0_settings` pins, so the two
        // processes cannot drift apart.
        let c = cache();
        assert!(c.protected("c:/work/shop/.env").is_some());
        assert!(c.protected("c:/work/shop/certs/site.pem").is_some());
        assert!(c.protected("c:/users/me/.ssh/id_ed25519").is_some());
        assert!(
            c.protected("c:/users/me/documents/tax.pdf").is_some(),
            "v0 folder"
        );
        assert!(c.protected("c:/work/shop/api/date.ts").is_none());
        assert!(
            c.protected("c:/work/shop/.env.example").is_some(),
            "still a .env file"
        );
        // Glob, as copied from the router.
        assert!(glob("*/.ssh/*", "/home/me/.ssh/config"));
        assert!(glob("id_rsa*", "id_rsa.pub"));
        assert!(!glob("*.pem", "pem.txt"));
        assert!(glob("*", ""));
    }

    #[test]
    fn a_protected_path_is_found_wherever_it_sits_in_the_payload() {
        let c = cache();
        // Claude Code's Edit shape.
        let (hit, pat) = c
            .first_protected(
                &json!({"tool_name":"Edit","tool_input":{"file_path":"C:\\work\\shop\\.env"}}),
            )
            .unwrap();
        assert_eq!((hit.as_str(), pat.as_str()), ("c:/work/shop/.env", ".env"));
        // A shell command, where the path is one word inside a longer string.
        let (hit, _) = c
            .first_protected(&json!({"tool_input":{"command":"cat .env | grep KEY"}}))
            .unwrap();
        assert_eq!(hit, ".env");
        // A folder pattern matching inside the whole command, not just a word.
        assert!(
            c.first_protected(&json!({"command":"rm -rf ~/.ssh/known_hosts"}))
                .is_some()
        );
        // Nested anywhere, including an array.
        assert!(
            c.first_protected(&json!({"a":[{"b":["x","site.pem"]}]}))
                .is_some()
        );
        // `--flag=value` and quoted arguments both yield the path.
        assert!(
            c.first_protected(&json!("docker run --env-file=.env web"))
                .is_some()
        );
        assert!(
            c.first_protected(&json!({"command":"cp \"id_rsa\" /tmp"}))
                .is_some()
        );
        // Nothing protected: no output, which is the normal case for almost every action.
        assert_eq!(
            c.first_protected(&json!({"command":"npm test -- --watch=false"})),
            None
        );
        assert_eq!(c.first_protected(&json!({"command":"git status"})), None);
        assert_eq!(c.first_protected(&Value::Null), None);
        // Field *names* are not candidates: only values can be paths.
        assert_eq!(c.first_protected(&json!({".env":"ok"})), None);
    }

    #[test]
    fn the_scan_is_bounded_so_a_huge_payload_cannot_stall_the_hook() {
        let c = cache();
        let mut filler = "x ".repeat(SCAN_CANDIDATES + 10);
        filler.push_str(" .env");
        // Past the candidate bound the scan gives up rather than keep the agent waiting (limit 3 above).
        assert_eq!(c.first_protected(&json!({"command": filler})), None);
        // A protected path early in the same payload is still caught.
        assert!(
            c.first_protected(&json!({"a":".env","b":"x ".repeat(100000)}))
                .is_some()
        );
    }

    #[test]
    fn only_pre_action_events_are_denied() {
        for yes in [
            "pre-tool",
            "PreToolUse",
            "pretooluse",
            "pre_tool_use",
            "shell",
            "beforeShellExecution",
        ] {
            assert!(is_pre_action(yes), "{yes}");
        }
        for no in [
            "post-tool",
            "PostToolUse",
            "permission",
            "PermissionRequest",
            "stop",
            "notify",
            "session-start",
            "prompt",
            "",
        ] {
            assert!(!is_pre_action(no), "{no}");
        }
    }

    #[test]
    fn each_agent_gets_its_own_deny_shape_and_an_unknown_agent_gets_nothing() {
        let claude: Value = serde_json::from_str(&deny_json("claude", "no").unwrap()).unwrap();
        assert_eq!(claude["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(claude["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(
            claude["hookSpecificOutput"]["permissionDecisionReason"],
            "no"
        );

        let codex: Value = serde_json::from_str(&deny_json("Codex", "no").unwrap()).unwrap();
        assert_eq!(codex["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(codex["hookSpecificOutput"]["hookEventName"], "PreToolUse");

        let cursor: Value = serde_json::from_str(&deny_json("cursor", "no").unwrap()).unwrap();
        assert_eq!(
            (&cursor["permission"], &cursor["agent_message"]),
            (&json!("deny"), &json!("no"))
        );

        assert_eq!(deny_json("gemini", "no"), None);
        assert_eq!(deny_json("", "no"), None);

        // The reason names the rule, and a pathological "path" cannot stretch it.
        let r = reason(&"a".repeat(10_000), ".env");
        assert!(r.contains(".env") && r.len() < 600, "{}", r.len());
    }
}
