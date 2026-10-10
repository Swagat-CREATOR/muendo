// G1: what to start, and how (spec §33.10 Part G step 1).
//
// Two jobs, kept apart on purpose:
//
//   `resolve`  touches the world: it asks the `which` crate where `claude`, `codex` or `cursor-agent` is.
//   `plan`     touches nothing: given a resolved path, it works out the program, the arguments, the working
//              directory and the environment. No disk, no clock, no platform detection of its own.
//
// `plan` takes the platform as an argument rather than reading `cfg!(windows)`, which is the whole reason the
// Windows-only decision below can be tested in WSL (§32.5 rule 5). A test that only ran on Windows would be a
// test nobody runs.
//
// The Windows-only decision: ConPTY starts a *process*, so it needs something `CreateProcess` can run. A
// `.cmd`, `.bat` or `.ps1` is a script, not an image; handing one to ConPTY fails with "not a valid Win32
// application". npm and many agent installers put exactly such a shim on PATH - `claude.cmd` next to
// `claude.ps1` - so this is the normal case on Windows, not the edge case. The fix is to start the interpreter
// and pass the script to it (§33.10 Part G step 1).

use std::path::{Path, PathBuf};

/// `MEWNDO_LANE_ID` is how a hook that fires *inside* a lane finds out which lane it is in (§33.10 Part G
/// step 4). The forwarder reads it from its own environment and puts it in `HookRequest::lane_id`; the whole
/// account has the plugin installed, so without this a lane's hooks would look like any other terminal's.
pub const LANE_ID_ENV: &str = "MEWNDO_LANE_ID";

/// Which operating system the lane will run on. An argument, not a `cfg!`, so both branches are testable
/// everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    /// The platform this build will actually run on.
    pub fn host() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }
}

/// Why a lane is not started directly, when it is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wrapper {
    /// An executable image: ConPTY starts it itself.
    None,
    /// `.cmd` or `.bat`: `cmd.exe /d /s /c "<path>" <args>`.
    Cmd,
    /// `.ps1`: still through `cmd.exe /d /s /c`, because that is what §33.10 Part G step 1 says to start, but
    /// with PowerShell named inside it. `cmd.exe /c script.ps1` would hand the file to its shell association,
    /// which by default *opens it in Notepad* rather than running it - a lane that silently never starts.
    PowerShell,
}

/// What `.cmd`, `.bat` and `.ps1` mean. Windows compares extensions case-insensitively, and an installer is
/// perfectly entitled to write `Claude.CMD`.
pub fn wrapper_for(path: &Path, platform: Platform) -> Wrapper {
    if platform != Platform::Windows {
        return Wrapper::None;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "cmd" | "bat" => Wrapper::Cmd,
        "ps1" => Wrapper::PowerShell,
        _ => Wrapper::None,
    }
}

/// Everything needed to spawn a lane's child, with nothing left to decide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Added to, or replacing, the inherited environment - see [`LaunchPlan::env`]. Always contains
    /// `MEWNDO_LANE_ID`.
    pub env: Vec<(String, String)>,
    pub wrapper: Wrapper,
}

/// What Mewndo is asked to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneSpec {
    /// The agent's command as the user would type it: `claude`, `codex`, `cursor-agent`.
    pub program: String,
    pub args: Vec<String>,
    /// The protected folder the lane runs in ("start Claude in shop").
    pub cwd: PathBuf,
    /// Anything the core wants the agent to see as well as `MEWNDO_LANE_ID`: the brief's path, a save point id.
    pub env: Vec<(String, String)>,
}

impl LaneSpec {
    pub fn new(program: impl Into<String>, cwd: impl Into<PathBuf>) -> LaneSpec {
        LaneSpec {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> LaneSpec {
        self.args.push(arg.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> LaneSpec {
        self.env.push((key.into(), value.into()));
        self
    }
}

/// `resolved` is the agent executable [`resolve`] found. `lane_id` becomes `MEWNDO_LANE_ID`.
///
/// Pure. Given the same five arguments it gives the same plan on every platform, which is why the Windows
/// wrapping is covered by `cargo test` in WSL.
pub fn plan(spec: &LaneSpec, resolved: &Path, lane_id: &str, platform: Platform) -> LaunchPlan {
    let wrapper = wrapper_for(resolved, platform);
    let path = resolved.to_string_lossy().to_string();
    let (program, mut args) = match wrapper {
        Wrapper::None => (path, Vec::new()),
        // `/d` skips AutoRun commands out of the registry, which could otherwise print into the lane or
        // change its directory. `/s` fixes the quoting rule for the rest of the line, so a path with spaces
        // inside quotes is taken whole. Both are from §33.10 Part G step 1.
        Wrapper::Cmd => (
            "cmd.exe".to_string(),
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                quote(&path),
            ],
        ),
        Wrapper::PowerShell => (
            "cmd.exe".to_string(),
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "powershell".to_string(),
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                quote(&path),
            ],
        ),
    };
    args.extend(spec.args.iter().cloned());

    // The lane id is appended last and wins, so a caller cannot set it by accident and break the link
    // between a hook session and its lane (§33.10 Part G step 4).
    let mut env: Vec<(String, String)> = spec
        .env
        .iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case(LANE_ID_ENV))
        .cloned()
        .collect();
    env.push((LANE_ID_ENV.to_string(), lane_id.to_string()));

    LaunchPlan {
        program,
        args,
        cwd: spec.cwd.clone(),
        env,
        wrapper,
    }
}

/// Quote a path for a `cmd.exe /s /c` line. With `/s`, cmd strips the first and last quote of the line and
/// takes everything between them literally, so one pair around the path is right and is all that is needed.
/// A path cannot contain `"` on Windows, so there is nothing to escape.
fn quote(path: &str) -> String {
    format!("\"{path}\"")
}

/// Where the agent's executable is, as the user's own shell would find it (`PATH`, and `PATHEXT` on Windows).
///
/// Not pure: this is the one function in the file that looks at the disk. An absolute or relative path with a
/// separator in it is taken as given, which is what lets a user point a lane at a build they have not
/// installed.
pub fn resolve(program: &str) -> Result<PathBuf, LaunchError> {
    if program.is_empty() {
        return Err(LaunchError::NotFound(String::new()));
    }
    which::which(program).map_err(|_| LaunchError::NotFound(program.to_string()))
}

#[derive(Debug)]
pub enum LaunchError {
    /// `which` could not find it. The Agents tab shows "Not found" (§22.2) rather than an error: an agent the
    /// user has not installed is not a failure.
    NotFound(String),
    Io(std::io::Error),
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            LaunchError::NotFound(p) if p.is_empty() => write!(f, "no program was named"),
            LaunchError::NotFound(p) => write!(f, "{p} is not on PATH"),
            LaunchError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LaunchError {}

impl From<std::io::Error> for LaunchError {
    fn from(e: std::io::Error) -> LaunchError {
        LaunchError::Io(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> LaneSpec {
        LaneSpec::new("claude", r"C:\work\shop").arg("--continue")
    }

    // The §33.10 Part G step 1 test: the .cmd / .bat / .ps1 wrapping decision.
    #[test]
    fn a_cmd_or_bat_shim_is_started_through_cmd_exe_and_a_real_exe_is_not() {
        let direct = plan(
            &spec(),
            Path::new(r"C:\Program Files\claude\claude.exe"),
            "L1",
            Platform::Windows,
        );
        assert_eq!(direct.wrapper, Wrapper::None);
        assert_eq!(direct.program, r"C:\Program Files\claude\claude.exe");
        assert_eq!(
            direct.args,
            ["--continue"],
            "no wrapper, no extra arguments"
        );

        for shim in [
            r"C:\npm\claude.cmd",
            r"C:\npm\claude.bat",
            r"C:\npm\CLAUDE.CMD",
        ] {
            let p = plan(&spec(), Path::new(shim), "L1", Platform::Windows);
            assert_eq!(p.wrapper, Wrapper::Cmd, "{shim}");
            assert_eq!(p.program, "cmd.exe", "{shim}: ConPTY cannot run a script");
            assert_eq!(
                p.args,
                ["/d", "/s", "/c", &format!("\"{shim}\""), "--continue"],
                "{shim}"
            );
        }
    }

    #[test]
    fn a_ps1_goes_through_cmd_exe_but_names_powershell() {
        let p = plan(
            &spec(),
            Path::new(r"C:\npm\claude.ps1"),
            "L1",
            Platform::Windows,
        );
        assert_eq!(p.wrapper, Wrapper::PowerShell);
        assert_eq!(
            p.program, "cmd.exe",
            "§33.10 Part G step 1: cmd.exe /d /s /c"
        );
        assert_eq!(
            p.args,
            [
                "/d",
                "/s",
                "/c",
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                r#""C:\npm\claude.ps1""#,
                "--continue",
            ]
        );
    }

    #[test]
    fn on_unix_nothing_is_wrapped_whatever_the_extension_says() {
        for path in [
            "/usr/bin/claude",
            "/usr/bin/claude.cmd",
            "/usr/bin/claude.ps1",
        ] {
            let p = plan(&spec(), Path::new(path), "L1", Platform::Unix);
            assert_eq!(p.wrapper, Wrapper::None, "{path}");
            assert_eq!(p.program, path);
            assert_eq!(p.args, ["--continue"]);
        }
    }

    #[test]
    fn a_path_with_spaces_is_quoted_once_for_slash_s() {
        let p = plan(
            &LaneSpec::new("claude", "/tmp"),
            Path::new(r"C:\Program Files\My Agents\claude.cmd"),
            "L1",
            Platform::Windows,
        );
        assert_eq!(p.args[3], r#""C:\Program Files\My Agents\claude.cmd""#);
        assert_eq!(
            p.args[3].matches('"').count(),
            2,
            "one pair, not nested quoting"
        );
    }

    // The §33.10 Part G step 4 half that can be checked without a process: the plan always carries the id.
    #[test]
    fn the_plan_always_carries_mewndo_lane_id_and_a_caller_cannot_overwrite_it() {
        let s = LaneSpec::new("claude", "/tmp")
            .env("MEWNDO_BRIEF", "/tmp/brief.md")
            .env("MEWNDO_LANE_ID", "a-caller-tried-this")
            .env("mewndo_lane_id", "and-this");
        let p = plan(&s, Path::new("/usr/bin/claude"), "01JLANE", Platform::Unix);
        assert_eq!(
            p.env,
            [
                ("MEWNDO_BRIEF".to_string(), "/tmp/brief.md".to_string()),
                ("MEWNDO_LANE_ID".to_string(), "01JLANE".to_string()),
            ],
            "the caller's own lane id is dropped, whatever its case"
        );
        assert_eq!(p.cwd, PathBuf::from("/tmp"));
    }

    #[test]
    fn resolve_finds_a_program_on_path_and_says_so_plainly_when_it_cannot() {
        let found = resolve(if cfg!(windows) { "cmd" } else { "sh" }).expect("a shell is on PATH");
        assert!(found.is_absolute(), "{found:?}");
        let missing = resolve("mewndo-no-such-agent-9f3a").unwrap_err();
        assert!(matches!(missing, LaunchError::NotFound(_)));
        assert_eq!(
            missing.to_string(),
            "mewndo-no-such-agent-9f3a is not on PATH"
        );
        assert_eq!(resolve("").unwrap_err().to_string(), "no program was named");
    }
}
