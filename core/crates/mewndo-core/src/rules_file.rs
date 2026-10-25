// The user's rules.toml (spec §34.9 R1 and R11): read at start-up, and written when the user says "yes" on a
// Habit card.
//
// The write keeps the user's own formatting and comments (toml_edit, not a re-serialise), adds the action to
// `[allow]` or `[deny]` under a `# habit <date> agent=<kind> project=<name>` comment, and goes to a temporary file that is then renamed into
// place (plot.md rule 4), so a crash mid-write leaves the old file whole. A rules.toml that does not parse is
// never touched: the habit is refused and the user's file stays exactly as they left it.
//
// What it can't do: rules.toml has no per-project section, so a habit learned in one project is, once written,
// an `[allow]`/`[deny]` phrase in every project after the next restart. Until that restart the in-memory habit
// (mewndo-router's `Habits`) applies to the one project only.
//
// Settings > Habits lists the lines under those comments and removes one (the app's habits-file.js, the same
// temp-file-then-rename write). The core reads rules.toml only at start, so a removed rule stops applying the next
// time Mewndo starts.

use mewndo_router::CompiledRules;
use mewndo_router::habits::HabitRequest;
use std::path::Path;
use toml_edit::{Array, DocumentMut, Item, Table, Value};

/// The user's rules on top of the built-in ones. A missing file is the built-in rules; a broken one is an error
/// the caller logs, and then it uses the built-in rules (never a guess at what the user meant).
pub fn load(path: &Path) -> Result<CompiledRules, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => CompiledRules::load(Some(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CompiledRules::builtin()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Adds an accepted habit. Ok(false) when the exact phrase is already in that list.
pub fn add_habit(path: &Path, habit: &HabitRequest, date: &str) -> Result<bool, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let Some(updated) = with_habit(&text, habit, date)? else {
        return Ok(false);
    };
    write_replacing(path, &updated).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(true)
}

/// The new file text, or None when the phrase is already there. Pure, so the tests cover every shape.
pub fn with_habit(text: &str, habit: &HabitRequest, date: &str) -> Result<Option<String>, String> {
    let command = habit.command_norm.trim();
    if command.is_empty() {
        return Err("the habit has no command to write".into());
    }
    let mut doc: DocumentMut = text
        .parse()
        .map_err(|e| format!("rules.toml does not parse, so it was left alone: {e}"))?;
    let section = if habit.answer.allows() {
        "allow"
    } else {
        "deny"
    };
    let table = doc
        .entry(section)
        .or_insert_with(|| Item::Table(Table::new()))
        .as_table_like_mut()
        .ok_or_else(|| format!("rules.toml: [{section}] is not a table, so it was left alone"))?;
    let commands = table
        .entry("commands")
        .or_insert(Item::Value(Value::Array(Array::new())))
        .as_array_mut()
        .ok_or_else(|| {
            format!("rules.toml: {section}.commands is not a list, so it was left alone")
        })?;
    if commands.iter().any(|v| v.as_str() == Some(command)) {
        return Ok(None);
    }
    let mut value = Value::from(command);
    value
        .decor_mut()
        .set_prefix(format!("\n  {}\n  ", habit_comment(habit, date)));
    commands.push_formatted(value);
    commands.set_trailing("\n");
    commands.set_trailing_comma(true);
    let out = doc.to_string();
    // The file the router will read must still be one it can read.
    CompiledRules::load(Some(&out))
        .map_err(|e| format!("the new rules.toml would not load: {e}"))?;
    Ok(Some(out))
}

/// `# habit 2026-10-10 agent=claude project=shop`: the date first (files written before this have only the date),
/// then who and where, so Settings > Habits can say which agent and project taught it. The project goes last
/// because it may hold spaces. A comment is one line, so line breaks and other control characters become spaces.
fn habit_comment(habit: &HabitRequest, date: &str) -> String {
    let one_line = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect::<String>()
            .trim()
            .to_string()
    };
    let mut out = format!("# habit {}", one_line(date));
    let agent = one_line(&habit.agent_kind).replace(' ', "-");
    if !agent.is_empty() {
        out.push_str(&format!(" agent={agent}"));
    }
    let project = one_line(&habit.project);
    if !project.is_empty() {
        out.push_str(&format!(" project={project}"));
    }
    out
}

fn write_replacing(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("toml.mewndo-tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Today's date in UTC, `YYYY-MM-DD`, for the `# habit` comment.
pub fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    date_from_days((secs / 86_400) as i64)
}

// Howard Hinnant's days-to-civil algorithm.
fn date_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_router::Verdict;

    fn habit(command: &str, answer: Verdict) -> HabitRequest {
        HabitRequest {
            text: String::new(),
            options: ["yes".into(), "no".into(), "never ask".into()],
            agent_kind: "claude".into(),
            project: "shop".into(),
            sig: [0; 16],
            answer,
            command_norm: command.into(),
        }
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mewndo-rules-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_new_file_gets_the_section_and_the_comment() {
        let out = with_habit("", &habit("npm test", Verdict::Allow), "2026-10-10")
            .unwrap()
            .unwrap();
        assert_eq!(
            out,
            "[allow]\ncommands = [\n  # habit 2026-10-10 agent=claude project=shop\n  \"npm test\",\n]\n"
        );
        assert_eq!(
            CompiledRules::load(Some(&out))
                .unwrap()
                .allow_hit("npm test"),
            Some("npm test")
        );
    }

    #[test]
    fn the_users_formatting_and_comments_are_kept() {
        let mine = "# my rules\n[deny]\ncommands = [\"rm -rf ~\"]  # never\n\n[allow]\n# fast checks\ncommands = [\"cargo check\"]\n";
        let out = with_habit(mine, &habit("git push", Verdict::Deny), "2026-10-10")
            .unwrap()
            .unwrap();
        assert!(out.starts_with("# my rules\n[deny]\ncommands = [\"rm -rf ~\",\n  # habit 2026-10-10 agent=claude project=shop\n  \"git push\",\n]  # never\n"), "{out}");
        assert!(
            out.ends_with("[allow]\n# fast checks\ncommands = [\"cargo check\"]\n"),
            "{out}"
        );
    }

    #[test]
    fn a_phrase_already_there_is_not_added_twice() {
        let mine = "[allow]\ncommands = [\"npm test\"]\n";
        assert_eq!(
            with_habit(mine, &habit("npm test", Verdict::Allow), "2026-10-10"),
            Ok(None)
        );
    }

    #[test]
    fn a_broken_or_odd_file_is_left_alone() {
        for text in [
            "[allow\ncommands = 1",
            "allow = 3\n",
            "[allow]\ncommands = \"npm test\"\n",
            "[allow]\ncommands = [1, 2]\n",
        ] {
            assert!(
                with_habit(text, &habit("npm test", Verdict::Allow), "2026-10-10").is_err(),
                "{text}"
            );
        }
        let d = temp("broken");
        let path = d.join("rules.toml");
        std::fs::write(&path, "[allow\n").unwrap();
        assert!(add_habit(&path, &habit("npm test", Verdict::Allow), "2026-10-10").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[allow\n");
    }

    #[test]
    fn add_habit_writes_through_a_temp_file_and_load_reads_it_back() {
        let d = temp("write");
        let path = d.join("Mewndo").join("rules.toml");
        assert!(load(&path).is_ok(), "a missing file is the built-in rules");
        assert_eq!(
            add_habit(&path, &habit("npm test", Verdict::Allow), "2026-10-10"),
            Ok(true)
        );
        assert_eq!(
            add_habit(&path, &habit("npm test", Verdict::Allow), "2026-10-10"),
            Ok(false)
        );
        assert!(!d.join("Mewndo").join("rules.toml.mewndo-tmp").exists());
        assert_eq!(load(&path).unwrap().allow_hit("npm test"), Some("npm test"));
    }

    #[test]
    fn the_comment_stays_one_line_whatever_the_project_is_called() {
        let mut h = habit("npm test", Verdict::Allow);
        h.project = "my\nshop\r[allow]".into();
        h.agent_kind = "claude code".into();
        let out = with_habit("", &h, "2026-10-10").unwrap().unwrap();
        assert!(
            out.contains(
                "  # habit 2026-10-10 agent=claude-code project=my shop [allow]\n  \"npm test\","
            ),
            "{out}"
        );
        assert_eq!(
            CompiledRules::load(Some(&out))
                .unwrap()
                .allow_hit("npm test"),
            Some("npm test")
        );
        h.project = String::new();
        h.agent_kind = String::new();
        let bare = with_habit("", &h, "2026-10-10").unwrap().unwrap();
        assert!(bare.contains("  # habit 2026-10-10\n"), "{bare}");
    }

    #[test]
    fn dates() {
        assert_eq!(date_from_days(0), "1970-01-01");
        assert_eq!(date_from_days(20_736), "2026-10-10");
        assert_eq!(date_from_days(11_016), "2000-02-29");
    }
}
