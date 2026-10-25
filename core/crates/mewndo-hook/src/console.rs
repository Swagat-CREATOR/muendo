// Which process owns the agent's terminal (`hook.request`'s `console_pid`).
//
// An agent runs its hook through a shell more often than not: Claude Code on Windows starts it with Git Bash or
// cmd.exe, and a user's own hooks.json may wrap it in PowerShell. So the forwarder's parent is usually a shell
// that lives for exactly as long as this hook, and the agent is a level or two above it. This walks up from the
// parent, skipping those launcher shells, and names the first other process: node.exe, claude.exe, codex.exe,
// cursor-agent.exe. The core needs that process's id to type a message the user confirmed into the agent's
// terminal when it is idle at its prompt (mewndo-core's typing.rs); it is never used for anything else.
//
// Honest limits (§28.10): a parent that has exited may have had its id reused by an unrelated process, which a
// snapshot cannot tell apart; and an agent started *from* a shell the user keeps open (`bash -c claude`) is named
// correctly only because the walk stops at the first process that is not a shell. It is a hint, never a key.

/// Shells and console hosts that start a hook and are gone when it ends. Compared without case.
pub const LAUNCHERS: [&str; 7] = [
    "cmd.exe",
    "bash.exe",
    "sh.exe",
    "powershell.exe",
    "pwsh.exe",
    "conhost.exe",
    "wsl.exe",
];

/// How many launcher shells the walk may skip before it gives up. Two is the most seen in practice (Git Bash's
/// bash.exe under its own sh.exe); four leaves room without walking up into Explorer.
pub const MAX_SKIPPED: usize = 4;

/// True for a launcher shell. `exe` may be a bare name or a full path.
pub fn is_launcher(exe: &str) -> bool {
    let name = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    LAUNCHERS.iter().any(|l| l.eq_ignore_ascii_case(name))
}

/// The agent in `chain`, the forwarder's ancestors nearest first (its parent, then that one's parent...): the first
/// that is not a launcher shell, within `MAX_SKIPPED` shells. None when the chain is empty, is all shells, or runs
/// past the limit, because a guess would type into the wrong terminal.
pub fn pick(chain: &[(u32, String)]) -> Option<u32> {
    chain
        .iter()
        .take(MAX_SKIPPED + 1)
        .find(|(_, exe)| !is_launcher(exe))
        .map(|(pid, _)| *pid)
        .filter(|pid| *pid != 0)
}

/// The agent's process id, from one Toolhelp32 snapshot. None off Windows.
#[cfg(windows)]
pub fn console_pid() -> Option<u32> {
    pick(&win::ancestors(std::process::id(), MAX_SKIPPED + 1))
}

#[cfg(not(windows))]
pub fn console_pid() -> Option<u32> {
    None
}

/// The Toolhelp32 calls, declared here for the same reason pipe.rs declares WaitNamedPipeW: the forwarder carries
/// no windows-sys (see Cargo.toml).
#[cfg(windows)]
mod win {
    use std::collections::HashMap;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: isize = -1;
    const MAX_PATH: usize = 260;

    /// PROCESSENTRY32W, field for field (tlhelp32.h).
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        exe: [u16; MAX_PATH],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    /// Up to `levels` ancestors of `pid`, nearest first, as (pid, exe name). Stops at a process the snapshot does
    /// not have, at pid 0, and at a cycle (a reused id can point back down the chain).
    pub fn ancestors(pid: u32, levels: usize) -> Vec<(u32, String)> {
        let processes = snapshot();
        let mut chain = Vec::new();
        let mut at = pid;
        while chain.len() < levels {
            let Some((parent, _)) = processes.get(&at) else {
                break;
            };
            let parent = *parent;
            if parent == 0 || parent == pid || chain.iter().any(|(p, _)| *p == parent) {
                break;
            }
            let Some((_, exe)) = processes.get(&parent) else {
                break;
            };
            chain.push((parent, exe.clone()));
            at = parent;
        }
        chain
    }

    /// pid -> (parent pid, exe name) for every process. Empty when the snapshot fails.
    fn snapshot() -> HashMap<u32, (u32, String)> {
        let mut out = HashMap::new();
        // SAFETY: a plain call; INVALID_HANDLE_VALUE means failure and nothing is read in that case.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE || snap == 0 {
            return out;
        }
        // SAFETY: an all-zero PROCESSENTRY32W is valid once `size` is set, which is what the API asks for.
        let mut entry: ProcessEntry = unsafe { std::mem::zeroed() };
        entry.size = size_of::<ProcessEntry>() as u32;
        // SAFETY: an open snapshot handle and a writable entry of the declared size.
        let mut ok = unsafe { Process32FirstW(snap, &mut entry) };
        while ok != 0 {
            let len = entry.exe.iter().position(|c| *c == 0).unwrap_or(MAX_PATH);
            let exe = String::from_utf16_lossy(&entry.exe[..len]);
            out.insert(entry.pid, (entry.parent, exe));
            // SAFETY: as above.
            ok = unsafe { Process32NextW(snap, &mut entry) };
        }
        // SAFETY: a handle this function owns, closed once.
        unsafe { CloseHandle(snap) };
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(names: &[(u32, &str)]) -> Vec<(u32, String)> {
        names.iter().map(|(p, n)| (*p, n.to_string())).collect()
    }

    #[test]
    fn the_first_process_that_is_not_a_launcher_shell_is_the_agent() {
        // Claude Code runs a hook through Git Bash: hook <- bash <- claude.
        assert_eq!(
            pick(&chain(&[
                (20, "bash.exe"),
                (10, "claude.exe"),
                (5, "explorer.exe")
            ])),
            Some(10)
        );
        // Started by the agent itself, with no shell in between.
        assert_eq!(pick(&chain(&[(11, "node.exe"), (3, "cmd.exe")])), Some(11));
        // Case and full paths do not matter.
        assert_eq!(
            pick(&chain(&[
                (30, r"C:\Windows\System32\CMD.EXE"),
                (31, "PowerShell.exe"),
                (32, "Codex.exe")
            ])),
            Some(32)
        );
        assert!(
            is_launcher("/usr/bin/sh.exe") && is_launcher("WSL.EXE") && is_launcher("conhost.exe")
        );
        assert!(!is_launcher("cursor-agent.exe") && !is_launcher("bash"));
    }

    #[test]
    fn no_agent_is_better_than_a_guess() {
        assert_eq!(pick(&[]), None);
        assert_eq!(
            pick(&chain(&[(1, "cmd.exe"), (2, "pwsh.exe")])),
            None,
            "all shells"
        );
        // Four shells may be skipped; a fifth means the walk gives up rather than name what is above them.
        let mut deep = chain(&[
            (1, "sh.exe"),
            (2, "bash.exe"),
            (3, "cmd.exe"),
            (4, "pwsh.exe"),
            (5, "claude.exe"),
        ]);
        assert_eq!(pick(&deep), Some(5));
        deep.insert(0, (9, "conhost.exe".to_string()));
        assert_eq!(pick(&deep), None);
        assert_eq!(
            pick(&chain(&[(0, "node.exe")])),
            None,
            "pid 0 is the idle process"
        );
    }

    #[test]
    fn off_windows_there_is_no_console_pid() {
        if cfg!(not(windows)) {
            assert_eq!(console_pid(), None);
        }
    }
}
