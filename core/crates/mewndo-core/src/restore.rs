// Restore engine (spec §28.6): runs a restore that the v0 Node engine planned (apps/desktop/engine/restore.js).
// Node compares the save point with the folder, makes the before-undo save point and writes the whole plan to the
// restore log before any step runs; this runs the log's steps and verifies. Every step is safe to run twice, so a
// restore interrupted by a crash is finished by running its log again (resuming).
//
// Order: trash new things, remove new empty folders, create folders, stage every file, rename them into place,
// then links. Nothing is deleted: anything new or about to be replaced is moved into the log's trash folder,
// <folder data>/trash/Restored/<start time>_<restore id>/<its relative path>.
//
// The restore ladder, fastest first, for each file:
//   1. Rename it back out of Mewndo's trash: a file this restore just moved aside, or (undoing a restore) one the
//      restore being undone moved aside. Only when its size and modified time say it's the version wanted.
//   2. and 4. From the store's hot cache (content stored in the last 24 hours, uncompressed); else copy it from the
//      store with the OS (store::copy_new: CopyFile2 on Windows, which block clones on ReFS and Dev Drive) when
//      the store keeps it as is; else unpack it.
// Measured on Windows with Defender on (docs/benchmarks.md): every file opened or created costs an antivirus scan,
// and unpacking a gzipped object costs the most, which is why the hot cache exists and why each staged file is
// written, timed and closed through one handle.
// ponytail: rung 3 of the spec (hard link from the store, broken on first write) needs copy-on-first-write
// watching; add it with the hot cache if copies turn out too slow (P1.6 benchmarks).
//
// Files are staged next to where they go (a temp name in the same folder: same volume, and they get that folder's
// permissions, which a file staged elsewhere and moved in would not), then renamed into place. Nothing is
// flushed per file: one flush pass at the end, before the user is told "restored". Then verification (a fresh
// scan with full rehash) runs and its result is written to the restore log.
use crate::paths::{display, exact};
use crate::scanner::{self, Kind, Manifest, ScanOptions, mtime_ms, node_code};
use crate::store::{self, Source, Store, StoreError, TEMP_SUFFIX, parallel_map, write_file_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, Metadata};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Locked files (antivirus, an open editor) usually free up quickly on Windows: retry these, as v0 does.
const LOCKED: &[&str] = &["EBUSY", "EPERM", "EACCES"];
const RETRIES: u32 = 4;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Op {
    Trash,
    Rmdir,
    Mkdir,
    Write,
    Link,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Trash => "trash",
            Op::Rmdir => "rmdir",
            Op::Mkdir => "mkdir",
            Op::Write => "write",
            Op::Link => "link",
        }
    }
}

/// One step of the log. write: the hash, size and modified time wanted. trash: what the folder's index said the
/// item was (hash, size, time), so a file moved aside can be renamed back if the same content is wanted elsewhere.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    op: Op,
    path: String,
    hash: Option<String>,
    size: Option<u64>,
    mtime_ms: Option<f64>,
    target: Option<String>,
}

/// The parts of v0's restore log this reads. The log is kept whole otherwise: the result is added to it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Log {
    id: String,
    save_point_id: String,
    base: PathBuf,
    trash_root: PathBuf,
    paths: Option<Vec<String>>,
    steps: Vec<Step>,
    /// Trash folders of the restores this one undoes: where rung 1 looks for files.
    #[serde(default)]
    trash_from: Vec<PathBuf>,
}

pub struct Options {
    /// What a fresh scan of the folder uses (verification): the folder's current settings.
    pub scan: ScanOptions,
    pub resuming: bool,
    pub retry_delay_ms: u64,
    /// Tests only: stop with "simulated crash" before step number n, as if the power went.
    pub crash_after_steps: Option<usize>,
}

/// v0's counts, exactly these.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    written: usize,
    linked: usize,
    trashed: usize,
    folders_created: usize,
    folders_removed: usize,
}

/// How each written file got there: which rung of the ladder.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ladder {
    from_trash: usize,
    hot: usize,
    copied: usize,
    unpacked: usize,
}

#[derive(Default)]
struct Outcome {
    counts: Counts,
    ladder: Ladder,
    failures: Vec<Value>,
    retried: Vec<Value>,
    /// Files put in place, for the flush at the end.
    placed: Vec<PathBuf>,
}

/// Where a file to write comes from, once staged.
enum Staged {
    /// Already right (a resumed restore got this far before).
    Done,
    /// A temp file next to its place, from the store.
    Temp(PathBuf, Source),
    /// A file in Mewndo's trash.
    Trash(PathBuf),
}

/// An event for the app (the protocol wraps it).
pub type Emit<'a> = &'a (dyn Fn(Value) + Sync);

fn other(msg: &str) -> io::Error {
    io::Error::other(msg.to_string())
}

fn from_store(e: StoreError) -> io::Error {
    match e {
        StoreError::Io(e) => e,
        e => io::Error::other(e.to_string()),
    }
}

/// What v0 reports for an error: Node's code for one from the system, the message otherwise.
fn code_of(e: &io::Error) -> String {
    if e.raw_os_error().is_some() || e.kind() == io::ErrorKind::NotFound {
        node_code(e)
    } else {
        e.to_string()
    }
}

fn lstat(p: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(p) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn to_abs(base: &Path, rel: &str) -> PathBuf {
    exact(&base.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// . and .. resolved as text, never through links (Node's path.resolve).
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// Link targets compare as resolved paths: Windows may report a junction's target differently than it was set.
fn same_target(a: &str, b: &str, link: &Path) -> bool {
    let dir = link.parent().map(display).unwrap_or_default();
    let norm = |t: &str| lexical(&Path::new(&dir).join(t.strip_prefix(r"\\?\").unwrap_or(t)));
    a == b || same_path(&norm(a), &norm(b))
}

/// Refuse to work through a link: the parent folder's real path must be exactly where it's expected.
// ponytail: a link swapped in between this check and the write can't be fully blocked (as in v0).
fn check_parent(abs: &Path) -> io::Result<()> {
    let parent = abs.parent().ok_or_else(|| other("no parent folder"))?;
    if !same_path(&fs::canonicalize(parent)?, &exact(parent)) {
        return Err(other("a link or junction is in the way"));
    }
    Ok(())
}

/// A temp name next to `abs` in v0's form, <name>.<uuid>.mewndo-tmp, so either engine cleans up after a crash.
fn temp_name(abs: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut s: OsString = abs.as_os_str().to_owned();
    s.push(format!(
        ".{:08x}-{:04x}-{:04x}-{:04x}-{:012x}{TEMP_SUFFIX}",
        nanos as u32,
        (nanos >> 32) as u16,
        std::process::id() as u16,
        (n >> 48) as u16,
        n & 0xffff_ffff_ffff
    ));
    PathBuf::from(s)
}

/// Mewndo's own temp names only: <anything>.<8-4-4-4-12 hex>.mewndo-tmp.
fn is_own_temp(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(TEMP_SUFFIX) else {
        return false;
    };
    let Some(uuid) = stem.len().checked_sub(37).and_then(|i| stem.get(i..)) else {
        return false;
    };
    uuid.bytes().enumerate().all(|(i, b)| match i {
        0 => b == b'.',
        9 | 14 | 19 | 24 => b == b'-',
        _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
    })
}

/// A time in Node's milliseconds since 1970.
fn time_of(ms: f64) -> SystemTime {
    if ms >= 0.0 {
        UNIX_EPOCH + Duration::from_secs_f64(ms / 1000.0)
    } else {
        UNIX_EPOCH - Duration::from_secs_f64(-ms / 1000.0)
    }
}

fn set_mtime(p: &Path, ms: f64) -> io::Result<()> {
    File::options()
        .write(true)
        .open(p)?
        .set_modified(time_of(ms))
}

/// Remove a link: a file symlink, or a junction or folder symlink (a folder to Windows).
fn remove_link(p: &Path) -> io::Result<()> {
    fs::remove_file(p).or_else(|e| {
        if cfg!(windows) {
            fs::remove_dir(p)
        } else {
            Err(e)
        }
    })
}

/// Move an item into the trash folder, keeping its relative path (numbered if that name is taken). Returns where
/// it went, or None if it's already gone (or was moved before a crash).
fn move_to_trash(abs: &Path, rel: &str, trash_root: &Path) -> io::Result<Option<PathBuf>> {
    let Some(m) = lstat(abs)? else {
        return Ok(None);
    };
    if m.is_dir() {
        return Err(other("a folder is in the way"));
    }
    check_parent(abs)?;
    let first = to_abs(trash_root, rel);
    let mut dest = first.clone();
    for i in 1.. {
        if lstat(&dest)?.is_none() {
            break;
        }
        let mut s = first.as_os_str().to_owned();
        s.push(format!(".{i}"));
        dest = PathBuf::from(s);
    }
    fs::create_dir_all(dest.parent().expect("trash items have a folder"))?;
    match fs::rename(abs, &dest) {
        Ok(()) => Ok(Some(dest)),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            // The trash is on another drive: copy, check, then remove the original.
            if m.file_type().is_symlink() {
                let mut s = dest.as_os_str().to_owned();
                s.push(".link.json");
                let target = display(&fs::read_link(abs)?);
                write_file_atomic(
                    Path::new(&s),
                    json!({ "target": target }).to_string().as_bytes(),
                )?;
                remove_link(abs)?;
                return Ok(None); // not a file that can be renamed back
            }
            store::copy_new(abs, &dest)?;
            if store::hash_file(&dest, None).map_err(from_store)?
                != store::hash_file(abs, None).map_err(from_store)?
            {
                return Err(other("copy to trash did not match"));
            }
            fs::remove_file(abs)?;
            Ok(Some(dest))
        }
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn make_link(target: &str, at: &Path, _place: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

/// As v0 (Node) does: a link to a folder becomes a junction (no admin rights needed), anything else a file symlink.
#[cfg(windows)]
fn make_link(target: &str, at: &Path, place: &Path) -> io::Result<()> {
    let resolved = lexical(&place.parent().expect("links have a folder").join(target));
    if fs::metadata(&resolved).is_ok_and(|m| m.is_dir()) {
        junction(&resolved, at)
    } else {
        std::os::windows::fs::symlink_file(target, at)
    }
}

/// Make a directory junction at `at` pointing to the absolute folder `target`.
#[cfg(windows)]
fn junction(target: &Path, at: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let shown = display(target);
    let print: Vec<u16> = std::ffi::OsStr::new(&shown).encode_wide().collect();
    let substitute: Vec<u16> = std::ffi::OsStr::new(&format!(r"\??\{shown}"))
        .encode_wide()
        .collect();
    let len = |v: &[u16]| (v.len() * 2) as u16;
    // REPARSE_DATA_BUFFER for a mount point: the tag, the data length, a reserved word, then where each name sits
    // in the path buffer (bytes), then both names, each ending in a NUL.
    let mut buf: Vec<u8> = Vec::new();
    buf.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buf.extend((8 + len(&substitute) + len(&print) + 4).to_le_bytes());
    buf.extend(0u16.to_le_bytes());
    buf.extend(0u16.to_le_bytes());
    buf.extend(len(&substitute).to_le_bytes());
    buf.extend((len(&substitute) + 2).to_le_bytes());
    buf.extend(len(&print).to_le_bytes());
    for c in substitute.iter().chain(&[0]).chain(&print).chain(&[0]) {
        buf.extend(c.to_le_bytes());
    }
    fs::create_dir(at)?;
    let set = (|| {
        let dir = File::options()
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(at)?;
        let mut returned = 0u32;
        // SAFETY: a valid open handle, and a buffer that lives for the call with its true length.
        let ok = unsafe {
            DeviceIoControl(
                dir.as_raw_handle() as _,
                FSCTL_SET_REPARSE_POINT,
                buf.as_ptr() as _,
                buf.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })();
    if set.is_err() {
        let _ = fs::remove_dir(at);
    }
    set
}

/// Run fn, retrying locked-file errors with a growing wait. `attempts` counts every try.
fn retry<T>(
    delay_ms: u64,
    attempts: &mut u32,
    mut on_retry: impl FnMut(u32, &io::Error),
    mut f: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    loop {
        match f() {
            Err(e) if *attempts <= RETRIES && LOCKED.contains(&code_of(&e).as_str()) => {
                std::thread::sleep(Duration::from_millis(delay_ms << (*attempts - 1)));
                *attempts += 1;
                on_retry(*attempts, &e);
            }
            done => return done,
        }
    }
}

/// Selected paths are relative and '/'-separated. A folder selects everything under it. None: everything.
fn selector(paths: &Option<Vec<String>>) -> impl Fn(&str) -> bool + '_ {
    let clean: Option<Vec<String>> = paths.as_ref().map(|ps| {
        ps.iter()
            .map(|p| p.replace('\\', "/").trim_end_matches('/').to_string())
            .collect()
    });
    move |p: &str| {
        clean.as_ref().is_none_or(|ps| {
            ps.iter().any(|s| {
                p == s
                    || p.strip_prefix(s.as_str())
                        .is_some_and(|r| r.starts_with('/'))
            })
        })
    }
}

/// Paths in the folder that differ from the save point. Unrestorable entries are left out (v0's verify).
fn mismatches(
    target: &Manifest,
    now: &Manifest,
    paths: &Option<Vec<String>>,
    base: &Path,
) -> Vec<String> {
    let sel = selector(paths);
    let mut out: Vec<String> = Vec::new();
    for (p, want) in target.iter().filter(|(p, _)| sel(p)) {
        let have = now.get(p);
        let ok = match want.kind {
            Kind::Directory => have.is_some_and(|h| h.kind == Kind::Directory),
            Kind::File => {
                want.hash.is_none()
                    || have.is_some_and(|h| h.kind == Kind::File && h.hash == want.hash)
            }
            Kind::Link => want.target.as_ref().is_none_or(|t| {
                have.is_some_and(|h| {
                    h.kind == Kind::Link
                        && h.target
                            .as_ref()
                            .is_some_and(|ht| same_target(ht, t, &to_abs(base, p)))
                })
            }),
            Kind::Unknown => true,
        };
        if !ok {
            out.push(p.clone());
        }
    }
    out.extend(
        now.keys()
            .filter(|p| sel(p) && !target.contains_key(*p))
            .cloned(),
    );
    out.sort();
    out
}

/// Leftover temp files from a crash mid-write, next to the files being restored. Only Mewndo's own names.
fn remove_own_temps(log: &Log) {
    let mut dirs: Vec<PathBuf> = log
        .steps
        .iter()
        .filter(|s| matches!(s.op, Op::Write | Op::Link))
        .filter_map(|s| to_abs(&log.base, &s.path).parent().map(Path::to_path_buf))
        .collect();
    dirs.sort();
    dirs.dedup();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if is_own_temp(&entry.file_name().to_string_lossy()) {
                let _ = remove_link(&entry.path());
            }
        }
    }
}

/// Flush what was written, once, at the end. Linux: the whole file system in one call. Elsewhere every file, in
/// parallel. ponytail: a flush that fails is ignored; the files are in place, and verification reads them back.
fn flush(base: &Path, placed: &[PathBuf]) {
    #[cfg(target_os = "linux")]
    if let Ok(dir) = File::open(base) {
        use std::os::fd::AsRawFd;
        // SAFETY: a valid open descriptor.
        if unsafe { libc::syncfs(dir.as_raw_fd()) } == 0 {
            return;
        }
    }
    let _ = base;
    parallel_map(placed, |p| {
        File::options()
            .write(true)
            .open(p)
            .and_then(|f| f.sync_all())
    });
}

/// Now, as JavaScript's toISOString gives it: 2026-10-05T12:34:56.789Z.
fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Days since 1970 to a calendar date (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

struct Run<'a> {
    log: &'a Log,
    store: &'a Store,
    opts: &'a Options,
    emit: Emit<'a>,
    outcome: Mutex<Outcome>,
    /// Files this restore moved aside, by hash, whose size and time matched the index: rung 1.
    trashed: Mutex<HashMap<String, Vec<PathBuf>>>,
    /// Folders already checked for links in the way while staging (see stage).
    checked: Mutex<HashSet<PathBuf>>,
    done: AtomicUsize,
    last_progress: Mutex<Instant>,
    crashed: AtomicBool,
}

impl Run<'_> {
    fn abs(&self, step: &Step) -> PathBuf {
        to_abs(&self.log.base, &step.path)
    }

    fn progress(&self, phase: &str, force: bool) {
        let done = self.done.load(Ordering::Relaxed);
        let mut last = self.last_progress.lock().unwrap_or_else(|e| e.into_inner());
        if force || last.elapsed() >= Duration::from_millis(100) {
            *last = Instant::now();
            (self.emit)(json!({
                "kind": "restore_progress", "restore": self.log.id, "phase": phase,
                "done": done, "total": self.log.steps.len(),
            }));
        }
    }

    /// True (and remembered) when a test's simulated crash comes before step i.
    fn crash_before(&self, i: usize) -> bool {
        if self.opts.crash_after_steps.is_some_and(|n| i >= n) {
            self.crashed.store(true, Ordering::Relaxed);
        }
        self.crashed.load(Ordering::Relaxed)
    }

    /// Retry `f` for step i, telling the app about each retry.
    fn retry<T>(
        &self,
        step: &Step,
        attempts: &mut u32,
        f: impl FnMut() -> io::Result<T>,
    ) -> io::Result<T> {
        retry(
            self.opts.retry_delay_ms,
            attempts,
            |attempt, e| {
                (self.emit)(json!({
                    "kind": "restore_retry", "restore": self.log.id, "path": step.path,
                    "op": step.op.name(), "attempt": attempt, "error": code_of(e),
                }))
            },
            f,
        )
    }

    /// Record how a step ended. did: it changed something (false: already done).
    fn finish(&self, step: &Step, result: io::Result<bool>, attempts: u32) {
        let mut o = self.outcome.lock().unwrap_or_else(|e| e.into_inner());
        match result {
            Ok(did) => {
                if did {
                    let c = &mut o.counts;
                    *match step.op {
                        Op::Trash => &mut c.trashed,
                        Op::Rmdir => &mut c.folders_removed,
                        Op::Mkdir => &mut c.folders_created,
                        Op::Write => &mut c.written,
                        Op::Link => &mut c.linked,
                    } += 1;
                }
                if attempts > 1 {
                    o.retried.push(
                        json!({ "path": step.path, "op": step.op.name(), "attempts": attempts }),
                    );
                }
            }
            Err(e) => {
                let error = code_of(&e);
                let plural = if attempts > 1 { "s" } else { "" };
                o.failures.push(json!({
                    "path": step.path, "op": step.op.name(), "error": error, "attempts": attempts,
                    "message": format!("Could not {} {} after {attempts} attempt{plural}: {error}", step.op.name(), step.path),
                }));
            }
        }
        drop(o);
        self.done.fetch_add(1, Ordering::Relaxed);
        self.progress("restoring", false);
    }

    fn trash(&self, step: &Step) -> io::Result<bool> {
        let abs = self.abs(step);
        // Remember a file moved aside if it's still what the index says: the same content may be wanted elsewhere
        // (a rename undone), and renaming it back beats copying.
        let known = lstat(&abs)?.filter(|m| {
            m.is_file() && Some(m.len()) == step.size && Some(mtime_ms(m)) == step.mtime_ms
        });
        let moved = move_to_trash(&abs, &step.path, &self.log.trash_root)?;
        if let (Some(dest), Some(_), Some(hash)) = (&moved, known, &step.hash) {
            let mut trashed = self.trashed.lock().unwrap_or_else(|e| e.into_inner());
            trashed.entry(hash.clone()).or_default().push(dest.clone());
        }
        Ok(moved.is_some())
    }

    fn rmdir(&self, step: &Step) -> io::Result<bool> {
        let abs = self.abs(step);
        if !lstat(&abs)?.is_some_and(|m| m.is_dir()) {
            return Ok(false);
        }
        match fs::remove_dir(&abs) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(false), // still holds ignored or failed items
            Err(e) => Err(e),
        }
    }

    fn mkdir(&self, step: &Step) -> io::Result<bool> {
        let abs = self.abs(step);
        match lstat(&abs)? {
            Some(m) if m.is_dir() => Ok(false),
            Some(_) => Err(other("something is in the way")),
            None => {
                check_parent(&abs)?;
                fs::create_dir(&abs).map(|()| true)
            }
        }
    }

    /// Rung 1: the wanted version, sitting in Mewndo's trash.
    fn in_trash(&self, step: &Step, hash: &str, mtime: f64) -> Option<PathBuf> {
        let mut trashed = self.trashed.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = trashed.get_mut(hash).and_then(Vec::pop) {
            drop(trashed);
            if set_mtime(&p, mtime).is_ok() {
                return Some(p);
            }
        } else {
            drop(trashed);
        }
        self.log
            .trash_from
            .iter()
            .map(|root| to_abs(root, &step.path))
            .find(|p| {
                lstat(p).ok().flatten().is_some_and(|m| {
                    // Within 1 µs: a time set from milliseconds doesn't always read back as the same f64.
                    m.is_file()
                        && Some(m.len()) == step.size
                        && (mtime_ms(&m) - mtime).abs() < 0.001
                })
            })
    }

    /// Get a file ready next to its place (or find it in the trash). Touches nothing the user has.
    fn stage(&self, step: &Step) -> io::Result<Staged> {
        let (Some(hash), Some(mtime)) = (&step.hash, step.mtime_ms) else {
            return Err(other("the log has no content for this file"));
        };
        let abs = self.abs(step);
        let st = lstat(&abs)?;
        // Only a resumed restore can find a file already right; a new plan lists only files that differ.
        if self.opts.resuming
            && st
                .as_ref()
                .is_some_and(|m| m.is_file() && Some(m.len()) == step.size)
            && store::hash_file(&abs, None).ok().as_ref() == Some(hash)
        {
            return Ok(Staged::Done);
        }
        if st.as_ref().is_some_and(Metadata::is_dir) {
            return Err(other("a folder is in the way"));
        }
        // Once per folder while staging: thousands of files in a folder needn't each ask whether it's a link.
        // ponytail: a link swapped in after the check can't be fully blocked anyway (see check_parent).
        let parent = abs.parent().map(Path::to_path_buf).unwrap_or_default();
        if !self
            .checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&parent)
        {
            check_parent(&abs)?;
            self.checked
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(parent);
        }
        if let Some(p) = self.in_trash(step, hash, mtime) {
            return Ok(Staged::Trash(p));
        }
        let tmp = temp_name(&abs);
        let source = self
            .store
            .restore_to(hash, &tmp, time_of(mtime))
            .map_err(from_store)?;
        Ok(Staged::Temp(tmp, source))
    }

    /// Rename a staged file into place, moving what's there now into the trash first.
    fn place(&self, step: &Step, from: &Path) -> io::Result<()> {
        let abs = self.abs(step);
        if lstat(&abs)?.is_some_and(|m| m.is_dir()) {
            return Err(other("a folder is in the way"));
        }
        move_to_trash(&abs, &step.path, &self.log.trash_root)?;
        fs::rename(from, &abs)
    }

    fn link(&self, step: &Step) -> io::Result<bool> {
        let target = step
            .target
            .as_deref()
            .ok_or_else(|| other("the log has no link target"))?;
        let abs = self.abs(step);
        let st = lstat(&abs)?;
        if let Some(m) = &st {
            if m.file_type().is_symlink()
                && same_target(&display(&fs::read_link(&abs)?), target, &abs)
            {
                return Ok(false);
            }
            if m.is_dir() {
                return Err(other("a folder is in the way"));
            }
        }
        check_parent(&abs)?;
        let tmp = temp_name(&abs);
        make_link(target, &tmp, &abs)?;
        let placed = move_to_trash(&abs, &step.path, &self.log.trash_root)
            .and_then(|_| fs::rename(&tmp, &abs));
        if placed.is_err() {
            let _ = remove_link(&tmp);
        }
        placed.map(|()| true)
    }

    /// One step that isn't a file write, with retries.
    fn simple(&self, i: usize) {
        if self.crash_before(i) {
            return;
        }
        let step = &self.log.steps[i];
        let mut attempts = 1;
        let result = self.retry(step, &mut attempts, || match step.op {
            Op::Trash => self.trash(step),
            Op::Rmdir => self.rmdir(step),
            Op::Mkdir => self.mkdir(step),
            Op::Link => self.link(step),
            Op::Write => unreachable!("writes are staged"),
        });
        self.finish(step, result, attempts);
    }

    /// File writes: stage them all in parallel, then rename them all into place.
    fn writes(&self, items: &[usize]) {
        let staged: Vec<Option<(io::Result<Staged>, u32)>> = parallel_map(items, |&i| {
            if self.crash_before(i) {
                return None;
            }
            let step = &self.log.steps[i];
            let mut attempts = 1;
            let s = self.retry(step, &mut attempts, || self.stage(step));
            Some((s, attempts))
        });
        let work: Vec<(usize, io::Result<Staged>, u32)> = items
            .iter()
            .zip(staged)
            .filter_map(|(&i, s)| s.map(|(s, a)| (i, s, a)))
            .collect();
        self.progress("restoring", true);
        parallel_map(&work, |(i, staged, attempts)| {
            let step = &self.log.steps[*i];
            let mut attempts = *attempts;
            let result = match staged {
                Err(e) => Err(clone_err(e)),
                Ok(Staged::Done) => Ok(false),
                Ok(Staged::Temp(tmp, source)) => {
                    let r = self.retry(step, &mut attempts, || self.place(step, tmp));
                    if r.is_err() {
                        let _ = fs::remove_file(tmp);
                    } else {
                        let mut o = self.outcome.lock().unwrap_or_else(|e| e.into_inner());
                        *match source {
                            Source::Hot => &mut o.ladder.hot,
                            Source::Copied => &mut o.ladder.copied,
                            Source::Unpacked => &mut o.ladder.unpacked,
                        } += 1;
                    }
                    r.map(|()| true)
                }
                Ok(Staged::Trash(from)) => {
                    // A failure leaves it in the trash: never lost.
                    let r = self.retry(step, &mut attempts, || self.place(step, from));
                    if r.is_ok() {
                        self.outcome
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .ladder
                            .from_trash += 1;
                    }
                    r.map(|()| true)
                }
            };
            if result.as_ref().is_ok_and(|did| *did) {
                let abs = self.abs(step);
                self.outcome
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .placed
                    .push(abs);
            }
            self.finish(step, result, attempts);
        });
    }
}

/// An io::Error can't be cloned; keep what matters (the OS code, or the message).
fn clone_err(e: &io::Error) -> io::Error {
    match e.raw_os_error() {
        Some(code) => io::Error::from_raw_os_error(code),
        None => io::Error::new(e.kind(), e.to_string()),
    }
}

fn read_json(p: &Path) -> io::Result<Value> {
    serde_json::from_slice(&fs::read(exact(p))?)
        .map_err(|e| other(&format!("{}: {e}", p.display())))
}

/// Run, or finish (resuming), the restore whose log is at `log_file`, in <folder data>/restores/. Files go in place
/// and are flushed, the app is told ("restore_progress", phase "restored"), then the folder is verified and the
/// result is written to the log and returned (v0's result, plus `ladder` and `timings`).
pub fn run(log_file: &Path, store: &Store, opts: &Options, emit: Emit) -> io::Result<Value> {
    let started = Instant::now();
    let mut log_value = read_json(log_file)?;
    let log: Log = serde_json::from_value(log_value.clone())
        .map_err(|e| other(&format!("restore log: {e}")))?;
    let folder_dir = log_file
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| other("a restore log lives in <folder data>/restores"))?;
    if opts.resuming {
        remove_own_temps(&log);
    }
    let run = Run {
        log: &log,
        store,
        opts,
        emit,
        outcome: Mutex::new(Outcome::default()),
        trashed: Mutex::new(HashMap::new()),
        checked: Mutex::new(HashSet::new()),
        done: AtomicUsize::new(0),
        last_progress: Mutex::new(Instant::now()),
        crashed: AtomicBool::new(false),
    };
    // Phase by phase (same op = one phase). Folder steps one at a time, deepest or shallowest first as listed;
    // the rest touch distinct paths, so they run in parallel.
    let mut phases: Vec<(Op, Vec<usize>)> = Vec::new();
    for (i, step) in log.steps.iter().enumerate() {
        match phases.last_mut() {
            Some((op, items)) if *op == step.op => items.push(i),
            _ => phases.push((step.op, vec![i])),
        }
    }
    for (op, items) in &phases {
        match op {
            Op::Rmdir | Op::Mkdir => items.iter().for_each(|&i| run.simple(i)),
            Op::Write => run.writes(items),
            Op::Trash | Op::Link => {
                parallel_map(items, |&i| run.simple(i));
            }
        }
        if run.crashed.load(Ordering::Relaxed) {
            return Err(other("simulated crash"));
        }
    }
    let outcome = run.outcome.into_inner().unwrap_or_else(|e| e.into_inner());
    flush(&exact(&log.base), &outcome.placed);
    let placed_ms = started.elapsed().as_millis() as u64;
    run.done.store(log.steps.len(), Ordering::Relaxed);
    let tell = |phase: &str| {
        emit(json!({
            "kind": "restore_progress", "restore": log.id, "phase": phase,
            "done": log.steps.len(), "total": log.steps.len(),
        }))
    };
    tell("restored");

    // Verify what is really on disk, not what the index assumes: a fresh scan with full rehash.
    tell("verifying");
    let save_point = read_json(
        &folder_dir
            .join("savepoints")
            .join(format!("{}.json", log.save_point_id)),
    )?;
    let target: Manifest = serde_json::from_value(save_point["index"].clone())
        .map_err(|e| other(&format!("save point: {e}")))?;
    let (now, _) = scanner::scan(&log.base, &Manifest::new(), None, &opts.scan, None)?;
    let mismatches = mismatches(&target, &now, &log.paths, &log.base);
    let result = json!({
        "id": log.id, "savePointId": log_value["savePointId"], "beforeUndoId": log_value["beforeUndoId"],
        "folder": log_value["base"], "trashFolder": log_value["trashRoot"], "resumed": opts.resuming,
        "counts": outcome.counts, "failures": outcome.failures, "retried": outcome.retried,
        "verified": mismatches.is_empty(), "mismatches": mismatches, "ladder": outcome.ladder,
        "timings": { "placedMs": placed_ms, "verifiedMs": started.elapsed().as_millis() as u64 },
    });
    log_value["status"] = json!("done");
    log_value["finishedAt"] = json!(iso_now());
    log_value["result"] = result.clone();
    write_file_atomic(log_file, log_value.to_string().as_bytes())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn temp_dir() -> Dir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!(
            "mewndo-restore-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        Dir(fs::canonicalize(&d)
            .map(|p| PathBuf::from(display(&p)))
            .unwrap())
    }
    fn write(root: &Path, rel: &str, content: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }
    fn opts() -> Options {
        Options {
            scan: ScanOptions {
                skip_online_only: false,
                ..ScanOptions::default()
            },
            resuming: false,
            retry_delay_ms: 1,
            crash_after_steps: None,
        }
    }

    /// A protected folder, a data folder beside it and a store. `save` scans the folder into a save point (storing
    /// its files) and returns the index; `log` writes a restore log for steps toward that save point.
    struct Setup {
        _base: Dir,
        root: PathBuf,
        data: PathBuf,
        store: Store,
    }
    impl Setup {
        fn new(files: &[(&str, &[u8])]) -> Setup {
            let base = temp_dir();
            let root = base.0.join("project");
            fs::create_dir_all(&root).unwrap();
            for (rel, content) in files {
                write(&root, rel, content);
            }
            let data = base.0.join("data");
            let store = Store::new(&data.join("store"));
            Setup {
                root,
                store,
                data,
                _base: base,
            }
        }
        fn scan(&self) -> Manifest {
            scanner::scan(
                &self.root,
                &Manifest::new(),
                None,
                &opts().scan,
                Some(&self.store),
            )
            .unwrap()
            .0
        }
        fn save(&self, id: &str) -> Manifest {
            let index = self.scan();
            write_file_atomic(
                &self.data.join("savepoints").join(format!("{id}.json")),
                json!({ "id": id, "index": index }).to_string().as_bytes(),
            )
            .unwrap();
            index
        }
        fn log(&self, save_point: &str, steps: Value, trash_from: Value) -> PathBuf {
            let file = self.data.join("restores").join("r1.json");
            let log = json!({
                "id": "r1", "status": "running", "savePointId": save_point, "beforeUndoId": null,
                "base": display(&self.root), "inPlace": true, "paths": null, "steps": steps,
                "trashRoot": display(&self.data.join("trash").join("r1")), "trashFrom": trash_from,
            });
            write_file_atomic(&file, log.to_string().as_bytes()).unwrap();
            file
        }
    }
    fn write_step(index: &Manifest, rel: &str) -> Value {
        let e = &index[rel];
        json!({ "op": "write", "path": rel, "hash": e.hash, "size": e.size, "mtimeMs": e.mtime_ms })
    }
    fn trash_step(index: &Manifest, rel: &str) -> Value {
        let e = &index[rel];
        json!({ "op": "trash", "path": rel, "hash": e.hash, "size": e.size, "mtimeMs": e.mtime_ms })
    }
    fn nothing(_: Value) {}

    #[test]
    fn copies_or_unpacks_from_the_store_trashes_what_is_new_verifies_and_writes_the_log() {
        let s = Setup::new(&[
            ("a.txt", b"A text"),
            ("photo.png", b"png bytes"),
            ("docs/b.md", b"B"),
        ]);
        let want = s.save("sp");
        fs::remove_file(s.root.join("a.txt")).unwrap();
        fs::remove_file(s.root.join("photo.png")).unwrap();
        fs::remove_dir_all(s.root.join("docs")).unwrap();
        write(&s.root, "new/agent.txt", b"agent");
        let now = s.scan();
        let log = s.log(
            "sp",
            json!([trash_step(&now, "new/agent.txt"), { "op": "rmdir", "path": "new" }, { "op": "mkdir", "path": "docs" },
                write_step(&want, "a.txt"), write_step(&want, "docs/b.md"), write_step(&want, "photo.png")]),
            json!([]),
        );
        let events = Mutex::new(Vec::new());
        let r = run(&log, &s.store, &opts(), &|e| events.lock().unwrap().push(e)).unwrap();
        assert_eq!(r["verified"], true, "{r}");
        assert_eq!(
            r["counts"],
            json!({ "written": 3, "linked": 0, "trashed": 1, "foldersCreated": 1, "foldersRemoved": 1 })
        );
        assert_eq!(
            r["ladder"],
            json!({ "fromTrash": 0, "hot": 2, "copied": 1, "unpacked": 0 })
        ); // .png is stored as is
        assert_eq!(fs::read(s.root.join("docs/b.md")).unwrap(), b"B");
        assert!(!s.root.join("new").exists());
        assert_eq!(
            fs::read(s.data.join("trash/r1/new/agent.txt")).unwrap(),
            b"agent"
        );
        let m = fs::symlink_metadata(s.root.join("a.txt")).unwrap();
        assert_eq!(
            Some(mtime_ms(&m)).map(|t| (t - want["a.txt"].mtime_ms.unwrap()).abs() < 1.0),
            Some(true)
        );
        let written = read_json(&log).unwrap();
        assert_eq!(written["status"], "done");
        assert_eq!(written["result"]["verified"], true);
        let phases: Vec<Value> = events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["phase"].clone())
            .collect();
        assert!(phases.contains(&json!("restored")) && phases.last() == Some(&json!("verifying")));
    }

    #[test]
    fn renames_files_back_out_of_the_trash_when_they_are_the_wanted_version() {
        // A rename undone: the moved file is trashed and renamed back to its old name, not copied.
        let s = Setup::new(&[("c.txt", b"C content")]);
        let want = s.save("sp");
        fs::rename(s.root.join("c.txt"), s.root.join("c-renamed.txt")).unwrap();
        let now = s.scan();
        let log = s.log(
            "sp",
            json!([
                trash_step(&now, "c-renamed.txt"),
                write_step(&want, "c.txt")
            ]),
            json!([]),
        );
        let r = run(&log, &s.store, &opts(), &nothing).unwrap();
        assert_eq!(r["verified"], true, "{r}");
        assert_eq!(r["ladder"]["fromTrash"], 1);
        assert!(!s.data.join("trash/r1/c-renamed.txt").exists());

        // Undoing an earlier restore: its trash holds the wanted versions.
        let earlier = s.data.join("earlier-trash");
        write(&earlier, "c.txt", b"C content");
        fs::remove_file(s.root.join("c.txt")).unwrap();
        let file = earlier.join("c.txt");
        set_mtime(&file, want["c.txt"].mtime_ms.unwrap()).unwrap();
        let log = s.log(
            "sp",
            json!([write_step(&want, "c.txt")]),
            json!([display(&earlier)]),
        );
        let r = run(&log, &s.store, &opts(), &nothing).unwrap();
        assert_eq!(r["verified"], true, "{r}");
        assert_eq!(r["ladder"]["fromTrash"], 1);
        assert!(!file.exists());
    }

    #[test]
    fn a_trash_file_that_changed_is_left_alone_and_the_store_used() {
        let s = Setup::new(&[("c.txt", b"C content")]);
        let want = s.save("sp");
        let earlier = s.data.join("earlier-trash");
        write(&earlier, "c.txt", b"other bytes"); // size and time differ
        fs::remove_file(s.root.join("c.txt")).unwrap();
        s.store.clean_hot(Duration::ZERO).unwrap(); // a day later: unpacked from the store
        let log = s.log(
            "sp",
            json!([write_step(&want, "c.txt")]),
            json!([display(&earlier)]),
        );
        let r = run(&log, &s.store, &opts(), &nothing).unwrap();
        assert_eq!(r["verified"], true, "{r}");
        assert_eq!(
            r["ladder"],
            json!({ "fromTrash": 0, "hot": 0, "copied": 0, "unpacked": 1 })
        );
        assert_eq!(fs::read(earlier.join("c.txt")).unwrap(), b"other bytes");
    }

    #[test]
    fn a_simulated_crash_leaves_the_log_running_and_resuming_finishes_it_and_cleans_temps() {
        let s = Setup::new(&[("a.txt", b"A"), ("b.txt", b"B")]);
        let want = s.save("sp");
        fs::remove_file(s.root.join("a.txt")).unwrap();
        fs::write(s.root.join("b.txt"), b"B edited").unwrap();
        let log = s.log(
            "sp",
            json!([write_step(&want, "a.txt"), write_step(&want, "b.txt")]),
            json!([]),
        );
        let crash = Options {
            crash_after_steps: Some(0),
            ..opts()
        };
        assert_eq!(
            run(&log, &s.store, &crash, &nothing)
                .unwrap_err()
                .to_string(),
            "simulated crash"
        );
        assert_eq!(read_json(&log).unwrap()["status"], "running");
        let leftover = s
            .root
            .join("a.txt.12345678-1234-1234-1234-123456789abc.mewndo-tmp");
        fs::write(&leftover, "half-written").unwrap();
        let not_ours = s.root.join("notes.mewndo-tmp");
        fs::write(&not_ours, "a user's file").unwrap();

        let r = run(
            &log,
            &s.store,
            &Options {
                resuming: true,
                ..opts()
            },
            &nothing,
        )
        .unwrap();
        assert_eq!(r["resumed"], true);
        assert_eq!(fs::read(s.root.join("b.txt")).unwrap(), b"B");
        assert!(!leftover.exists());
        assert!(not_ours.exists());
        assert_eq!(
            fs::read(s.data.join("trash/r1/b.txt")).unwrap(),
            b"B edited"
        );
    }

    #[test]
    fn a_removed_folder_link_is_recreated_as_a_link() {
        let s = Setup::new(&[("a.txt", b"A")]);
        let outside = s.data.join("outside");
        write(&outside, "x.txt", b"outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, s.root.join("shared")).unwrap();
        #[cfg(windows)]
        junction(&outside, &exact(&s.root.join("shared"))).unwrap();
        let want = s.save("sp");
        let target = want["shared"].target.clone().unwrap();
        remove_link(&s.root.join("shared")).unwrap();
        let log = s.log(
            "sp",
            json!([{ "op": "link", "path": "shared", "target": target }]),
            json!([]),
        );
        let r = run(&log, &s.store, &opts(), &nothing).unwrap();
        assert_eq!(r["verified"], true, "{r}");
        assert_eq!(r["counts"]["linked"], 1);
        assert!(
            fs::symlink_metadata(s.root.join("shared"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(s.root.join("shared/x.txt")).unwrap(), b"outside");
        // Already right: nothing to do.
        let r = run(&log, &s.store, &opts(), &nothing).unwrap();
        assert_eq!(r["counts"]["linked"], 0);
    }

    #[test]
    fn own_temp_names_only() {
        assert!(is_own_temp(
            "a.txt.12345678-1234-1234-1234-123456789abc.mewndo-tmp"
        ));
        assert!(is_own_temp(&temp_name(Path::new("x")).to_string_lossy()));
        assert!(!is_own_temp("notes.mewndo-tmp"));
        assert!(!is_own_temp("a.txt.12345678-1234-1234-1234-123456789abc"));
        assert!(!is_own_temp(
            "a.12345678x1234-1234-1234-123456789abc.mewndo-tmp"
        ));
    }

    #[test]
    fn selection_and_link_targets_compare_like_v0() {
        let sel_paths = Some(vec!["docs\\".to_string()]);
        let sel = selector(&sel_paths);
        assert!(sel("docs") && sel("docs/a.md") && !sel("docs2/a.md"));
        assert!(same_target("../x", "../x", Path::new("/p/l")));
        assert!(same_target("/p/x/../y", "/p/y", Path::new("/p/l")));
        assert_eq!(iso_now().len(), 24);
    }
}
