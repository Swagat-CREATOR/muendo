// The forwarder's command line and its input (spec §33.10 B1).
//
// Nothing here trusts argv. The agents build these command lines in config files the user edits by hand
// (§38.4 for Claude Code, §33.10 Part F for Codex and Cursor), so a missing or misspelled argument is a
// silent exit 0 -- never a usage error on stdout, which the agent would try to parse as a hook answer -- and
// the agent and event names are sanitized again before they are used in a path (dump.rs).
use std::io::Read;

/// §33.10 B1: "Read stdin to the end, with a 4 MB cap." Hook payloads are a few KB; the cap exists so that a
/// runaway agent writing gigabytes cannot make the forwarder hold them all in memory while the user waits.
pub const STDIN_CAP: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Args {
    /// `argv[1]`: `claude`, `codex` or `cursor`. Kept as given; an unknown agent can still be forwarded (the
    /// core decides what it knows), but it gets no deny JSON when the core is down, because the shape of that
    /// JSON is per agent (failopen.rs).
    pub agent: String,
    /// `argv[2]`: the event. Either the agent's own hook event name or the short name §38.4 puts in argv
    /// (`pre-tool`, `stop`, `notify`, `shell`).
    pub event: String,
    /// Positional arguments after the event. Codex's `notify` carries its JSON here, not on stdin (B1).
    pub rest: Vec<String>,
    /// `--dump` (B4): also write the raw input to `%MEWNDO_DUMP_DIR%\<agent>\<event>-<time>.json`.
    pub dump: bool,
}

impl Args {
    /// The arguments after argv[0]. `None` when the agent or the event is missing, which main.rs turns into
    /// "print nothing, exit 0".
    pub fn parse<I: IntoIterator<Item = String>>(argv: I) -> Option<Args> {
        let mut positional = Vec::new();
        let mut dump = false;
        for arg in argv {
            // Only `--`-prefixed words are flags, so Codex's `notify` JSON -- which starts with `{` -- can
            // never be read as one, and an unknown flag from a newer config file is ignored rather than
            // shifting the agent and event out of place.
            if arg.starts_with("--") {
                dump |= arg == "--dump";
            } else {
                positional.push(arg);
            }
        }
        if positional.len() < 2 {
            return None;
        }
        let mut it = positional.into_iter();
        Some(Args {
            agent: it.next()?,
            event: it.next()?,
            rest: it.collect(),
            dump,
        })
    }

    /// Codex delivers the agent-turn-complete JSON as the last argument of
    /// `notify = ["…mewndo-hook.exe", "codex", "notify"]` (§33.10 B1, Part F step 2), so for this one event
    /// stdin is not read at all -- Codex may not even open one, and a blocking read on an inherited console
    /// would hang the forwarder until the agent's timeout.
    pub fn codex_notify(&self) -> bool {
        self.agent.eq_ignore_ascii_case("codex") && self.event.eq_ignore_ascii_case("notify")
    }
}

/// At most `cap` bytes from `r`. Read errors keep what already arrived instead of failing: a short read is
/// still worth forwarding, and fail open (§32.5 rule 7) means an unreadable stdin must not stop the agent.
pub fn read_capped<R: Read>(r: R, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    // `take` stops at the cap, so the rest of a huge input is never copied into this process. The writer on
    // the other end sees a closed pipe when we exit, which is the intended, documented consequence of B1's
    // cap: past 4 MB the payload is truncated, not held.
    let _ = r.take(cap as u64).read_to_end(&mut buf);
    buf
}

/// The raw input for this invocation: Codex `notify` takes it from argv, everything else from stdin.
pub fn read_input(args: &Args) -> Vec<u8> {
    if args.codex_notify() {
        return args.rest.last().cloned().unwrap_or_default().into_bytes();
    }
    let stdin = std::io::stdin();
    // A terminal means a human ran the forwarder by hand; reading to EOF would wait for Ctrl-D forever. The
    // agents always give the hook a pipe, so this costs them nothing.
    if std::io::IsTerminal::is_terminal(&stdin) {
        return Vec::new();
    }
    read_capped(stdin.lock(), STDIN_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<Args> {
        Args::parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn the_agent_and_the_event_are_the_first_two_positional_arguments() {
        let a = parse(&["claude", "pre-tool"]).unwrap();
        assert_eq!((a.agent.as_str(), a.event.as_str()), ("claude", "pre-tool"));
        assert!(!a.dump && a.rest.is_empty());
    }

    #[test]
    fn dump_is_a_flag_anywhere_and_never_shifts_the_positions() {
        for argv in [
            &["--dump", "claude", "pre-tool"][..],
            &["claude", "--dump", "pre-tool"][..],
            &["claude", "pre-tool", "--dump"][..],
        ] {
            let a = parse(argv).unwrap();
            assert_eq!((a.agent.as_str(), a.event.as_str()), ("claude", "pre-tool"));
            assert!(a.dump, "{argv:?}");
        }
        // A flag a future config file adds is ignored, not treated as the agent.
        let a = parse(&["--verbose", "cursor", "shell"]).unwrap();
        assert_eq!((a.agent.as_str(), a.event.as_str()), ("cursor", "shell"));
        assert!(!a.dump);
    }

    #[test]
    fn too_few_arguments_is_none_so_main_can_exit_0() {
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&["claude"]), None);
        assert_eq!(parse(&["--dump"]), None);
    }

    #[test]
    fn codex_notify_reads_its_json_from_the_last_argument() {
        let json = r#"{"type":"agent-turn-complete","last-assistant-message":"done"}"#;
        let a = parse(&["codex", "notify", json]).unwrap();
        assert!(a.codex_notify());
        assert_eq!(read_input(&a), json.as_bytes());

        // With --dump last, the JSON is still the last *positional* argument.
        let a = parse(&["codex", "notify", json, "--dump"]).unwrap();
        assert_eq!(read_input(&a), json.as_bytes());
        assert!(a.dump);

        // Only Codex's notify, and nothing else, is argv-fed.
        assert!(!parse(&["codex", "pre-tool", "x"]).unwrap().codex_notify());
        assert!(!parse(&["claude", "notify"]).unwrap().codex_notify());
        assert!(parse(&["CODEX", "Notify"]).unwrap().codex_notify(), "case");
        // No JSON at all: empty, not a panic on `last()`.
        assert_eq!(read_input(&parse(&["codex", "notify"]).unwrap()), b"");
    }

    #[test]
    fn stdin_stops_at_the_cap() {
        let big = vec![b'x'; STDIN_CAP + 4096];
        assert_eq!(read_capped(&big[..], STDIN_CAP).len(), STDIN_CAP);
        assert_eq!(read_capped(&b"small"[..], STDIN_CAP), b"small");
        assert_eq!(read_capped(&b""[..], STDIN_CAP), b"");
        assert_eq!(read_capped(&b"abc"[..], 2), b"ab");
    }
}
