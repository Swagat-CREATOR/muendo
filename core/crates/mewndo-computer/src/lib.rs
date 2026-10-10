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
//   - **No cursor drawing.** U5.6's `cursor.move` is a message to the core; the overlay is `mewndo-overlay`.
//   - **No Show Me.** §36.6 U9 is not built. See the note at the end of `hooks.rs` for what it would need.
//   - **No driver download.** `vendor.rs` holds the pinned version, the real SHA-256s and the verify-then-rename
//     logic; the `download` feature is off by default, so a plain build has no HTTP client (plot.md rule 7).
//   - **No unpacking.** The release is a `.zip`; verifying it is here, expanding it is the installer's step.
//   - **No settings file.** §32.5 rule 8 puts computer use behind an off-by-default flag in v0 settings; reading
//     that flag is the core's job and `run()` takes the answer as an argument.

// The modules below arrive with U3 to U6 and U8; each is declared here when it exists, so the workspace keeps
// building in between.
pub mod classify;
pub mod driver;
pub mod proxy;
pub mod vendor;
