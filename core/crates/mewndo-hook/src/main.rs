// The forwarder's entry point (spec §33.10 Part B). The only place in the crate that touches stdout, the exit
// code or the process, so every decision above it stays a value a test can read.
//
// Fail open is the rule here, not an error path (§32.5 rule 7, §38.4 "Fail open"): a Mewndo failure must never
// block the user's agent. That means no `unwrap`, no `expect`, no usage message on stdout -- the agent would
// try to parse it as a hook answer -- and a panic hook that exits 0 before anything can reach the agent.
use mewndo_hook::args::{self, Args};

fn main() {
    install_fail_open_guard();

    // A command line the forwarder cannot read is not the user's problem: say nothing, exit 0. The hint goes
    // to stderr, where the agents either ignore it or show it only in verbose mode, so a human running this
    // by hand still gets told.
    let Some(parsed) = Args::parse(std::env::args().skip(1)) else {
        eprintln!(
            "mewndo-hook: usage: mewndo-hook <claude|codex|cursor> <event> [--dump]  (hook JSON on stdin)"
        );
        std::process::exit(0);
    };

    let input = args::read_input(&parsed);
    let outcome = mewndo_hook::run(&parsed, &input);

    // Exactly the core's bytes: no added newline (B3), and an explicit flush because `process::exit` does not
    // run destructors and would drop a buffered write.
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(outcome.stdout.as_bytes());
    let _ = out.flush();
    std::process::exit(outcome.exit_code);
}

/// A panic must not reach the agent either (§33.10 B5 is absolute about this). The hook prints nothing and
/// exits 0, which is the same answer as any other failure.
///
/// Why a panic hook and not `catch_unwind`: the release profile §33.10 B6 asks for sets `panic = "abort"`, and
/// with that there is nothing to catch. The hook still runs -- it is called before the abort -- so exiting 0
/// from inside it is the one thing that works under both unwind and abort. Nothing is printed and no
/// destructor needs to run, so there is nothing to lose by leaving this way.
fn install_fail_open_guard() {
    std::panic::set_hook(Box::new(|_| std::process::exit(0)));
}
