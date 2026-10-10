// §36.6 U4: which of cua-driver's tools only look, which act on the desktop, and which the proxy keeps for itself.
//
// The rule is by name, because the tool list comes from the driver at run time and a new driver can add tools.
// Anything this file does not recognise as a read is an act: a tool nobody has classified gets the full guard,
// never a free pass.
//
// Read: the name starts with `get_`, `list_`, `verify_` or `parse_`, or contains `screenshot`. There is no
// `screenshot` tool in cua-driver 0.34.0 (docs/decisions.md, "cua-driver" 4: it was folded into
// `get_window_state` and `get_desktop_state`), so that keyword matches nothing today; it stays so a later driver
// that brings the name back is still a read.
//
// Act, although the name looks harmless:
//   `clipboard_read`  the clipboard is where passwords are pasted from, so reading it asks the user.
//   `escalate_session`  asks the driver for more authority (cua-driver's own risk classes, `authorization.rs`).
//   `set_window_frame`, `start_session`, `end_session`  change the desktop or the driver's state.
//
// Hidden: the agent-cursor settings. Mewndo turns the driver's cursor off and draws its own (U7, U8); an agent
// that could turn it back on, or restyle it, would put two cursors on screen or make Mewndo's label lie.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// Looks without changing anything. Still passes the core's gate (computer use on, not paused), but makes no
    /// card.
    Read,
    /// Changes something on the user's desktop: the full guard.
    Act,
    /// Not offered to the agent at all.
    Hidden,
}

const READ_PREFIXES: &[&str] = &["get_", "list_", "verify_", "parse_"];
const READ_WORDS: &[&str] = &["screenshot"];
/// Reads in name only.
const ACT_ANYWAY: &[&str] = &["clipboard_read"];
const HIDDEN: &[&str] = &[
    "set_agent_cursor_enabled",
    "set_agent_cursor_motion",
    "set_agent_cursor_theme",
];

/// The driver's tool name, without Mewndo's `computer_` prefix.
pub fn classify(tool: &str) -> Class {
    let tool = tool.trim().to_ascii_lowercase();
    if HIDDEN.contains(&tool.as_str()) {
        return Class::Hidden;
    }
    if ACT_ANYWAY.contains(&tool.as_str()) {
        return Class::Act;
    }
    if READ_PREFIXES.iter().any(|p| tool.starts_with(p))
        || READ_WORDS.iter().any(|w| tool.contains(w))
    {
        return Class::Read;
    }
    Class::Act
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every tool of cua-driver 0.34.0's portable surface (docs/samples/cua/tools.json), classified.
    #[test]
    fn every_portable_tool_has_the_class_it_should() {
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../../../../docs/samples/cua/tools.json")).unwrap();
        let names: Vec<&str> = sample["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 29);
        let of = |class| -> Vec<&str> {
            names
                .iter()
                .copied()
                .filter(|n| classify(n) == class)
                .collect()
        };
        assert_eq!(
            of(Class::Read),
            [
                "get_agent_cursor_state",
                "get_cursor_position",
                "get_desktop_state",
                "get_screen_size",
                "get_session",
                "get_session_state",
                "get_window_state",
                "list_apps",
                "list_sessions",
                "list_windows",
                "parse_visual_regions",
                "verify_state",
            ]
        );
        assert_eq!(
            of(Class::Hidden),
            [
                "set_agent_cursor_enabled",
                "set_agent_cursor_motion",
                "set_agent_cursor_theme"
            ]
        );
        for act in [
            "click",
            "clipboard_read",
            "clipboard_write",
            "drag",
            "end_session",
            "escalate_session",
            "hotkey",
            "invoke_menu",
            "move_cursor",
            "press_key",
            "scroll",
            "set_window_frame",
            "start_session",
            "type_text",
        ] {
            assert_eq!(classify(act), Class::Act, "{act}");
        }
    }

    #[test]
    fn unknown_tools_are_acts_and_screenshot_stays_a_read() {
        assert_eq!(classify("launch_rockets"), Class::Act);
        assert_eq!(classify(""), Class::Act);
        assert_eq!(
            classify("screenshot"),
            Class::Read,
            "a later driver may bring the name back"
        );
        assert_eq!(classify("window_screenshot"), Class::Read);
        assert_eq!(classify("GET_SCREEN_SIZE"), Class::Read);
    }
}
