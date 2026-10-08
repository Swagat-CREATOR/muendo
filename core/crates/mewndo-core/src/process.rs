// Process control for Brake (spec §24.3): freeze a local agent's whole process tree, resume it, or end it.
// Windows only (Mewndo v1 is a Windows app).
//
// Freeze uses NtSuspendProcess (ntdll; undocumented but used by every process tool), which suspends all of a
// process's threads at once. The tree is re-read after each pass until no new process turns up, so a child
// spawned while freezing is caught too. A write already in progress finishes first; the journal captures it.
// Resume thaws every thread fully (ResumeThread until its suspend count is 0), so a tree frozen twice, or by an
// earlier run of the core, still comes back with one resume. End freezes the tree, then terminates every process.
//
// Never touched: system processes (pids 0 and 4, session 0 services, critical processes, the Windows shell and its
// helpers) and Mewndo itself (this core, every process it runs under, and every process running the app's
// program). A tree is a process and its descendants by parent id, with the parent started before the child, so a
// reused parent id can't pull an unrelated process in.
use serde::{Deserialize, Serialize};

/// A process in a tree that was left alone, and why.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Skipped {
    pub pid: u32,
    pub name: String,
    pub reason: String,
}

/// What a freeze, resume or end did: the processes it acted on (the root first) and the ones it left alone.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub pids: Vec<u32>,
    pub skipped: Vec<Skipped>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    Freeze,
    Resume,
    End,
}

#[cfg(not(windows))]
pub fn control(_root: u32, _action: Action) -> std::io::Result<Report> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "process control runs on Windows (Mewndo v1 is a Windows app)",
    ))
}

#[cfg(windows)]
pub use windows::control;

#[cfg(windows)]
mod windows {
    use super::{Action, Report, Skipped};
    use std::collections::{HashMap, HashSet};
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, IsProcessCritical, OpenProcess, OpenThread, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
        QueryFullProcessImageNameW, ResumeThread, THREAD_SUSPEND_RESUME, TerminateProcess,
    };

    windows_link::link!("ntdll.dll" "system" fn NtSuspendProcess(process: HANDLE) -> i32);

    /// The Windows shell and the parts of Windows that run in the user's session. Freezing these would freeze the
    /// desktop, never an agent.
    const SHELL: &[&str] = &[
        "explorer.exe",
        "dwm.exe",
        "csrss.exe",
        "winlogon.exe",
        "wininit.exe",
        "smss.exe",
        "services.exe",
        "lsass.exe",
        "svchost.exe",
        "sihost.exe",
        "fontdrvhost.exe",
        "ctfmon.exe",
        "taskhostw.exe",
        "runtimebroker.exe",
        "startmenuexperiencehost.exe",
        "shellexperiencehost.exe",
        "searchhost.exe",
        "textinputhost.exe",
        "dllhost.exe",
        "conhost.exe",
        "openconsole.exe",
        "windowsterminal.exe",
    ];
    /// The most passes a freeze makes to catch children spawned meanwhile.
    const PASSES: usize = 10;

    /// A handle closed when dropped.
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: a handle this owns, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }
    fn open(access: u32, pid: u32) -> io::Result<Handle> {
        // SAFETY: plain call; a null handle means failure.
        let h = unsafe { OpenProcess(access, 0, pid) };
        if h.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(h))
        }
    }
    fn snapshot(flags: u32) -> io::Result<Handle> {
        // SAFETY: plain call.
        let h = unsafe { CreateToolhelp32Snapshot(flags, 0) };
        if h == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(h))
        }
    }

    #[derive(Debug, Clone)]
    struct Proc {
        parent: u32,
        name: String,
    }

    /// Every running process: pid -> parent and program name.
    fn processes() -> io::Result<HashMap<u32, Proc>> {
        let snap = snapshot(TH32CS_SNAPPROCESS)?;
        // SAFETY: a zeroed PROCESSENTRY32W is valid once dwSize is set; the snapshot handle is open.
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut out = HashMap::new();
        let mut ok = unsafe { Process32FirstW(snap.0, &mut e) };
        while ok != 0 {
            let len = e
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..len]);
            out.insert(
                e.th32ProcessID,
                Proc {
                    parent: e.th32ParentProcessID,
                    name,
                },
            );
            ok = unsafe { Process32NextW(snap.0, &mut e) };
        }
        Ok(out)
    }

    /// When a process started (100 ns units), or None if it can't be asked (gone, or not this user's).
    fn started(pid: u32) -> Option<u64> {
        let h = open(PROCESS_QUERY_LIMITED_INFORMATION, pid).ok()?;
        let z = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut a, mut b, mut c) = (z, z, z, z);
        // SAFETY: a valid handle and four writable FILETIMEs.
        let ok = unsafe { GetProcessTimes(h.0, &mut created, &mut a, &mut b, &mut c) };
        (ok != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    /// The full path of a process's program, lowercased.
    fn image(pid: u32) -> Option<String> {
        let h = open(PROCESS_QUERY_LIMITED_INFORMATION, pid).ok()?;
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        // SAFETY: a valid handle and a buffer of len characters.
        let ok = unsafe {
            QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]).to_lowercase())
    }

    /// Is `child` really `parent`'s child, not a process that got a reused parent id?
    fn born_after(child: u32, parent: u32) -> bool {
        matches!((started(child), started(parent)), (Some(c), Some(p)) if c >= p)
    }

    /// `root` and its descendants, root first, parents before children.
    fn tree(all: &HashMap<u32, Proc>, root: u32) -> Vec<u32> {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for (&pid, p) in all {
            if pid != p.parent {
                children.entry(p.parent).or_default().push(pid);
            }
        }
        let mut out = vec![root];
        let mut i = 0;
        while i < out.len() {
            let parent = out[i];
            for &c in children.get(&parent).into_iter().flatten() {
                if !out.contains(&c) && born_after(c, parent) {
                    out.push(c);
                }
            }
            i += 1;
        }
        out
    }

    /// Mewndo itself: this core and every process it runs under (the app and whatever started the app).
    fn mewndo(all: &HashMap<u32, Proc>) -> (HashSet<u32>, Option<String>) {
        let me = std::process::id();
        let mut chain = HashSet::from([me]);
        let mut pid = me;
        while let Some(p) = all.get(&pid) {
            if p.parent == 0 || chain.contains(&p.parent) || !born_after(pid, p.parent) {
                break;
            }
            chain.insert(p.parent);
            pid = p.parent;
        }
        let app = all.get(&me).and_then(|p| image(p.parent)); // the app's program: its helpers run it too
        (chain, app)
    }

    /// Why a process must be left alone, if it must.
    fn refusal(
        pid: u32,
        name: &str,
        mewndo: &(HashSet<u32>, Option<String>),
    ) -> Option<&'static str> {
        if pid == 0 || pid == 4 {
            return Some("a system process");
        }
        if SHELL.contains(&name.to_lowercase().as_str()) {
            return Some("part of Windows");
        }
        if mewndo.0.contains(&pid) || (mewndo.1.is_some() && image(pid) == mewndo.1) {
            return Some("Mewndo itself");
        }
        // Services run in session 0. (Unless this core does too, as on a CI machine: then it's this user's.)
        let session = |pid: u32| {
            let mut s = u32::MAX;
            // SAFETY: a writable u32.
            (unsafe { ProcessIdToSessionId(pid, &mut s) } != 0).then_some(s)
        };
        if session(pid) == Some(0) && session(std::process::id()) != Some(0) {
            return Some("a system service");
        }
        if let Ok(h) = open(PROCESS_QUERY_LIMITED_INFORMATION, pid) {
            let mut critical = 0;
            // SAFETY: a valid handle and a writable BOOL.
            if unsafe { IsProcessCritical(h.0, &mut critical) } != 0 && critical != 0 {
                return Some("a critical system process");
            }
        }
        None
    }

    fn freeze_one(pid: u32) -> io::Result<()> {
        let h = open(PROCESS_SUSPEND_RESUME, pid)?;
        // SAFETY: a valid handle with suspend rights.
        let status = unsafe { NtSuspendProcess(h.0) };
        if status < 0 {
            Err(io::Error::other(format!(
                "NtSuspendProcess failed (0x{status:08x})"
            )))
        } else {
            Ok(())
        }
    }

    fn end_one(pid: u32) -> io::Result<()> {
        let h = open(PROCESS_TERMINATE, pid)?;
        // SAFETY: a valid handle with terminate rights.
        if unsafe { TerminateProcess(h.0, 1) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Thaw every thread of these processes completely.
    fn resume_all(pids: &HashSet<u32>) -> io::Result<HashMap<u32, io::Error>> {
        let snap = snapshot(TH32CS_SNAPTHREAD)?;
        // SAFETY: a zeroed THREADENTRY32 is valid once dwSize is set; the snapshot handle is open.
        let mut e: THREADENTRY32 = unsafe { std::mem::zeroed() };
        e.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut failed = HashMap::new();
        let mut ok = unsafe { Thread32First(snap.0, &mut e) };
        while ok != 0 {
            if pids.contains(&e.th32OwnerProcessID) {
                // SAFETY: plain call; a null handle means failure.
                let t = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, e.th32ThreadID) };
                if t.is_null() {
                    failed.insert(e.th32OwnerProcessID, io::Error::last_os_error());
                } else {
                    let t = Handle(t);
                    // ResumeThread gives the count before it; 1 means this call thawed it, 0 it wasn't suspended.
                    for _ in 0..128 {
                        // SAFETY: a valid handle with suspend/resume rights.
                        let before = unsafe { ResumeThread(t.0) };
                        if before == u32::MAX {
                            failed.insert(e.th32OwnerProcessID, io::Error::last_os_error());
                            break;
                        }
                        if before <= 1 {
                            break;
                        }
                    }
                }
            }
            ok = unsafe { Thread32Next(snap.0, &mut e) };
        }
        Ok(failed)
    }

    /// Freeze, resume or end the process tree of `root`. Fails without touching anything if root itself must be
    /// left alone or isn't running; other processes that must be left alone are skipped and reported.
    pub fn control(root: u32, action: Action) -> io::Result<Report> {
        let all = processes()?;
        let mewndo = mewndo(&all);
        let Some(p) = all.get(&root) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no running process {root}"),
            ));
        };
        if let Some(why) = refusal(root, &p.name, &mewndo) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} ({root}) is {why}: Mewndo never touches it", p.name),
            ));
        }
        let mut report = Report::default();
        let mut seen: HashSet<u32> = HashSet::new();
        let skip = |report: &mut Report, pid: u32, name: &str, reason: String| {
            report.skipped.push(Skipped {
                pid,
                name: name.to_string(),
                reason,
            });
        };
        let freezing = action != Action::Resume;
        for _ in 0..if freezing { PASSES } else { 1 } {
            let all = processes()?;
            let new: Vec<u32> = tree(&all, root)
                .into_iter()
                .filter(|pid| seen.insert(*pid))
                .collect();
            if new.is_empty() {
                break;
            }
            for pid in new {
                let name = all.get(&pid).map(|p| p.name.clone()).unwrap_or_default();
                if let Some(why) = refusal(pid, &name, &mewndo) {
                    skip(&mut report, pid, &name, why.to_string());
                } else if !freezing {
                    report.pids.push(pid);
                } else {
                    match freeze_one(pid) {
                        Ok(()) => report.pids.push(pid),
                        Err(e) => {
                            skip(&mut report, pid, &name, format!("could not freeze it: {e}"))
                        }
                    }
                }
            }
        }
        match action {
            Action::Freeze => {}
            Action::Resume => {
                let failed = resume_all(&report.pids.iter().copied().collect())?;
                for (pid, e) in failed {
                    report.pids.retain(|p| *p != pid);
                    skip(
                        &mut report,
                        pid,
                        &all.get(&pid).map(|p| p.name.clone()).unwrap_or_default(),
                        format!("could not resume it: {e}"),
                    );
                }
            }
            Action::End => {
                let frozen = std::mem::take(&mut report.pids);
                for pid in frozen {
                    match end_one(pid) {
                        Ok(()) => report.pids.push(pid),
                        Err(e) => skip(
                            &mut report,
                            pid,
                            &all.get(&pid).map(|p| p.name.clone()).unwrap_or_default(),
                            format!("could not end it: {e}"),
                        ),
                    }
                }
            }
        }
        Ok(report)
    }

    #[cfg(test)]
    mod tests {
        use super::super::{Action, control};
        use std::os::windows::process::CommandExt;
        use std::path::PathBuf;
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        /// `cmd` running `ping -t` (a line a second) into a file: a parent with a child that keeps writing.
        struct Pinger {
            child: Child,
            out: PathBuf,
        }
        impl Pinger {
            fn start(name: &str) -> Pinger {
                let out = std::env::temp_dir()
                    .join(format!("mewndo-freeze-{name}-{}.txt", std::process::id()));
                let _ = std::fs::remove_file(&out);
                // raw_arg: cmd reads its own quotes, not the escaped ones Rust would write.
                let child = Command::new("cmd")
                    .raw_arg(format!("/d /c ping -t 127.0.0.1 > \"{}\"", out.display()))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .spawn()
                    .unwrap();
                let p = Pinger { child, out };
                assert!(
                    p.wait_for_growth(Duration::from_secs(10)),
                    "ping isn't writing"
                );
                p
            }
            fn size(&self) -> u64 {
                std::fs::metadata(&self.out).map(|m| m.len()).unwrap_or(0)
            }
            fn wait_for_growth(&self, within: Duration) -> bool {
                let (start, at) = (self.size(), Instant::now());
                while at.elapsed() < within {
                    if self.size() > start {
                        return true;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                false
            }
        }
        impl Drop for Pinger {
            fn drop(&mut self) {
                let _ = control(self.child.id(), Action::End);
                let _ = self.child.kill();
                let _ = self.child.wait();
                let _ = std::fs::remove_file(&self.out);
            }
        }

        #[test]
        fn freezes_and_resumes_a_whole_process_tree() {
            let p = Pinger::start("tree");
            let frozen = control(p.child.id(), Action::Freeze).unwrap();
            assert_eq!(frozen.pids[0], p.child.id(), "root first");
            assert!(frozen.pids.len() >= 2, "cmd and its ping child: {frozen:?}");
            std::thread::sleep(Duration::from_millis(300)); // a write in progress finishes first
            assert!(
                !p.wait_for_growth(Duration::from_millis(2500)),
                "the child keeps writing while frozen"
            );

            // Frozen twice still comes back with one resume.
            control(p.child.id(), Action::Freeze).unwrap();
            let resumed = control(p.child.id(), Action::Resume).unwrap();
            assert_eq!(resumed.pids, frozen.pids);
            assert!(
                p.wait_for_growth(Duration::from_secs(5)),
                "writing again after resume"
            );
        }

        #[test]
        fn ends_a_whole_process_tree() {
            let mut p = Pinger::start("end");
            let ended = control(p.child.id(), Action::End).unwrap();
            assert!(ended.pids.len() >= 2, "{ended:?}");
            let at = Instant::now();
            while p.child.try_wait().unwrap().is_none() {
                assert!(
                    at.elapsed() < Duration::from_secs(5),
                    "cmd is still running"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(300));
            assert!(
                !p.wait_for_growth(Duration::from_millis(2000)),
                "ping is still running"
            );
        }

        #[test]
        fn never_touches_system_processes_or_mewndo_itself() {
            for pid in [0, 4, std::process::id()] {
                let e = control(pid, Action::Freeze).unwrap_err();
                assert_eq!(e.kind(), std::io::ErrorKind::PermissionDenied, "{pid}: {e}");
            }
            // What this core runs under (here: the test runner, cargo) is Mewndo too.
            let parent = super::processes().unwrap()[&std::process::id()].parent;
            assert_eq!(
                control(parent, Action::Freeze).unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
            // The Windows shell.
            let all = super::processes().unwrap();
            if let Some((&pid, _)) = all
                .iter()
                .find(|(_, p)| p.name.eq_ignore_ascii_case("explorer.exe"))
            {
                let e = control(pid, Action::Freeze).unwrap_err();
                assert!(e.to_string().contains("part of Windows"), "{e}");
            }
            assert_eq!(
                control(u32::MAX - 3, Action::Freeze).unwrap_err().kind(),
                std::io::ErrorKind::NotFound
            );
        }
    }
}
