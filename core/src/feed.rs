// Change feed: what changed in a protected folder, as it happens (spec §19.7, §28.6, §31.2 step 3).
//
// Live: ReadDirectoryChangesW on the folder. A delete is reported the moment Windows reports it: it needs no
// content, so it never waits for anything. New and edited files are reported once they've been quiet for 300 ms
// (per file), so a file being written is reported once, not once per write.
//
// Catch-up: the NTFS change journal (USN) records every change on the volume, including while Mewndo was closed
// and when the live feed's buffer overflowed in a burst. Read without admin rights, it gives no file names, only
// which folder each change was in. That is enough: the feed reports those folders as `rescan`, and a
// reconciliation scan of just those folders (scanner.rs) finds what changed. Where the journal can't help (FAT
// and exFAT drives, network folders, a journal that was reset or has wrapped past the saved position) it reports
// `rescan` of everything.
//
// The saved position (the cursor file) is moved forward only by the consumer, after it has saved what it learned
// (checkpoint), so a crash in between means looking at more on the next start, never less.
//
// Same ignore rules as v0's watcher: changes inside ignored folders, in names matching the folder's ignore
// patterns, and to Mewndo's own temp files are left out. Links and junctions are never followed: Windows reports
// changes in the folder's own tree only. Paths are exact (paths.rs), so long paths and names like "notes." work.
// The decision logic below is plain code, tested on every OS; only Windows has a feed using it so far.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::scanner::Patterns;
use crate::store::TEMP_SUFFIX;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedEvent {
    /// created, modified, deleted · rescan (dirs, or everything when dirs is None) · gone (the folder itself
    /// was removed or its drive unplugged) · error (the feed stopped; watch again)
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// When the feed learned of it (ms since 1970).
    pub at_ms: f64,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

impl FeedEvent {
    pub fn change(kind: &str, path: &str) -> FeedEvent {
        FeedEvent {
            kind: kind.into(),
            path: Some(path.to_string()),
            dirs: None,
            message: None,
            at_ms: now_ms(),
        }
    }
    pub fn rescan(dirs: Option<Vec<String>>, why: &str) -> FeedEvent {
        FeedEvent {
            kind: "rescan".into(),
            path: None,
            dirs,
            message: Some(why.to_string()),
            at_ms: now_ms(),
        }
    }
    pub fn problem(kind: &str, message: String) -> FeedEvent {
        FeedEvent {
            kind: kind.into(),
            path: None,
            dirs: None,
            message: Some(message),
            at_ms: now_ms(),
        }
    }
}

/// More changed folders than this and reading them one by one costs more than a full scan (as in v0).
const MAX_DIRS: usize = 2000;

// --- Which changes count ----------------------------------------------------------------------------------------

pub struct Filter {
    ignore: HashSet<String>,
    patterns: Patterns,
}

impl Filter {
    pub fn new(ignore: &[String], patterns: &[String]) -> Filter {
        Filter {
            ignore: ignore.iter().cloned().collect(),
            patterns: Patterns::new(patterns),
        }
    }

    /// rel: '/'-separated, relative to the folder.
    pub fn keeps(&self, rel: &str) -> bool {
        let parts: Vec<&str> = rel.split('/').collect();
        let (name, parents) = parts.split_last().expect("split gives at least one part");
        !(parents.iter().any(|p| self.ignore.contains(*p))
            || parts.iter().any(|p| self.patterns.matches(p))
            || name.ends_with(TEMP_SUFFIX))
    }
}

// --- Debounce ---------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Change {
    Created,
    Modified,
    Deleted,
}

/// New and edited files wait until they've been quiet for `wait_ms`; deletes go straight out and cancel a wait.
pub struct Debouncer {
    wait_ms: f64,
    pending: HashMap<String, (Change, f64)>,
}

impl Debouncer {
    pub fn new(wait_ms: f64) -> Debouncer {
        Debouncer {
            wait_ms,
            pending: HashMap::new(),
        }
    }

    /// Returns the event to send now, if any.
    pub fn note(&mut self, rel: &str, change: Change, now: f64) -> Option<FeedEvent> {
        match change {
            Change::Deleted => {
                self.pending.remove(rel);
                Some(FeedEvent::change("deleted", rel))
            }
            _ => {
                let kind = match self.pending.get(rel) {
                    Some((Change::Created, _)) => Change::Created, // created then written: still "created"
                    _ => change,
                };
                self.pending
                    .insert(rel.to_string(), (kind, now + self.wait_ms));
                None
            }
        }
    }

    /// Changes quiet long enough to send, oldest path first.
    pub fn due(&mut self, now: f64) -> Vec<(String, Change)> {
        let mut out: Vec<(String, Change)> = self
            .pending
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(rel, (c, _))| (rel.clone(), *c))
            .collect();
        for (rel, _) in &out {
            self.pending.remove(rel);
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }
}

// --- What Windows reports ---------------------------------------------------------------------------------------

pub const ADDED: u32 = 1;
pub const REMOVED: u32 = 2;
pub const MODIFIED: u32 = 3;
pub const RENAMED_OLD: u32 = 4;
pub const RENAMED_NEW: u32 = 5;

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn i64_at(b: &[u8], at: usize) -> Option<i64> {
    Some(i64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// ReadDirectoryChangesW's buffer: FILE_NOTIFY_INFORMATION entries (next offset, action, name length in bytes,
/// UTF-16 name). Returns (action, path with '/').
pub fn parse_notify(buf: &[u8]) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while let (Some(next), Some(action), Some(len)) =
        (u32_at(buf, at), u32_at(buf, at + 4), u32_at(buf, at + 8))
    {
        let Some(name) = buf.get(at + 12..at + 12 + len as usize) else {
            break;
        };
        let units: Vec<u16> = name
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        out.push((action, String::from_utf16_lossy(&units).replace('\\', "/")));
        if next == 0 {
            break;
        }
        at += next as usize;
    }
    out
}

/// One change journal record: the file or folder that changed and the folder it's in. Names aren't given
/// without admin rights, and aren't needed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsnRecord {
    pub file: u128,
    pub parent: u128,
}

/// FSCTL_READ_(UNPRIVILEGED_)USN_JOURNAL's output: the next USN, then USN_RECORD_V2 (64-bit file IDs, NTFS) or
/// V3 (128-bit, ReFS and Dev Drive) records.
pub fn parse_usn(buf: &[u8]) -> (i64, Vec<UsnRecord>) {
    let next = i64_at(buf, 0).unwrap_or(0);
    let mut out = Vec::new();
    let mut at = 8usize;
    while let (Some(len), Some(major)) = (u32_at(buf, at), u16_at(buf, at + 4)) {
        if len == 0 || at + len as usize > buf.len() {
            break;
        }
        let id = |from: usize, bytes: usize| -> Option<u128> {
            let mut b = [0u8; 16];
            b[..bytes].copy_from_slice(buf.get(at + from..at + from + bytes)?);
            Some(u128::from_le_bytes(b))
        };
        let record = match major {
            2 => id(8, 8).zip(id(16, 8)),
            3 => id(8, 16).zip(id(24, 16)),
            _ => None, // a future version: skipped; its folder is still reported by other records, or not at all
        };
        if let Some((file, parent)) = record {
            out.push(UsnRecord { file, parent });
        }
        at += len as usize;
    }
    (next, out)
}

/// The folders (relative, "" = the top) the records say changed. `resolve(id)`: a folder ID's place now: None if
/// it can't be opened (deleted, or no access), Some(None) if it's outside the protected folder, Some(Some(rel))
/// inside it. A deleted folder is placed by its own record (its parent), and so on up to one that still exists:
/// rescanning that finds the whole deleted tree gone. None when there are so many that a full scan is cheaper.
pub fn changed_dirs(
    records: &[UsnRecord],
    mut resolve: impl FnMut(u128) -> Option<Option<String>>,
) -> Option<Vec<String>> {
    let mut parents: HashMap<u128, Vec<u128>> = HashMap::new();
    for r in records {
        let p = parents.entry(r.file).or_default();
        if !p.contains(&r.parent) {
            p.push(r.parent);
        }
    }
    let mut placed: HashMap<u128, Vec<String>> = HashMap::new();
    fn place(
        id: u128,
        parents: &HashMap<u128, Vec<u128>>,
        resolve: &mut dyn FnMut(u128) -> Option<Option<String>>,
        placed: &mut HashMap<u128, Vec<String>>,
        visiting: &mut HashSet<u128>,
    ) -> Vec<String> {
        if let Some(done) = placed.get(&id) {
            return done.clone();
        }
        if !visiting.insert(id) {
            return Vec::new(); // a cycle in what the records say: can't happen on disk, but never loop
        }
        let found = match resolve(id) {
            Some(Some(rel)) => vec![rel],
            Some(None) => Vec::new(),
            None => parents
                .get(&id)
                .into_iter()
                .flatten()
                .flat_map(|&p| place(p, parents, resolve, placed, visiting))
                .collect(),
        };
        placed.insert(id, found.clone());
        found
    }
    let mut dirs = BTreeSet::new();
    let unique: BTreeSet<u128> = records.iter().map(|r| r.parent).collect();
    for p in unique {
        dirs.extend(place(
            p,
            &parents,
            &mut resolve,
            &mut placed,
            &mut HashSet::new(),
        ));
        if dirs.len() > MAX_DIRS {
            return None;
        }
    }
    Some(dirs.into_iter().collect())
}

// --- Watching ---------------------------------------------------------------------------------------------------

pub type Emit = std::sync::Arc<dyn Fn(FeedEvent) + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchOptions {
    pub ignore: Vec<String>,
    pub ignore_patterns: Vec<String>,
    /// Where the journal position is kept between runs; None: every start is a full rescan.
    pub cursor_file: Option<std::path::PathBuf>,
    /// ReadDirectoryChangesW's buffer. Bigger overflows less in a burst; tests make it tiny to force overflows.
    pub buffer_bytes: u32,
    pub debounce_ms: f64,
}

impl Default for WatchOptions {
    fn default() -> Self {
        WatchOptions {
            ignore: crate::scanner::DEFAULT_IGNORE
                .iter()
                .map(|s| s.to_string())
                .collect(),
            ignore_patterns: Vec::new(),
            cursor_file: None,
            buffer_bytes: 512 * 1024,
            debounce_ms: 300.0,
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use std::io;
    use std::path::Path;

    pub struct Watch;

    impl Watch {
        pub fn real_root(&self) -> &Path {
            unreachable!()
        }
        pub fn position(&self) -> io::Result<Option<i64>> {
            unreachable!()
        }
        pub fn checkpoint(&self, _usn: i64) -> io::Result<()> {
            unreachable!()
        }
    }

    // ponytail: Mewndo v1 is a Windows app; macOS (FSEvents) and Linux (fanotify) feeds come with those apps.
    pub fn watch(_root: &Path, _opts: WatchOptions, _emit: Emit) -> io::Result<Watch> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "the change feed runs on Windows only (Mewndo v1 is a Windows app)",
        ))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::paths::{exact, real};
    use crate::store::write_file_atomic;
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::ffi::OsStringExt;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::IO::{
        CancelIoEx, DeviceIoControl, GetOverlappedResult, OVERLAPPED,
    };
    use windows_sys::Win32::System::Ioctl::{
        FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, READ_USN_JOURNAL_DATA_V1,
        USN_JOURNAL_DATA_V0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects,
    };

    /// A Windows handle, closed when dropped. Handles may be used from any thread.
    struct Handle(HANDLE);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    /// The live feed's buffer and its OVERLAPPED. Windows writes into both until the read completes or is
    /// cancelled, so they stay at one address (boxed) and belong to the reader thread alone once it starts.
    struct Pending {
        buf: Vec<u32>,
        ov: Box<OVERLAPPED>,
    }
    unsafe impl Send for Pending {}

    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain([0]).collect()
    }

    fn open_dir(p: &Path, access: u32, flags: u32) -> io::Result<Handle> {
        let h = unsafe {
            CreateFileW(
                wide(p).as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, // never stop anyone deleting or renaming
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | flags,
                std::ptr::null_mut(),
            )
        };
        if h == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(h))
        }
    }

    fn final_path(h: HANDLE) -> io::Result<PathBuf> {
        let mut buf = vec![0u16; 1024];
        loop {
            let n = unsafe { GetFinalPathNameByHandleW(h, buf.as_mut_ptr(), buf.len() as u32, 0) }
                as usize;
            if n == 0 {
                return Err(io::Error::last_os_error());
            }
            if n < buf.len() {
                return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])));
            }
            buf.resize(n + 1, 0);
        }
    }

    fn ioctl(h: HANDLE, code: u32, input: &[u8], out: &mut [u8]) -> io::Result<usize> {
        let mut n = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                h,
                code,
                input.as_ptr() as *const c_void,
                input.len() as u32,
                out.as_mut_ptr() as *mut c_void,
                out.len() as u32,
                &mut n,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }

    /// The volume's change journal: its ID, the oldest USN still kept, and the next one. None: no journal here.
    fn journal(h: HANDLE) -> Option<(u64, i64, i64)> {
        let mut out = [0u8; 80];
        ioctl(h, FSCTL_QUERY_USN_JOURNAL, &[], &mut out).ok()?;
        let j: USN_JOURNAL_DATA_V0 = unsafe { std::ptr::read_unaligned(out.as_ptr() as *const _) };
        Some((j.UsnJournalID, j.FirstUsn, j.NextUsn))
    }

    /// Every record from `from` up to `to`. Records are read without admin rights through a folder handle.
    fn records(h: HANDLE, journal_id: u64, from: i64, to: i64) -> io::Result<Vec<UsnRecord>> {
        let mut out = Vec::new();
        let mut start = from;
        let mut buf = vec![0u8; 64 * 1024];
        while start < to {
            let input = READ_USN_JOURNAL_DATA_V1 {
                StartUsn: start,
                ReasonMask: u32::MAX,
                ReturnOnlyOnClose: 0,
                Timeout: 0,
                BytesToWaitFor: 0,
                UsnJournalID: journal_id,
                MinMajorVersion: 2,
                MaxMajorVersion: 3,
            };
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    &input as *const _ as *const u8,
                    std::mem::size_of_val(&input),
                )
            };
            let n = ioctl(h, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, bytes, &mut buf)?;
            let (next, recs) = parse_usn(&buf[..n]);
            if recs.is_empty() || next <= start {
                break;
            }
            out.extend(recs);
            start = next;
            if out.len() > 5_000_000 {
                return Err(io::Error::other("too many changes to read one by one"));
            }
        }
        Ok(out)
    }

    /// A folder's place by its file ID (see changed_dirs).
    fn place(hint: HANDLE, id: u128, root: &Path) -> Option<Option<String>> {
        let mut desc = FILE_ID_DESCRIPTOR {
            dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
            ..Default::default()
        };
        if id >> 64 == 0 {
            desc.Type = FileIdType;
            desc.Anonymous.FileId = id as i64;
        } else {
            desc.Type = ExtendedFileIdType;
            desc.Anonymous.ExtendedFileId = FILE_ID_128 {
                Identifier: id.to_le_bytes(),
            };
        }
        let h = unsafe {
            OpenFileById(
                hint,
                &desc,
                0x80, /* FILE_READ_ATTRIBUTES */
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                FILE_FLAG_BACKUP_SEMANTICS,
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        let h = Handle(h);
        let path = final_path(h.0).ok()?;
        Some(
            path.strip_prefix(root)
                .ok()
                .map(|rel| rel.to_string_lossy().replace('\\', "/")),
        )
    }

    const WHAT: u32 = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_CREATION;

    /// Ask for the next batch of reports, delivered into `buf`, signalling `ov.hEvent` when they're in.
    fn arm(dir: HANDLE, buf: &mut [u32], ov: &mut OVERLAPPED) -> io::Result<()> {
        unsafe { windows_sys::Win32::System::Threading::ResetEvent(ov.hEvent) };
        let ok = unsafe {
            ReadDirectoryChangesW(
                dir,
                buf.as_mut_ptr() as *mut c_void,
                (buf.len() * 4) as u32,
                1,
                WHAT,
                std::ptr::null_mut(),
                ov,
                None,
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn catch_up(
        h: HANDLE,
        root: &Path,
        journal_id: u64,
        from: i64,
        to: i64,
    ) -> Option<Vec<String>> {
        let recs = records(h, journal_id, from, to).ok()?;
        changed_dirs(&recs, |id| place(h, id, root))
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Cursor {
        journal: String,
        usn: i64,
    }

    pub struct Watch {
        real_root: PathBuf,
        query: Arc<Handle>,
        cursor_file: Option<PathBuf>,
        stop: Arc<Handle>,
        threads: Vec<JoinHandle<()>>,
    }

    impl Watch {
        /// The folder's long real path (links followed, short aliases expanded), exact() form.
        pub fn real_root(&self) -> &Path {
            &self.real_root
        }

        /// Where the journal is now. The consumer notes it before a sync and checkpoints it once the sync is saved.
        pub fn position(&self) -> io::Result<Option<i64>> {
            Ok(journal(self.query.0).map(|(_, _, next)| next))
        }

        /// Everything before `usn` is safely recorded: the next start catches up from there.
        pub fn checkpoint(&self, usn: i64) -> io::Result<()> {
            let (Some(file), Some((id, _, _))) = (&self.cursor_file, journal(self.query.0)) else {
                return Ok(());
            };
            write_file_atomic(
                file,
                serde_json::to_string(&Cursor {
                    journal: format!("{id:x}"),
                    usn,
                })?
                .as_bytes(),
            )
        }
    }

    impl Drop for Watch {
        fn drop(&mut self) {
            unsafe { SetEvent(self.stop.0) };
            for t in self.threads.drain(..) {
                let _ = t.join();
            }
        }
    }

    pub fn watch(root: &Path, opts: WatchOptions, emit: Emit) -> io::Result<Watch> {
        let real_root = real(root)?;
        let dir = Arc::new(open_dir(
            &real_root,
            FILE_LIST_DIRECTORY,
            FILE_FLAG_OVERLAPPED,
        )?);
        let query = Arc::new(open_dir(
            &real_root, 0x80, /* FILE_READ_ATTRIBUTES */
            0,
        )?);
        let final_root = final_path(query.0)?;
        let stop = Arc::new(Handle(unsafe {
            CreateEventW(std::ptr::null(), 1, 0, std::ptr::null())
        }));
        let io_done = Arc::new(Handle(unsafe {
            CreateEventW(std::ptr::null(), 1, 0, std::ptr::null())
        }));
        let filter = Arc::new(Filter::new(&opts.ignore, &opts.ignore_patterns));
        let debouncer = Arc::new(Mutex::new(Debouncer::new(opts.debounce_ms)));
        let saved: Option<Cursor> = opts
            .cursor_file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok());

        // Arm the live feed first, so nothing between the catch-up and the first event is missed.
        let mut pending = Pending {
            buf: vec![0; (opts.buffer_bytes as usize).div_ceil(4)],
            ov: Box::new(unsafe { std::mem::zeroed() }),
        };
        pending.ov.hEvent = io_done.0;
        arm(dir.0, &mut pending.buf, &mut pending.ov)?;

        // Catch up on what happened while nobody watched.
        let journal_now = journal(query.0);
        let start = match (&saved, journal_now) {
            (Some(c), Some((id, first, next)))
                if c.journal == format!("{id:x}") && c.usn >= first =>
            {
                match catch_up(query.0, &final_root, id, c.usn, next) {
                    Some(dirs) => {
                        FeedEvent::rescan(Some(dirs), "changes while Mewndo wasn't watching")
                    }
                    None => {
                        FeedEvent::rescan(None, "too many changes while Mewndo wasn't watching")
                    }
                }
            }
            (_, None) => FeedEvent::rescan(None, "this drive keeps no change journal"),
            (None, _) => FeedEvent::rescan(None, "first start"),
            _ => FeedEvent::rescan(
                None,
                "the change journal was reset or has moved past the saved position",
            ),
        };
        emit(start);
        let live = journal_now.map(|(_, _, next)| next);

        // The reader: Windows' reports, until stopped.
        let reader = {
            let (dir, query, stop, io_done) =
                (dir.clone(), query.clone(), stop.clone(), io_done.clone());
            let (emit, filter, debouncer, root, final_root) = (
                emit.clone(),
                filter.clone(),
                debouncer.clone(),
                real_root.clone(),
                final_root.clone(),
            );
            std::thread::spawn(move || {
                let mut pending = pending;
                let Pending { buf, ov } = &mut pending;
                let mut live = live;
                loop {
                    let which = unsafe {
                        WaitForMultipleObjects(2, [io_done.0, stop.0].as_ptr(), 0, INFINITE)
                    };
                    if which != WAIT_OBJECT_0 {
                        unsafe {
                            CancelIoEx(dir.0, &**ov);
                            let mut n = 0;
                            GetOverlappedResult(dir.0, &**ov, &mut n, 1);
                        }
                        return;
                    }
                    let mut n = 0u32;
                    let ok = unsafe { GetOverlappedResult(dir.0, &**ov, &mut n, 0) };
                    let error = if ok == 0 {
                        unsafe { GetLastError() }
                    } else {
                        0
                    };
                    if ok == 0 && error != 1022
                    /* ERROR_NOTIFY_ENUM_DIR: overflowed */
                    {
                        let gone = std::fs::symlink_metadata(&root).is_err();
                        emit(if gone {
                            FeedEvent::problem(
                                "gone",
                                format!(
                                    "The folder was removed or its drive unplugged: {}",
                                    crate::paths::display(&root)
                                ),
                            )
                        } else {
                            FeedEvent::problem(
                                "error",
                                format!(
                                    "The change feed stopped ({}); watch again",
                                    io::Error::from_raw_os_error(error as i32)
                                ),
                            )
                        });
                        return;
                    }
                    let bytes = unsafe {
                        std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize)
                    }
                    .to_vec();
                    if let Err(e) = arm(dir.0, buf, ov) {
                        emit(FeedEvent::problem(
                            "error",
                            format!("The change feed stopped ({e}); watch again"),
                        ));
                        return;
                    }
                    if n == 0 {
                        // Overflowed: Windows dropped the details. The journal still has them.
                        let now = journal(query.0);
                        let event = match (live, now) {
                            (Some(from), Some((id, _, next))) => {
                                match catch_up(query.0, &final_root, id, from, next) {
                                    Some(dirs) => FeedEvent::rescan(
                                        Some(dirs),
                                        "too many changes at once for the live feed",
                                    ),
                                    None => FeedEvent::rescan(None, "too many changes at once"),
                                }
                            }
                            _ => FeedEvent::rescan(
                                None,
                                "too many changes at once, and this drive keeps no change journal",
                            ),
                        };
                        live = now.map(|(_, _, next)| next);
                        emit(event);
                        continue;
                    }
                    live = journal(query.0).map(|(_, _, next)| next).or(live);
                    let now = now_ms();
                    let mut d = debouncer.lock().unwrap_or_else(|e| e.into_inner());
                    for (action, rel) in parse_notify(&bytes) {
                        if !filter.keeps(&rel) {
                            continue;
                        }
                        let change = match action {
                            REMOVED | RENAMED_OLD => Change::Deleted,
                            ADDED | RENAMED_NEW => Change::Created,
                            MODIFIED => Change::Modified,
                            _ => continue,
                        };
                        if let Some(event) = d.note(&rel, change, now) {
                            emit(event); // deletes: right away
                        }
                    }
                }
            })
        };

        // The sender: changes that have been quiet long enough.
        let sender = {
            let (stop, emit, debouncer, root) = (
                stop.clone(),
                emit.clone(),
                debouncer.clone(),
                real_root.clone(),
            );
            std::thread::spawn(move || {
                while unsafe {
                    windows_sys::Win32::System::Threading::WaitForSingleObject(stop.0, 50)
                } != WAIT_OBJECT_0
                {
                    let due = debouncer
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .due(now_ms());
                    for (rel, change) in due {
                        let is_dir = std::fs::symlink_metadata(exact(&root.join(&rel)))
                            .map(|m| m.is_dir())
                            .unwrap_or(false);
                        // Windows reports a folder as modified when something inside it changes; that thing is
                        // reported itself, so the folder's own "modified" adds nothing (as in v0).
                        if change == Change::Modified && is_dir {
                            continue;
                        }
                        emit(FeedEvent::change(
                            if change == Change::Created {
                                "created"
                            } else {
                                "modified"
                            },
                            &rel,
                        ));
                    }
                }
            })
        };

        Ok(Watch {
            real_root,
            query,
            cursor_file: opts.cursor_file,
            stop,
            threads: vec![reader, sender],
        })
    }
}

pub use platform::{Watch, watch};

#[cfg(test)]
mod tests {
    use super::*;

    fn notify(entries: &[(u32, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, (action, name)) in entries.iter().enumerate() {
            let units: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            let size = (12 + units.len()).div_ceil(4) * 4;
            let next = if i + 1 == entries.len() {
                0
            } else {
                size as u32
            };
            out.extend(next.to_le_bytes());
            out.extend(action.to_le_bytes());
            out.extend((units.len() as u32).to_le_bytes());
            out.extend(&units);
            out.resize(out.len() + size - 12 - units.len(), 0);
        }
        out
    }

    #[test]
    fn parses_windows_change_reports() {
        let buf = notify(&[
            (ADDED, "docs\\new.txt"),
            (REMOVED, "a.txt"),
            (RENAMED_OLD, "x"),
            (RENAMED_NEW, "dir\\notes."),
        ]);
        assert_eq!(
            parse_notify(&buf),
            [
                (ADDED, "docs/new.txt".to_string()),
                (REMOVED, "a.txt".into()),
                (RENAMED_OLD, "x".into()),
                (RENAMED_NEW, "dir/notes.".into())
            ]
        );
        assert!(parse_notify(&[]).is_empty());
        assert_eq!(
            parse_notify(&buf[..20]),
            [],
            "a cut-off entry is dropped, never misread"
        );
    }

    fn usn_v2(file: u64, parent: u64) -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[0..4].copy_from_slice(&64u32.to_le_bytes());
        r[4..6].copy_from_slice(&2u16.to_le_bytes());
        r[8..16].copy_from_slice(&file.to_le_bytes());
        r[16..24].copy_from_slice(&parent.to_le_bytes());
        r
    }
    fn usn_v3(file: u128, parent: u128) -> Vec<u8> {
        let mut r = vec![0u8; 80];
        r[0..4].copy_from_slice(&80u32.to_le_bytes());
        r[4..6].copy_from_slice(&3u16.to_le_bytes());
        r[8..24].copy_from_slice(&file.to_le_bytes());
        r[24..40].copy_from_slice(&parent.to_le_bytes());
        r
    }

    #[test]
    fn parses_change_journal_records_of_both_versions() {
        let mut buf = 777i64.to_le_bytes().to_vec();
        buf.extend(usn_v2(5, 1));
        buf.extend(usn_v3(1 << 100, 7));
        let mut future = usn_v2(9, 9);
        future[4] = 9; // an unknown version is skipped
        buf.extend(future);
        buf.extend(usn_v2(6, 1));
        let (next, recs) = parse_usn(&buf);
        assert_eq!(next, 777);
        assert_eq!(
            recs,
            [
                UsnRecord { file: 5, parent: 1 },
                UsnRecord {
                    file: 1 << 100,
                    parent: 7
                },
                UsnRecord { file: 6, parent: 1 }
            ]
        );
        assert_eq!(parse_usn(&buf[..30]).1, [], "a cut-off record is dropped");
    }

    #[test]
    fn changed_folders_come_from_the_records_and_deleted_folders_are_placed_by_their_parents() {
        // 1 = the protected folder, 2 = src (exists), 3 = old (deleted), 4 = old/deeper (deleted), 9 = elsewhere
        let resolve = |id: u128| match id {
            1 => Some(Some(String::new())),
            2 => Some(Some("src".to_string())),
            9 => Some(None),
            _ => None,
        };
        let recs = [
            UsnRecord {
                file: 10,
                parent: 2,
            }, // a file in src
            UsnRecord {
                file: 11,
                parent: 4,
            }, // a file in old/deeper (deleted with it)
            UsnRecord { file: 4, parent: 3 }, // old/deeper deleted
            UsnRecord { file: 3, parent: 1 }, // old deleted
            UsnRecord {
                file: 12,
                parent: 9,
            }, // outside the folder
            UsnRecord {
                file: 13,
                parent: 99,
            }, // in a folder deleted long ago: can't be placed, so not ours
        ];
        assert_eq!(
            changed_dirs(&recs, resolve),
            Some(vec![String::new(), "src".into()])
        );
        assert_eq!(changed_dirs(&[], resolve), Some(vec![]));
        let cycle = [
            UsnRecord {
                file: 50,
                parent: 51,
            },
            UsnRecord {
                file: 51,
                parent: 50,
            },
        ];
        assert_eq!(
            changed_dirs(&cycle, |_| None),
            Some(vec![]),
            "a cycle never loops"
        );
    }

    #[test]
    fn too_many_changed_folders_means_scan_everything() {
        let recs: Vec<UsnRecord> = (0..MAX_DIRS as u128 + 1)
            .map(|i| UsnRecord {
                file: 100_000 + i,
                parent: i,
            })
            .collect();
        assert_eq!(changed_dirs(&recs, |id| Some(Some(format!("d{id}")))), None);
    }

    #[test]
    fn deletes_go_out_at_once_and_writes_wait_until_quiet() {
        let mut d = Debouncer::new(300.0);
        assert_eq!(d.note("a.txt", Change::Created, 0.0), None);
        assert_eq!(
            d.note("a.txt", Change::Modified, 200.0),
            None,
            "still being written"
        );
        assert_eq!(d.due(400.0), [], "quiet for only 200 ms");
        assert_eq!(
            d.due(500.0),
            [("a.txt".to_string(), Change::Created)],
            "created, then written: one 'created'"
        );
        assert_eq!(d.note("b.txt", Change::Modified, 0.0), None);
        assert_eq!(
            d.note("b.txt", Change::Deleted, 10.0)
                .map(|e| e.kind)
                .as_deref(),
            Some("deleted"),
            "a delete never waits"
        );
        assert_eq!(d.due(10_000.0), [], "and cancels the wait");
    }

    #[test]
    fn the_filter_keeps_v0s_ignore_rules() {
        let f = Filter::new(&["node_modules".into(), "dist".into()], &["*.log".into()]);
        assert!(f.keeps("src/a.js") && f.keeps("node_modules") && f.keeps(".git/HEAD"));
        assert!(!f.keeps("node_modules/x/y.js") && !f.keeps("a/dist/b"));
        assert!(!f.keeps("logs/today.log") && !f.keeps("x.log/inside"));
        assert!(
            !f.keeps("docs/report.docx.1a2b.mewndo-tmp"),
            "Mewndo's own temp files"
        );
    }
}

/// The live feed on real Windows folders (NTFS here; CI's runner too).
#[cfg(all(test, windows))]
mod live {
    use super::*;
    use crate::paths::{display, exact, real};
    use crate::scanner::{self, Manifest, ScanOptions};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::{Receiver, channel};
    use std::time::{Duration, Instant};

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(exact(&self.0));
        }
    }
    fn temp_dir(name: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("mewndo-feed-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Dir(d)
    }

    fn start(root: &Path, opts: WatchOptions) -> (Watch, Receiver<FeedEvent>) {
        let (tx, rx) = channel();
        let tx = std::sync::Mutex::new(tx);
        let w = watch(
            root,
            opts,
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
        )
        .unwrap();
        (w, rx)
    }
    use std::sync::Arc;

    /// Events until one matches, or panics after a few seconds with what came instead.
    fn until(
        rx: &Receiver<FeedEvent>,
        what: &str,
        matches: impl Fn(&FeedEvent) -> bool,
    ) -> (FeedEvent, Vec<FeedEvent>) {
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(e) if matches(&e) => return (e, seen),
                Ok(e) => seen.push(e),
                Err(_) => break,
            }
        }
        panic!("no {what}; got {seen:#?}");
    }
    fn is(kind: &'static str, path: &'static str) -> impl Fn(&FeedEvent) -> bool {
        move |e| e.kind == kind && e.path.as_deref() == Some(path)
    }

    fn opts() -> WatchOptions {
        WatchOptions {
            ignore_patterns: vec!["*.log".into()],
            ..WatchOptions::default()
        }
    }

    #[test]
    fn starts_with_a_rescan_then_reports_creates_edits_renames_and_deletes() {
        let d = temp_dir("basic");
        let (_w, rx) = start(&d.0, opts());
        let (first, _) = until(&rx, "first rescan", |e| e.kind == "rescan");
        assert_eq!(
            (first.dirs, first.message.as_deref()),
            (None, Some("first start"))
        );

        fs::write(d.0.join("a.txt"), "1").unwrap();
        until(&rx, "created a.txt", is("created", "a.txt"));
        fs::write(d.0.join("a.txt"), "12").unwrap();
        until(&rx, "modified a.txt", is("modified", "a.txt"));
        fs::create_dir(d.0.join("sub")).unwrap();
        fs::write(d.0.join("sub").join("b.txt"), "b").unwrap();
        let (_, before) = until(&rx, "created sub/b.txt", is("created", "sub/b.txt"));
        fs::rename(d.0.join("a.txt"), d.0.join("c.txt")).unwrap();
        until(&rx, "a.txt gone by rename", is("deleted", "a.txt"));
        until(&rx, "c.txt created by rename", is("created", "c.txt"));
        fs::remove_file(d.0.join("c.txt")).unwrap();
        let (_, more) = until(&rx, "deleted c.txt", is("deleted", "c.txt"));
        let all: Vec<_> = before.iter().chain(&more).collect();
        assert!(
            !all.iter()
                .any(|e| e.kind == "modified" && e.path.as_deref() == Some("sub")),
            "a folder's own 'modified' is left out: {all:#?}"
        );
    }

    #[test]
    fn ignored_folders_patterns_and_mewndo_temp_files_are_silent() {
        let d = temp_dir("ignored");
        fs::create_dir_all(d.0.join("node_modules").join("pkg")).unwrap();
        let (_w, rx) = start(&d.0, opts());
        until(&rx, "first rescan", |e| e.kind == "rescan");
        fs::write(d.0.join("node_modules").join("pkg").join("i.js"), "x").unwrap();
        fs::write(d.0.join("today.log"), "x").unwrap();
        fs::write(d.0.join("r.docx.1a.mewndo-tmp"), "x").unwrap();
        fs::write(d.0.join("marker.txt"), "x").unwrap();
        let (_, seen) = until(&rx, "created marker.txt", is("created", "marker.txt"));
        assert!(seen.is_empty(), "nothing else reported: {seen:#?}");
    }

    #[test]
    fn junctions_are_never_followed() {
        let d = temp_dir("junction");
        let (root, outside) = (d.0.join("root"), d.0.join("outside"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("link"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(made.status.success());
        let (_w, rx) = start(&root, opts());
        until(&rx, "first rescan", |e| e.kind == "rescan");
        fs::write(outside.join("secret.txt"), "x").unwrap();
        fs::write(root.join("link").join("via-link.txt"), "x").unwrap(); // lands in `outside`
        fs::write(root.join("marker.txt"), "x").unwrap();
        let (_, seen) = until(&rx, "created marker.txt", is("created", "marker.txt"));
        assert!(
            !seen
                .iter()
                .any(|e| e.path.as_deref().is_some_and(|p| p.starts_with("link/"))),
            "{seen:#?}"
        );
    }

    #[test]
    fn long_paths_and_names_windows_would_change_are_reported_exactly() {
        let d = temp_dir("long");
        let deep = ["a".repeat(100), "b".repeat(100), "c".repeat(100)].join("/");
        fs::create_dir_all(exact(&d.0.join(&deep))).unwrap();
        let (_w, rx) = start(&d.0, opts());
        until(&rx, "first rescan", |e| e.kind == "rescan");
        let rel = format!("{deep}/notes.");
        fs::write(exact(&d.0.join(&rel)), "x").unwrap();
        let (e, _) = until(&rx, "created deep notes.", |e| {
            e.kind == "created" && e.path.as_deref() == Some(rel.as_str())
        });
        assert!(e.path.unwrap().len() > 300);
    }

    /// Spec §28: a delete reaches the feed in about 10 to 100 ms. Measured here and printed.
    #[test]
    fn deletes_are_reported_at_once_and_how_fast_is_printed() {
        let d = temp_dir("latency");
        for i in 0..50 {
            fs::write(d.0.join(format!("f{i}.txt")), "x").unwrap();
        }
        let (_w, rx) = start(&d.0, opts());
        until(&rx, "first rescan", |e| e.kind == "rescan");
        let mut ms = Vec::new();
        for i in 0..50 {
            let name = format!("f{i}.txt");
            let t0 = now_ms();
            fs::remove_file(d.0.join(&name)).unwrap();
            let (e, _) = until(&rx, "the delete", |e| {
                e.kind == "deleted" && e.path.as_deref() == Some(name.as_str())
            });
            ms.push(e.at_ms - t0);
        }
        ms.sort_by(f64::total_cmp);
        let (p50, p95, max) = (ms[24], ms[47], ms[49]);
        println!(
            "delete -> change feed, 50 deletes: median {p50:.2} ms, p95 {p95:.2} ms, max {max:.2} ms"
        );
        assert!(p50 < 100.0, "median {p50} ms; spec §28 wants 10 to 100 ms");
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn changes_while_mewndo_was_closed_are_caught_up_then_reconciled() {
        let d = temp_dir("catchup");
        let (root, state) = (d.0.join("root"), d.0.join("state"));
        for rel in ["top.txt", "old/x.txt", "keep/y.txt"] {
            write(&root, rel, rel);
        }
        let cursor = WatchOptions {
            cursor_file: Some(state.join("cursor.json")),
            ..opts()
        };
        let before = scanner::scan(&root, &Manifest::new(), None, &ScanOptions::default(), None)
            .unwrap()
            .0;
        {
            let (w, rx) = start(&root, cursor.clone());
            until(&rx, "first rescan", |e| {
                e.kind == "rescan" && e.dirs.is_none()
            });
            let at = w.position().unwrap().expect("NTFS keeps a change journal");
            w.checkpoint(at).unwrap(); // the index (`before`) is saved
        } // Mewndo closes
        write(&root, "top.txt", "edited");
        write(&root, "sub2/new.txt", "new");
        fs::remove_file(root.join("old").join("x.txt")).unwrap();
        let (_w, rx) = start(&root, cursor);
        let (e, _) = until(&rx, "catch-up rescan", |e| e.kind == "rescan");
        let dirs = e.dirs.expect("the journal says which folders");
        for want in ["", "old", "sub2"] {
            assert!(
                dirs.iter().any(|d| d == want),
                "{want:?} missing from {dirs:?}"
            );
        }
        assert!(
            !dirs.iter().any(|d| d == "keep"),
            "keep/ didn't change: {dirs:?}"
        );
        let (partial, _) =
            scanner::scan(&root, &before, Some(&dirs), &ScanOptions::default(), None).unwrap();
        let full = scanner::scan(&root, &Manifest::new(), None, &ScanOptions::default(), None)
            .unwrap()
            .0;
        assert_eq!(
            partial, full,
            "the reconciliation scan of just those folders sees everything"
        );
    }

    #[test]
    fn an_overflow_is_caught_up_from_the_journal() {
        let d = temp_dir("overflow");
        fs::create_dir_all(d.0.join("burst")).unwrap();
        // A buffer too small for even one report: every batch overflows, as a big burst does.
        let (_w, rx) = start(
            &d.0,
            WatchOptions {
                buffer_bytes: 16,
                ..opts()
            },
        );
        until(&rx, "first rescan", |e| e.kind == "rescan");
        for i in 0..50 {
            fs::write(d.0.join("burst").join(format!("{i}.txt")), "x").unwrap();
        }
        let (e, _) = until(&rx, "an overflow rescan", |e| e.kind == "rescan");
        assert_eq!(
            e.message.as_deref(),
            Some("too many changes at once for the live feed")
        );
        assert_eq!(
            e.dirs.as_deref(),
            Some(&["burst".to_string()][..]),
            "the journal names the folder"
        );
    }

    #[test]
    fn a_short_8_3_alias_is_watched_as_its_long_real_path() {
        let d = temp_dir("alias");
        let long = d.0.join("a long folder name");
        fs::create_dir_all(&long).unwrap();
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let wide: Vec<u16> = long.as_os_str().encode_wide().chain([0]).collect();
        let mut buf = vec![0u16; 1024];
        let n = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                wide.as_ptr(),
                buf.as_mut_ptr(),
                1024,
            )
        } as usize;
        let short = PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
        if short == long || !short.exists() {
            return println!("skipped: 8.3 names are off on this drive");
        }
        let (w, _rx) = start(&short, opts());
        assert_eq!(display(w.real_root()), display(&real(&long).unwrap()));
        assert!(display(w.real_root()).ends_with("a long folder name"));
    }

    #[test]
    fn the_folder_disappearing_is_reported_as_gone() {
        let d = temp_dir("gone");
        let root = d.0.join("root");
        fs::create_dir_all(&root).unwrap();
        let (_w, rx) = start(&root, opts());
        until(&rx, "first rescan", |e| e.kind == "rescan");
        fs::remove_dir_all(&root).unwrap();
        until(&rx, "gone", |e| e.kind == "gone");
    }
}
