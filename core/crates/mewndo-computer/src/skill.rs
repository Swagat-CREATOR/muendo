// Show Me skills (spec §36.5, §36.6 U9): what a recording is saved as, where it lives, and how an agent's
// `run_skill` turns it back into cua-driver calls.
//
// A skill is one JSON file in `<desk folder>/skills/` (%LOCALAPPDATA%\Mewndo\skills on Windows): Mewndo's own app
// data, never inside a protected folder (plot.md rule 1). The app writes it (apps/desktop/app/skills.js, the
// same format, checked against `docs/samples/showme/skill.json` from both sides) and the proxy only reads it.
//
// Steps name what was clicked by the element's name and control type when UI Automation gave one (§36.5), and
// always carry the screen point too, because replay clicks the point: resolving the name to an element again at
// replay time (cua-driver's `element_token`) is not built.
//
// Text typed into a password field, into a password manager, or into a field Mewndo could not check is never
// stored: the step says `secret: true` and has no text and no length. Replay stops at such a step and tells the
// agent the user has to type it.

use rmcp::model::JsonObject;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The file format's version. A file with another one is refused rather than guessed at.
pub const FORMAT: u32 = 1;
/// The longest name a skill may have.
pub const MAX_NAME: usize = 80;
/// The most steps one skill may hold (a 10-minute recording comes nowhere near it).
pub const MAX_STEPS: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Skill {
    pub format: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub created_ms: u64,
    #[serde(default)]
    pub updated_ms: u64,
    pub steps: Vec<Step>,
}

/// What a click landed on, from UI Automation at the moment of the click.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Element {
    pub name: String,
    #[serde(default)]
    pub control_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
    /// The user brought this window to the front. Replay does not switch windows (cua-driver has no tool for it);
    /// the step tells the agent and the user which app should be in front.
    Focus {
        app: String,
        #[serde(default)]
        window: String,
    },
    Click {
        x: i32,
        y: i32,
        #[serde(default = "left")]
        button: String,
        #[serde(default = "one")]
        count: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<Element>,
        #[serde(default)]
        app: String,
        /// The point was on the primary display. Replay can only aim at the primary display (cua-driver 0.34.0's
        /// one portable desktop target), so a click recorded elsewhere is refused at replay.
        #[serde(default = "yes")]
        on_primary: bool,
    },
    Type {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        /// Typed where it must not be recorded: nothing about the text is kept.
        #[serde(default, skip_serializing_if = "is_false")]
        secret: bool,
    },
    /// A named key (`Enter`, `Tab`) or a chord (`c` with `ctrl`).
    Key {
        key: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        modifiers: Vec<String>,
    },
}

fn left() -> String {
    "left".into()
}
fn one() -> u8 {
    1
}
fn yes() -> bool {
    true
}
fn is_false(b: &bool) -> bool {
    !*b
}

impl Step {
    /// The step in words, for the review screen, the agent's report and the card.
    pub fn says(&self) -> String {
        match self {
            Step::Focus { app, window } if window.is_empty() => format!("switch to {app}"),
            Step::Focus { app, window } => format!("switch to {app} ({window})"),
            Step::Click {
                x,
                y,
                button,
                count,
                element,
                ..
            } => {
                let how = match (button.as_str(), count) {
                    ("right", _) => "right-click",
                    (_, 2) => "double-click",
                    _ => "click",
                };
                match element {
                    Some(e) if !e.name.is_empty() => format!("{how} \"{}\" at {x}, {y}", e.name),
                    _ => format!("{how} at {x}, {y}"),
                }
            }
            Step::Type { secret: true, .. } => "type something private (not recorded)".into(),
            Step::Type { text, .. } => format!("type \"{}\"", text.as_deref().unwrap_or_default()),
            Step::Key { key, modifiers } if modifiers.is_empty() => format!("press {key}"),
            Step::Key { key, modifiers } => format!("press {}+{key}", modifiers.join("+")),
        }
    }
}

impl Step {
    /// The step for an Inbox card: never the typed text (the card shows the length, redact.rs), never a single
    /// typed character.
    pub fn card_words(&self) -> String {
        match self {
            Step::Type { .. } => "type text".into(),
            Step::Key { modifiers, .. } if modifiers.is_empty() && !self.named_key() => {
                "press a key".into()
            }
            other => other.says(),
        }
    }

    fn named_key(&self) -> bool {
        matches!(self, Step::Key { key, .. } if key.chars().count() > 1)
    }
}

/// Lowercase letters, digits and dashes: the skill's file name, and a name an agent can type.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(60);
    if out.is_empty() { "skill".into() } else { out }
}

/// Why a skill file was refused.
pub fn check(skill: &Skill) -> Result<(), String> {
    if skill.format != FORMAT {
        return Err(format!(
            "skill format {} is not one this Mewndo reads ({FORMAT})",
            skill.format
        ));
    }
    let name = skill.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(format!(
            "a skill needs a name of 1 to {MAX_NAME} characters with no control characters"
        ));
    }
    if skill.steps.len() > MAX_STEPS {
        return Err(format!("a skill holds at most {MAX_STEPS} steps"));
    }
    for (i, step) in skill.steps.iter().enumerate() {
        if let Step::Type {
            text: Some(_),
            secret: true,
        } = step
        {
            return Err(format!(
                "step {} is marked private but still holds text",
                i + 1
            ));
        }
    }
    Ok(())
}

pub fn parse(text: &str) -> Result<Skill, String> {
    let skill: Skill = serde_json::from_str(text).map_err(|e| format!("not a skill file: {e}"))?;
    check(&skill)?;
    Ok(skill)
}

/// `<desk folder>/skills`.
pub fn dir(desk_dir: &Path) -> PathBuf {
    desk_dir.join("skills")
}

/// Every readable skill in `dir`, by name. Links are skipped, never followed (plot.md rule 2); unreadable files are
/// skipped too, so one bad file does not hide the rest.
pub fn list(dir: &Path) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut skills: Vec<Skill> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| parse(&t).ok())
        .collect();
    skills.sort_by_key(|s| s.name.to_lowercase());
    skills
}

/// The skill an agent named: by its name (any case) or its slug.
pub fn find(dir: &Path, name: &str) -> Result<Skill, String> {
    let want = name.trim();
    let skills = list(dir);
    skills
        .iter()
        .find(|s| s.name.trim().eq_ignore_ascii_case(want))
        .or_else(|| skills.iter().find(|s| slug(&s.name) == slug(want)))
        .cloned()
        .ok_or_else(|| {
            let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
            if names.is_empty() {
                format!("there is no skill called \"{want}\": the user has not recorded any skills")
            } else {
                format!(
                    "there is no skill called \"{want}\". The skills are: {}",
                    names.join(", ")
                )
            }
        })
}

/// One driver call a step becomes.
#[derive(Debug, Clone, PartialEq)]
pub struct Planned {
    /// The step's number, from 1.
    pub step: usize,
    pub tool: &'static str,
    pub args: JsonObject,
    pub says: String,
}

/// A step that will not be replayed, and why. Replay stops there.
#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    pub step: usize,
    pub why: String,
}

/// The replay plan: the driver calls, in order, up to the first step that cannot be replayed. `Focus` steps make
/// no call. Every call still goes through the proxy's gate one by one, so every act is classified and asked about
/// as if the agent had made it.
pub fn plan(skill: &Skill) -> (Vec<Planned>, Option<Stop>) {
    let desktop = json!({"kind": "desktop", "display_id": "primary"});
    let mut out = Vec::new();
    for (i, step) in skill.steps.iter().enumerate() {
        let n = i + 1;
        let stop = |why: &str| {
            Some(Stop {
                step: n,
                why: why.to_string(),
            })
        };
        let (tool, args) = match step {
            Step::Focus { .. } => continue,
            Step::Click {
                on_primary: false, ..
            } => {
                return (
                    out,
                    stop(
                        "it clicks on another display, and replay can only aim at the primary display",
                    ),
                );
            }
            Step::Click {
                x,
                y,
                button,
                count,
                ..
            } => (
                "click",
                json!({"x": x, "y": y, "button": button, "count": count, "target": desktop}),
            ),
            Step::Type { secret: true, .. } | Step::Type { text: None, .. } => {
                return (
                    out,
                    stop(
                        "the user typed something private here (a password field or a password manager), which \
                         Mewndo never records. Ask the user to type it, then run the rest yourself",
                    ),
                );
            }
            Step::Type {
                text: Some(text), ..
            } => ("type_text", json!({"text": text, "target": desktop})),
            Step::Key { key, modifiers } if modifiers.is_empty() => {
                ("press_key", json!({"key": key, "target": desktop}))
            }
            Step::Key { key, modifiers } => (
                "press_key",
                json!({"key": key, "modifiers": modifiers, "target": desktop}),
            ),
        };
        let Value::Object(args) = args else {
            unreachable!("json! of an object")
        };
        out.push(Planned {
            step: n,
            tool,
            args,
            says: step.says(),
        });
    }
    (out, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../../../docs/samples/showme/skill.json");

    #[test]
    fn the_sample_file_is_the_format_both_sides_write() {
        let skill = parse(SAMPLE).unwrap();
        assert_eq!(skill.name, "Send the weekly report");
        assert_eq!(skill.steps.len(), 6);
        assert_eq!(
            skill.steps[1],
            Step::Click {
                x: 412,
                y: 230,
                button: "left".into(),
                count: 1,
                element: Some(Element {
                    name: "New mail".into(),
                    control_type: "Button".into()
                }),
                app: "OUTLOOK.EXE".into(),
                on_primary: true,
            }
        );
        assert_eq!(
            skill.steps[3],
            Step::Type {
                text: None,
                secret: true
            }
        );
        // Round trip: what Rust writes, Rust reads back the same.
        let again = parse(&serde_json::to_string(&skill).unwrap()).unwrap();
        assert_eq!(again, skill);
    }

    #[test]
    fn a_private_step_never_holds_text_and_bad_files_are_refused() {
        let mut skill = parse(SAMPLE).unwrap();
        skill.steps[3] = Step::Type {
            text: Some("hunter2".into()),
            secret: true,
        };
        assert!(check(&skill).unwrap_err().contains("private"));
        let printed = serde_json::to_string(&Step::Type {
            text: None,
            secret: true,
        })
        .unwrap();
        assert_eq!(
            printed, r#"{"kind":"type","secret":true}"#,
            "no text key at all"
        );

        for bad in [
            r#"{"format":2,"name":"x","steps":[]}"#,
            r#"{"format":1,"name":"  ","steps":[]}"#,
            r#"{"format":1,"name":"a\u0007b","steps":[]}"#,
            r#"{"format":1,"name":"x","steps":[{"kind":"teleport"}]}"#,
            "not json",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
        let long = format!(r#"{{"format":1,"name":"{}","steps":[]}}"#, "a".repeat(81));
        assert!(parse(&long).is_err());
    }

    #[test]
    fn names_become_slugs() {
        assert_eq!(slug("Send the weekly report"), "send-the-weekly-report");
        assert_eq!(slug("  Ünïcode!! & stuff -- "), "n-code-stuff");
        assert_eq!(slug("???"), "skill");
        assert_eq!(slug(&"x".repeat(100)).len(), 60);
    }

    #[test]
    fn replay_plans_driver_calls_and_stops_at_a_private_step() {
        let skill = parse(SAMPLE).unwrap();
        let (calls, stop) = plan(&skill);
        let tools: Vec<_> = calls.iter().map(|c| (c.step, c.tool)).collect();
        assert_eq!(
            tools,
            [(2, "click"), (3, "type_text")],
            "focus makes no call"
        );
        assert_eq!(calls[0].args["x"], 412);
        assert_eq!(calls[0].args["target"]["kind"], "desktop");
        assert_eq!(calls[0].says, "click \"New mail\" at 412, 230");
        assert_eq!(calls[1].args["text"], "boss@example.com");
        let stop = stop.unwrap();
        assert_eq!(stop.step, 4);
        assert!(stop.why.contains("never records"), "{}", stop.why);
    }

    #[test]
    fn keys_chords_and_other_displays() {
        let skill = Skill {
            format: FORMAT,
            name: "k".into(),
            description: String::new(),
            created_ms: 0,
            updated_ms: 0,
            steps: vec![
                Step::Key {
                    key: "Enter".into(),
                    modifiers: vec![],
                },
                Step::Key {
                    key: "s".into(),
                    modifiers: vec!["ctrl".into()],
                },
                Step::Click {
                    x: -1200,
                    y: 40,
                    button: "right".into(),
                    count: 1,
                    element: None,
                    app: String::new(),
                    on_primary: false,
                },
                Step::Key {
                    key: "Tab".into(),
                    modifiers: vec![],
                },
            ],
        };
        let (calls, stop) = plan(&skill);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].args.get("modifiers"), None);
        assert_eq!(calls[1].args["modifiers"], json!(["ctrl"]));
        assert_eq!(calls[1].says, "press ctrl+s");
        assert_eq!(stop.unwrap().step, 3);
        assert_eq!(skill.steps[2].says(), "right-click at -1200, 40");
    }

    #[test]
    fn skills_are_found_by_name_or_slug_and_links_are_not_followed() {
        let d = std::env::temp_dir().join(format!("mewndo-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert!(find(&d, "x").unwrap_err().contains("not recorded any"));
        std::fs::write(d.join("send-the-weekly-report.json"), SAMPLE).unwrap();
        std::fs::write(d.join("broken.json"), "{").unwrap();
        std::fs::write(d.join("notes.txt"), SAMPLE).unwrap();
        assert_eq!(
            list(&d).len(),
            1,
            "the broken file and the .txt are skipped"
        );
        assert_eq!(
            find(&d, "SEND THE WEEKLY REPORT").unwrap().name,
            "Send the weekly report"
        );
        assert_eq!(
            find(&d, "send-the-weekly-report").unwrap().name,
            "Send the weekly report"
        );
        let missing = find(&d, "nope").unwrap_err();
        assert!(missing.contains("Send the weekly report"), "{missing}");
        #[cfg(unix)]
        {
            let outside = d.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(
                outside.join("other.json"),
                SAMPLE.replace("weekly", "linked"),
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.join("other.json"), d.join("linked.json")).unwrap();
            assert_eq!(list(&d).len(), 1, "a link is not followed");
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
