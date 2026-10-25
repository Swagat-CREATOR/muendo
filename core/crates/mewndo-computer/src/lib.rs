// Guarded computer use: the MCP proxy in front of cua-driver (spec §36.2, §36.4; build guide §36.6 U1-U6, U8).
//
// What it is for. An agent that can click and type on the user's desktop can do anything the user can, with no
// undo and no record. Mewndo does not stop it from having hands -- it puts itself between the hands and the
// desktop. Every action an agent asks for passes four things before it happens: a classifier, the Router, the
// user, and the human-takeover switch. Then, and only then, it is forwarded to cua-driver and written down.
//
// The shape (§36.2):
//
//   the agent --MCP stdio--> mewndo-computer (rmcp server) --pipe--> the main core (Router, Inbox, UIA, cursor)
//                                   |
//                                   +--MCP stdio--> cua-driver mcp (child process, rmcp client)
//
// Each agent starts its **own** copy of this proxy, so this process is small, short-lived and owns nothing the
// core owns. It re-exports cua-driver's tools as `computer_<name>` with the same input schema and a description
// prefixed "[Guarded by Mewndo] " (U3), which is what makes the guard impossible to route around: there is no
// unguarded tool name to call.
//
// The three rules this crate exists to keep, in the order they matter:
//
//  1. **A password field's text is never shown and never logged.** Not in the card, not in the span, not in the
//     `computer.action` message, not in a debug line, not in an error. `redact.rs` is the only thing that ever
//     sees it, and it returns the length and nothing else. CLAUDE.md rule 4.
//  2. **The key-press path never logs key contents.** The low-level keyboard hook of U6 reads one bit -- was
//     this injected -- and pushes a tagged event that carries no virtual key for a keyboard press at all. That
//     is the line between a safety feature and a keylogger, and `hooks.rs` is written so that crossing it needs
//     a deliberate change, not a slip.
//  3. **A deny is an answer, not a silence.** A denied call comes back as an MCP tool result with
//     `isError: true` and the text "Mewndo blocked: <reason>" (U5.8), so the agent reads why and stops instead
//     of retrying blindly.
//
// §32.5 rule 5: every Win32 call sits behind `#[cfg(windows)]` with a stub for other targets, and the logic --
// tool classification, the act flow's decisions, the pause state machine, redaction -- is pure and covered by
// `cargo test` in WSL.
//
// What it does not do, honestly (§28.10, CLAUDE.md rule 5):
//
//   - **No UI Automation lookup.** U5.3's "name, control type, window title, process at this point, 300 ms cap"
//     happens on the main core's UIA thread, because COM apartment state belongs to one process and the core
//     already owns it. This crate sends `computer.action` and waits for `computer.verdict`; the element facts
//     travel with the verdict's reason. `link.rs` is where that round trip lives, behind a trait, so the whole
//     act flow is tested against a fake core.
//   - **No screenshot and no crop.** U5.5's 400x240 WebP crop is the core's (`xcap` + `image`), for the same
//     reason. This crate asks for a card; it never captures a pixel.
//   - **No cursor drawing.** The core's overlay (`mewndo-overlay`) draws the agent cursor. This crate only switches
//     cua-driver's own cursor off at start (U8, `proxy::hide_driver_cursor`) and, if that fails, tells the core
//     with every action (`driver_cursor`) so the overlay labels the driver's cursor instead of adding a second.
//   - **Show Me (U9) records and replays, in part.** `record.rs` turns the user's own clicks and typing into
//     steps (never a password field's text) and `skill.rs` stores and plans them; `run_skill` replays them
//     through this proxy's gate. Replay clicks recorded screen points; it does not find the element again.
//   - **No driver download here.** The app downloads the pinned release after asking the user
//     (apps/desktop/app/computer-use.js) and checks every file against the SHA-256s in `vendor.rs`; `run()`
//     checks them again before it starts the driver. The `download` feature stays off, so this crate has no HTTP
//     client (plot.md rule 7).
//   - **No settings file.** §32.5 rule 8 puts computer use behind an off-by-default flag in v0 settings; reading
//     that flag is the core's job and `run()` takes the answer as an argument.

// The modules below arrive with U3 to U6 and U8; each is declared here when it exists, so the workspace keeps
// building in between.
pub mod classify;
pub mod driver;
pub mod hooks;
pub mod link;
pub mod proxy;
pub mod record;
pub mod redact;
pub mod skill;
pub mod vendor;

use std::path::PathBuf;

/// `mewndo-core mcp-computer --agent <name>`: the guarded proxy on stdio, for one agent, until it disconnects.
///
/// `driver_exe` is the pinned cua-driver (vendor.rs); `desk_dir` holds the running core's `core.json`. Whether
/// computer use is switched on is the core's answer to every call, not this process's: with it off, or with no
/// core, every call is refused (link.rs).
pub async fn run(
    driver_exe: PathBuf,
    desk_dir: Option<PathBuf>,
    agent: String,
) -> Result<(), String> {
    use rmcp::ServiceExt;
    if !driver_exe.is_file() {
        return Err(format!(
            "cua-driver {} is not installed at {} (turn on computer use in Mewndo's settings to download it)",
            vendor::VERSION,
            driver_exe.display()
        ));
    }
    // Never run a driver that is not byte for byte the pinned release.
    let folder = driver_exe.parent().unwrap_or(std::path::Path::new("."));
    vendor::verify_installed(folder, vendor::Arch::current()).map_err(|e| e.to_string())?;
    let id = ulid::Ulid::new().to_string().to_lowercase();
    let session = format!("mewndo-{agent}-{}", &id[id.len() - 8..]);
    let driver = driver::McpDriver::start(&driver_exe).await?;
    // U8: only Mewndo's cursor on screen. If the driver will not switch its own off, it stays, and the core's
    // overlay draws the label chip beside it instead of a second arrow.
    let driver_cursor = match proxy::hide_driver_cursor(&driver, &session).await {
        Ok(()) => false,
        Err(e) => {
            eprintln!(
                "mewndo-computer: cua-driver's own cursor stays on ({e}); Mewndo labels it instead of drawing its own"
            );
            true
        }
    };
    let gate = link::CoreGate {
        desk_dir,
        agent,
        wait: link::ANSWER_WAIT,
        driver_cursor,
    };
    let skills = gate.desk_dir.as_deref().map(skill::dir);
    let mut proxy = proxy::Proxy::new(driver, gate, session);
    if let Some(dir) = skills {
        proxy = proxy.with_skills(dir);
    }
    proxy
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| format!("the agent did not complete MCP initialize: {e}"))?
        .waiting()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
