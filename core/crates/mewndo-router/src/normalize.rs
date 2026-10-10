// R2: the normalizer (spec §34.9 R2). Every agent, every tool and every shell says the same thing a
// different way; the rules, the signature and the model all need one way.
//
//   normalize(agent, tool, input, cwd) -> Action { kind, command_norm, paths, hosts, recipients }
//
// Two rules decide most of the design here:
//
//  * Links are never followed (plot.md rule 2, §34.9 R2). That rules out `canonicalize`, which follows
//    junctions and would let an agent get a path past the protect list by pointing a link at it. So the
//    normalization is purely lexical: `..` is resolved as text, `\\?\` is stripped as text, nothing is
//    touched on disk. It is also why there is no `dunce` dependency.
//  * Windows compares paths case-insensitively. So does this, and it lowercases a path whenever the path or
//    the cwd looks like Windows, not only when the build is Windows -- otherwise every Windows path test
//    would silently pass for the wrong reason when `cargo test` runs in WSL.
//
// What it cannot do, honestly (§28.10): it reads commands, it does not run them. Variables are not expanded,
// `$(...)` is not evaluated, aliases are unknown, and a command built at runtime out of a variable is just a
// word to it. That is why the model is asked as well, and why the protect list is checked against every path
// the command *names*, not against what it would eventually open.

use crate::sig::{Sig, action_sig};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

/// What the action does, in the terms the rules care about. Small on purpose: every extra kind is another
/// row the §34.4 table would have to mention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Read,
    Write,
    Delete,
    Move,
    /// A command whose effect we could not pin down. Not harmless: just not understood.
    #[default]
    Shell,
    Network,
    /// An MCP tool call: send email, post message, delete document (§34.2).
    Mcp,
    /// A computer-use click or keystroke (§36).
    Computer,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Read => "read",
            Kind::Write => "write",
            Kind::Delete => "delete",
            Kind::Move => "move",
            Kind::Shell => "shell",
            Kind::Network => "network",
            Kind::Mcp => "mcp",
            Kind::Computer => "computer",
        }
    }

    /// "Hard to undo without a backup" in the shape the rules can judge without a model (§34.8: past the
    /// deadline "a destructive action becomes ask"). A write counts: an overwrite loses the old contents,
    /// which is the whole reason Mewndo exists.
    pub fn destructive(self) -> bool {
        matches!(
            self,
            Kind::Delete | Kind::Move | Kind::Write | Kind::Computer | Kind::Mcp
        )
    }
}

/// One normalized action. Every field is already in compare form: lowercased, slashes forward, no `\\?\`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Action {
    pub kind: Kind,
    /// Lowercased, whitespace collapsed, program basenames without a directory or `.exe`, cut at 300
    /// characters (§34.9 "Speed rules"). This is what the rule phrases match and what the user sees in a
    /// habit card, so it must stay readable.
    pub command_norm: String,
    pub paths: Vec<String>,
    pub hosts: Vec<String>,
    /// Email addresses, channel names, phone numbers: who an MCP write tool would reach (§34.2).
    pub recipients: Vec<String>,
    /// The command was longer than the cut, so `command_norm` is not all of it. The rules can't clear what they
    /// didn't see: `facts::rules_pass` turns this into an ask, never an allow.
    pub truncated: bool,
}

/// §34.9 "Speed rules": commands are cut at 300 characters before they go anywhere near the model's state.
const MAX_COMMAND: usize = 300;

impl Action {
    /// The paths that identify the action for §34.4 row 4, the cache and habits.
    ///
    /// Reads and writes fold into their folder, because §34.7's own example of one learnable action is
    /// "edits inside `src/`": if every file had its own signature the user would be asked to make the same
    /// habit once per file. Deletes and moves keep their exact path -- grouping "delete anything in src/"
    /// into one habit is exactly the habit nobody should be able to make by accident.
    pub fn sig_paths(&self) -> Vec<String> {
        match self.kind {
            Kind::Read | Kind::Write => self.paths.iter().map(|p| parent_of(p)).collect(),
            _ => self.paths.clone(),
        }
    }

    /// §34.9 R4.
    pub fn signature(&self, agent_kind: &str) -> Sig {
        action_sig(
            agent_kind,
            self.kind.as_str(),
            &self.command_norm,
            &self.sig_paths(),
        )
    }
}

// --- paths ---------------------------------------------------------------------------------------------

fn looks_windows(s: &str) -> bool {
    s.contains('\\')
        || (s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic())
}

fn to_slashes(raw: &str) -> String {
    let s = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace('\\', "/");
    // `\\?\C:\x` and `\\?\UNC\server\share` are the Win32 long-path spellings. Stripping them is lexical and
    // must happen before anything else, or `//?/c:` would be read as a UNC server called `?`.
    if let Some(r) = s.strip_prefix("//?/UNC/") {
        format!("//{r}")
    } else if let Some(r) = s.strip_prefix("//?/") {
        r.to_string()
    } else if let Some(r) = s.strip_prefix("//./") {
        r.to_string()
    } else {
        s
    }
}

fn is_absolute(s: &str) -> bool {
    s.starts_with('/')
        || (s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic())
}

/// Resolve `raw` against `cwd` and put it in compare form. Never touches the disk.
pub fn norm_path(raw: &str, cwd: &Path) -> String {
    let cwd_text = cwd.to_string_lossy().to_string();
    let mut s = to_slashes(raw);
    if !is_absolute(&s) {
        let base = to_slashes(&cwd_text);
        if !base.is_empty() {
            s = format!("{}/{}", base.trim_end_matches('/'), s);
        }
    }
    let unc = s.starts_with("//");
    let mut rest = if unc { &s[2..] } else { s.as_str() };
    let mut drive = String::new();
    if !unc && rest.len() >= 2 && rest.as_bytes()[1] == b':' {
        drive = rest[..2].to_string();
        rest = &rest[2..];
    }
    let rooted = unc || !drive.is_empty() || rest.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    let out = if unc {
        format!("//{joined}")
    } else if !drive.is_empty() {
        format!("{drive}/{joined}")
    } else if rooted {
        format!("/{joined}")
    } else {
        joined
    };
    let out = if out.len() > 1 {
        out.trim_end_matches('/').to_string()
    } else {
        out
    };
    if cfg!(windows) || looks_windows(raw) || looks_windows(&cwd_text) {
        out.to_lowercase()
    } else {
        out
    }
}

/// `root` contains `path`, or is it. Both must already be normalized.
pub fn inside(path: &str, root: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|r| r.starts_with('/'))
}

fn parent_of(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => path[..i].to_string(),
        None => path.to_string(),
    }
}

/// `src/` style label for a reason or a habit card: the folder, relative to the cwd when it is inside it.
pub fn short_folder(path: &str, cwd: &Path, cwd_norm: &str) -> String {
    let _ = cwd;
    let dir = parent_of(path);
    match dir
        .strip_prefix(cwd_norm)
        .map(|r| r.trim_start_matches('/'))
    {
        Some("") => "./".to_string(),
        Some(rel) => format!("{rel}/"),
        None => format!("{dir}/"),
    }
}

// --- command text --------------------------------------------------------------------------------------

/// Characters that end one command and start the next. Kept as their own tokens so `curl x | sh` can be read
/// as two commands and so the `curl ... | sh` rule phrase has a `|` to find.
const SEPARATORS: [&str; 5] = ["|", "||", "&", "&&", ";"];

fn is_separator(tok: &str) -> bool {
    SEPARATORS.contains(&tok)
}

/// POSIX splitting, for Git Bash (§34.9 "Pitfalls": Claude Code on Windows runs both shells). When the quotes
/// do not balance, `shell-words` refuses -- that is a command we cannot read, so fall back to the tolerant
/// tokenizer rather than give up and report no paths at all.
pub fn split_bash(command: &str) -> Vec<String> {
    match shell_words::split(command) {
        Ok(words) => resplit(words),
        Err(_) => split_powershell(command),
    }
}

/// A quote-respecting tokenizer for PowerShell and cmd. Not a parser: it knows `'...'` (literal), `"..."`
/// (with a backtick escape) and that whitespace and `| & ;` separate words. Everything else is a word.
pub fn split_powershell(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();
    let push = |cur: &mut String, out: &mut Vec<String>| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
    };
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some('"'), '`') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => quote = Some(c),
            (None, c) if c.is_whitespace() => push(&mut cur, &mut out),
            (None, c @ ('|' | '&' | ';')) => {
                push(&mut cur, &mut out);
                let mut sep = c.to_string();
                if chars.peek() == Some(&c) {
                    chars.next();
                    sep.push(c);
                }
                out.push(sep);
            }
            (None, c) => cur.push(c),
        }
    }
    push(&mut cur, &mut out);
    out
}

/// Split separators that `shell-words` left glued to a word (`x|sh`), so that the sub-command walk and the
/// `curl ... | sh` phrase both see them. A file name containing `&` loses, which is rare enough on Windows to
/// be worth the rule phrases working.
fn resplit(words: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for w in words {
        if is_separator(&w) || !w.contains(['|', ';', '&']) {
            out.push(w);
            continue;
        }
        let mut cur = String::new();
        let mut chars = w.chars().peekable();
        while let Some(c) = chars.next() {
            if matches!(c, '|' | '&' | ';') {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                let mut sep = c.to_string();
                if chars.peek() == Some(&c) {
                    chars.next();
                    sep.push(c);
                }
                out.push(sep);
            } else {
                cur.push(c);
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

/// `C:\Program Files\Git\bin\rm.exe` -> `rm`.
fn program_name(tok: &str) -> String {
    let base = tok.rsplit(['/', '\\']).next().unwrap_or(tok).to_lowercase();
    base.strip_suffix(".exe").unwrap_or(&base).to_string()
}

/// Rebuild the command from its tokens: program basenames, lowercase, single spaces, cut at 300 characters.
/// Rebuilding rather than trimming the original is what makes `"C:\...\rm.exe" -rf db` and `rm -rf db` the
/// same command_norm, and therefore the same signature and the same habit.
fn command_norm(tokens: &[String]) -> String {
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    let mut at_start = true;
    for t in tokens {
        if is_separator(t) {
            out.push(t.clone());
            at_start = true;
            continue;
        }
        out.push(if at_start {
            program_name(t)
        } else {
            t.to_lowercase()
        });
        at_start = false;
    }
    let mut s = out.join(" ");
    if s.len() > MAX_COMMAND {
        s.truncate(
            (0..=MAX_COMMAND)
                .rev()
                .find(|i| s.is_char_boundary(*i))
                .unwrap_or(0),
        );
    }
    s
}

// --- what a command does -------------------------------------------------------------------------------

const DELETERS: [&str; 10] = [
    "rm",
    "rmdir",
    "del",
    "erase",
    "rd",
    "remove-item",
    "ri",
    "unlink",
    "shred",
    "clear-content",
];
const MOVERS: [&str; 6] = ["mv", "move", "move-item", "ren", "rename", "rename-item"];
const WRITERS: [&str; 10] = [
    "touch",
    "tee",
    "set-content",
    "add-content",
    "out-file",
    "cp",
    "copy",
    "copy-item",
    "new-item",
    "dd",
];
const READERS: [&str; 9] = [
    "cat",
    "type",
    "get-content",
    "gc",
    "less",
    "more",
    "head",
    "tail",
    "select-string",
];
const NETWORKERS: [&str; 10] = [
    "curl",
    "wget",
    "invoke-webrequest",
    "iwr",
    "invoke-restmethod",
    "irm",
    "scp",
    "sftp",
    "ssh",
    "rsync",
];

fn kind_of_program(prog: &str) -> Option<Kind> {
    if DELETERS.contains(&prog) {
        Some(Kind::Delete)
    } else if MOVERS.contains(&prog) {
        Some(Kind::Move)
    } else if NETWORKERS.contains(&prog) {
        Some(Kind::Network)
    } else if WRITERS.contains(&prog) {
        Some(Kind::Write)
    } else if READERS.contains(&prog) {
        Some(Kind::Read)
    } else {
        None
    }
}

/// Later entries win: a command line that deletes and reads is judged as a delete.
fn rank(k: Kind) -> u8 {
    match k {
        Kind::Shell => 0,
        Kind::Read => 1,
        Kind::Network => 2,
        Kind::Write => 3,
        Kind::Mcp => 4,
        Kind::Computer => 5,
        Kind::Move => 6,
        Kind::Delete => 7,
    }
}

fn host_of(token: &str) -> Option<String> {
    let after = token.split_once("://").map(|(_, r)| r)?;
    let host = after
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?;
    if host.contains('.') {
        Some(host.to_lowercase())
    } else {
        None
    }
}

fn looks_email(token: &str) -> bool {
    match token.split_once('@') {
        Some((user, host)) => !user.is_empty() && host.contains('.') && !host.ends_with('.'),
        None => false,
    }
}

/// A token that could be a path: not a flag, not a separator, not a URL.
fn path_like(token: &str) -> bool {
    !token.is_empty()
        && !token.starts_with('-')
        && !is_separator(token)
        && !token.contains("://")
        && !looks_email(token)
        // `/s` and `/q` are cmd switches, not the root of the disk.
        && !(token.starts_with('/') && token.len() <= 3 && !token.contains('.'))
}

// --- the entry point -----------------------------------------------------------------------------------

fn first_str(input: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = input.get(*k).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    String::new()
}

/// §34.9 R2. `agent` is the agent kind ("claude-code", "cursor"), `tool` the tool name the hook reported,
/// `input` that tool's arguments, `cwd` where the agent is working.
pub fn normalize(agent: &str, tool: &str, input: &Value, cwd: &Path) -> Action {
    let t = tool.to_lowercase();
    if t.starts_with("mcp__") {
        return mcp_action(tool, input, cwd);
    }
    match t.as_str() {
        "bash" | "shell" | "sh" | "run_command" | "runcommand" | "terminal" | "execute"
        | "powershell" | "pwsh" | "cmd" => {
            let command = first_str(input, &["command", "cmd", "script", "input", "code"]);
            shell_action(agent, &t, &command, cwd)
        }
        "edit" | "write" | "multiedit" | "notebookedit" | "create" | "str_replace_editor"
        | "apply_patch" | "edit_file" => file_action(Kind::Write, input, cwd),
        "read" | "glob" | "grep" | "ls" | "notebookread" | "view" | "read_file" => {
            file_action(Kind::Read, input, cwd)
        }
        "delete" | "remove" | "delete_file" => file_action(Kind::Delete, input, cwd),
        "webfetch" | "websearch" | "fetch" | "http_request" => network_action(input),
        "computer" | "computer_use" | "cua" | "click" | "keystroke" => computer_action(input),
        _ if input.get("command").is_some() => {
            let command = first_str(input, &["command"]);
            shell_action(agent, &t, &command, cwd)
        }
        _ if input.get("file_path").is_some() || input.get("path").is_some() => {
            file_action(Kind::Write, input, cwd)
        }
        _ => mcp_action(tool, input, cwd),
    }
}

/// A backslash that is a path separator rather than a shell escape: `\\server`, `.\api`, `C:\work`, `\\?\`.
///
/// This is the §34.9 pitfall that bites hardest. `shell-words` follows POSIX, where `\` escapes the next
/// character, so it reads `.\api\date.ts` as `.apidate.ts` -- a path that is in no brief, matches no protect
/// rule and names no real file. On Windows a backslash before a letter is a folder separator, so a command
/// that contains one is tokenized the Windows way.
fn windows_path_in(command: &str) -> bool {
    command.as_bytes().windows(2).any(|w| {
        w[0] == b'\\'
            && (w[1].is_ascii_alphanumeric() || w[1] == b'\\' || w[1] == b'.' || w[1] == b'?')
    })
}

/// A shell command. Which tokenizer is a guess from the agent, the tool name and the command's own shape;
/// both tokenizers produce the same answer for the commands people actually write, and the bash one falls
/// back to the other when the quotes do not balance.
fn shell_action(agent: &str, tool: &str, command: &str, cwd: &Path) -> Action {
    let powershell = tool.contains("powershell")
        || tool == "pwsh"
        || tool == "cmd"
        || agent.to_lowercase().contains("powershell")
        || command.contains("$env:")
        || command.contains('`')
        || command.to_lowercase().contains("-recurse")
        || windows_path_in(command);
    let tokens = if powershell {
        split_powershell(command)
    } else {
        split_bash(command)
    };
    let mut action = Action {
        truncated: tokens.iter().map(|t| t.len() + 1).sum::<usize>() > MAX_COMMAND + 1,
        command_norm: command_norm(&tokens),
        ..Action::default()
    };
    let mut best = Kind::Shell;
    let mut raw_paths: Vec<String> = Vec::new();
    for part in tokens.split(|t| is_separator(t)) {
        let Some(program) = part.first() else {
            continue;
        };
        let prog = program_name(program);
        let args = &part[1..];
        if let Some(k) = kind_of_program(&prog)
            && rank(k) > rank(best)
        {
            best = k;
        }
        let takes_paths = kind_of_program(&prog).is_some_and(|k| k != Kind::Network);
        for (i, a) in args.iter().enumerate() {
            if let Some(h) = host_of(a) {
                action.hosts.push(h);
            } else if looks_email(a) {
                action.recipients.push(a.to_lowercase());
            } else if path_like(a) && takes_paths {
                raw_paths.push(a.clone());
            }
            // Redirection writes a file even when the program only reads one.
            if (a == ">" || a == ">>")
                && let Some(target) = args.get(i + 1)
            {
                raw_paths.push(target.clone());
                if rank(Kind::Write) > rank(best) {
                    best = Kind::Write;
                }
            }
        }
    }
    action.kind = best;
    action.paths = raw_paths.iter().map(|p| norm_path(p, cwd)).collect();
    action.paths.sort();
    action.paths.dedup();
    action.hosts.sort();
    action.hosts.dedup();
    action
}

/// `Edit`, `Write` and `MultiEdit` give `file_path` (§34.9 R2).
fn file_action(kind: Kind, input: &Value, cwd: &Path) -> Action {
    let mut paths: Vec<String> = Vec::new();
    for key in [
        "file_path",
        "path",
        "filePath",
        "notebook_path",
        "target_file",
    ] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            paths.push(norm_path(s, cwd));
        }
    }
    if let Some(list) = input
        .get("file_paths")
        .or_else(|| input.get("paths"))
        .and_then(Value::as_array)
    {
        for v in list {
            if let Some(s) = v.as_str() {
                paths.push(norm_path(s, cwd));
            }
        }
    }
    paths.sort();
    paths.dedup();
    let cwd_norm = norm_path(".", cwd);
    // "write src/" rather than "write src/app.ts": §34.7's unit of a habit is the folder, and sig_paths
    // folds the same way, so the card the user sees and the key it is stored under agree.
    let where_ = paths
        .first()
        .map(|p| short_folder(p, cwd, &cwd_norm))
        .unwrap_or_default();
    Action {
        kind,
        command_norm: format!("{} {}", kind.as_str(), where_)
            .trim_end()
            .to_string(),
        paths,
        ..Action::default()
    }
}

fn network_action(input: &Value) -> Action {
    let url = first_str(input, &["url", "uri", "endpoint", "query"]);
    let host = host_of(&url).unwrap_or_default();
    Action {
        kind: Kind::Network,
        command_norm: format!("fetch {}", host).trim_end().to_string(),
        hosts: if host.is_empty() { vec![] } else { vec![host] },
        ..Action::default()
    }
}

fn computer_action(input: &Value) -> Action {
    let name = first_str(input, &["name", "text", "target", "label", "element"]);
    let what = first_str(input, &["action", "type", "kind"]);
    let window = first_str(input, &["window", "title", "app"]);
    Action {
        kind: Kind::Computer,
        // The window title rides along in command_norm because the private-windows rule (§34.9 R1) is the
        // only thing that can see it, and because a click on "Send" means something different in each app.
        command_norm: format!("{} {} {}", what, name, window)
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        recipients: recipients_from(input),
        ..Action::default()
    }
}

/// MCP tools give the tool name plus an argument summary (§34.9 R2). Only short scalars are summarized:
/// an email body must never reach the model's state (§34.3 keeps it under 800 tokens, and plot.md rule 7
/// keeps the user's content on the machine).
fn mcp_action(tool: &str, input: &Value, cwd: &Path) -> Action {
    let mut summary: Vec<String> = Vec::new();
    let mut hosts: Vec<String> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    if let Some(obj) = input.as_object() {
        for (k, v) in obj {
            let text = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            if let Some(h) = host_of(&text) {
                hosts.push(h);
            }
            if k.contains("path") || k.contains("file") {
                paths.push(norm_path(&text, cwd));
            }
            if text.len() <= 60 {
                summary.push(format!("{k}={}", text.to_lowercase()));
            } else {
                summary.push(format!("{k}=<{} chars>", text.len()));
            }
        }
    }
    summary.sort();
    let mut command = format!("{} {}", tool.to_lowercase(), summary.join(" "));
    let truncated = command.len() > MAX_COMMAND;
    if truncated {
        command.truncate(
            (0..=MAX_COMMAND)
                .rev()
                .find(|i| command.is_char_boundary(*i))
                .unwrap_or(0),
        );
    }
    hosts.sort();
    hosts.dedup();
    paths.sort();
    paths.dedup();
    Action {
        truncated,
        kind: Kind::Mcp,
        command_norm: command.trim_end().to_string(),
        paths,
        hosts,
        recipients: recipients_from(input),
    }
}

/// Who a write tool would reach. Look-alike domains are judged from this (§34.4 row 1), so a recipient that
/// is missed here is a recipient nobody checks: the key list is deliberately wide.
fn recipients_from(input: &Value) -> Vec<String> {
    const KEYS: [&str; 10] = [
        "to",
        "recipient",
        "recipients",
        "email",
        "emails",
        "cc",
        "bcc",
        "channel",
        "chat_id",
        "phone",
    ];
    let mut out: Vec<String> = Vec::new();
    let Some(obj) = input.as_object() else {
        return out;
    };
    for (k, v) in obj {
        let key = k.to_lowercase();
        if !KEYS.contains(&key.as_str()) {
            continue;
        }
        match v {
            Value::String(s) => out.extend(s.split([',', ';']).map(|p| p.trim().to_lowercase())),
            Value::Array(list) => out.extend(
                list.iter()
                    .filter_map(Value::as_str)
                    .map(|s| s.trim().to_lowercase()),
            ),
            _ => {}
        }
    }
    out.retain(|r| !r.is_empty());
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win() -> &'static Path {
        Path::new("C:/work/shop")
    }

    #[test]
    fn strips_long_path_prefixes_and_resolves_dots() {
        assert_eq!(
            norm_path(r"\\?\C:\Work\Shop\..\other", win()),
            "c:/work/other"
        );
        assert_eq!(
            norm_path(r"\\?\UNC\server\share\x", win()),
            "//server/share/x"
        );
        assert_eq!(norm_path(r"\\server\share\x", win()), "//server/share/x");
        assert_eq!(norm_path("api/date.ts", win()), "c:/work/shop/api/date.ts");
        assert_eq!(
            norm_path(r"DB\Migrations", win()),
            "c:/work/shop/db/migrations"
        );
    }

    #[test]
    fn reads_both_shells() {
        let bash = shell_action("claude-code", "bash", r#"rm -rf "my docs/old" db"#, win());
        assert_eq!(bash.kind, Kind::Delete);
        assert_eq!(
            bash.paths,
            vec![
                "c:/work/shop/db".to_string(),
                "c:/work/shop/my docs/old".to_string()
            ]
        );
        let ps = shell_action(
            "claude-code",
            "bash",
            "Remove-Item -Recurse -Force 'C:\\work\\shop\\dist'",
            win(),
        );
        assert_eq!(ps.kind, Kind::Delete);
        assert_eq!(ps.paths, vec!["c:/work/shop/dist".to_string()]);
        assert_eq!(
            ps.command_norm,
            "remove-item -recurse -force c:\\work\\shop\\dist"
        );
    }
}
