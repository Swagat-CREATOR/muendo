// Content store, ported from the v0 Node engine (apps/desktop/engine/store.js) with the exact same files on disk,
// so history written by either one works with the other:
//   <store>/objects/<first 2 hex>/<sha256>       stored as is (already-compressed formats)
//   <store>/objects/<first 2 hex>/<sha256>.gz    gzipped (everything else)
//   <store>/tmp/<unique>.mewndo-tmp              being written; stale ones are removed at startup
// A file's name is the SHA-256 of its uncompressed content. Many files are hashed and compressed at once by a pool
// of 8 to 32 threads (put_batch). Objects are not flushed one by one, as in v0: after an unclean shutdown the
// newest are re-checked with verify_since.
//
// The store keeps no metadata of its own. What v0 calls metadata (a folder's index, a save point's manifest) is
// one JSON file per batch, written whole with write_file_atomic, so a batch lands completely or not at all.
// ponytail: the whole v0 store is ported and tested; the app reaches put, has and copy_out so far. Pruning,
// verify_since and write_file_atomic get callers when the journal moves here (cutover, P1.7).
#![allow(dead_code)]

use crate::paths::exact;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock, RwLockWriteGuard};
use std::time::{Duration, SystemTime};

pub const TEMP_SUFFIX: &str = ".mewndo-tmp";
pub const TEMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// Files up to this size are read once and kept in memory; bigger ones are streamed a second time.
const SMALL: usize = 1024 * 1024;

const PRECOMPRESSED: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "mp4", "mov", "mkv", "avi", "webm", "mp3",
    "m4a", "aac", "ogg", "flac", "zip", "gz", "tgz", "7z", "rar", "xz", "bz2", "zst", "pdf",
    "docx", "xlsx", "pptx", "jar", "apk",
];

#[derive(Debug)]
pub enum StoreError {
    /// The file was swapped, modified, became a link or moved out of bounds while being read (v0's
    /// EMEWNDO_CHANGED). Not stored; the next scan picks it up again.
    Changed(String),
    InvalidHash(String),
    NotStored(String),
    Corrupt(String),
    DestinationExists(PathBuf),
    Io(io::Error),
}

impl StoreError {
    /// A short stable name for the protocol.
    pub fn code(&self) -> &'static str {
        match self {
            StoreError::Changed(_) => "changed",
            StoreError::InvalidHash(_) => "invalid_hash",
            StoreError::NotStored(_) => "not_stored",
            StoreError::Corrupt(_) => "corrupt",
            StoreError::DestinationExists(_) => "destination_exists",
            StoreError::Io(e) if e.kind() == io::ErrorKind::NotFound => "not_found",
            StoreError::Io(_) => "io",
        }
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            StoreError::Changed(why) => write!(f, "changed while reading ({why})"),
            StoreError::InvalidHash(h) => write!(f, "invalid hash: {h}"),
            StoreError::NotStored(h) => write!(f, "not stored: {h}"),
            StoreError::Corrupt(h) => write!(f, "stored content is corrupt: {h}"),
            StoreError::DestinationExists(p) => write!(f, "destination exists: {}", p.display()),
            StoreError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

type Result<T> = std::result::Result<T, StoreError>;

fn changed(why: &str) -> StoreError {
    StoreError::Changed(why.to_string())
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// A name no other writer uses: time, process and a counter. Files are created with create_new as well.
fn unique() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn exists(p: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn gzipped_for(file: &Path) -> bool {
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    !ext.is_some_and(|e| PRECOMPRESSED.contains(&e.as_str()))
}

// --- Reading user files safely ---------------------------------------------------------------------------------

/// Which file a path or handle is, and its size and modified time. Equal identities: same file, unchanged.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Identity {
    volume: u64,
    index: u64,
    size: u64,
    modified: i128,
}

#[cfg(unix)]
mod identity {
    use super::Identity;
    use std::fs::{File, Metadata, OpenOptions};
    use std::io;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    use std::path::Path;

    fn of(m: &Metadata) -> Option<Identity> {
        m.file_type().is_file().then(|| Identity {
            volume: m.dev(),
            index: m.ino(),
            size: m.size(),
            modified: i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
        })
    }
    /// None if the path is a link or not a regular file. Never follows links.
    pub fn of_path(p: &Path) -> io::Result<Option<Identity>> {
        Ok(of(&std::fs::symlink_metadata(p)?))
    }
    pub fn of_file(f: &File) -> io::Result<Option<Identity>> {
        Ok(of(&f.metadata()?))
    }
    /// Open for reading, refusing a link (ELOOP).
    pub fn open(p: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(p)
    }
    pub fn is_link_refusal(e: &io::Error) -> bool {
        e.raw_os_error() == Some(libc::ELOOP)
    }
}

#[cfg(windows)]
mod identity {
    use super::Identity;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, GetFileInformationByHandle,
    };

    // Opening with FILE_FLAG_OPEN_REPARSE_POINT opens a link or junction itself, never what it points to. Windows
    // has no O_NOFOLLOW, so a link shows up here as a reparse point and is refused.
    const NO_FOLLOW: u32 = FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS;

    pub fn of_file(f: &File) -> io::Result<Option<Identity>> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
            return Ok(None);
        }
        let join = |hi: u32, lo: u32| (u64::from(hi) << 32) | u64::from(lo);
        Ok(Some(Identity {
            volume: u64::from(info.dwVolumeSerialNumber),
            index: join(info.nFileIndexHigh, info.nFileIndexLow),
            size: join(info.nFileSizeHigh, info.nFileSizeLow),
            modified: i128::from(join(
                info.ftLastWriteTime.dwHighDateTime,
                info.ftLastWriteTime.dwLowDateTime,
            )),
        }))
    }
    /// None if the path is a link, junction or folder. Opens only to read attributes.
    pub fn of_path(p: &Path) -> io::Result<Option<Identity>> {
        of_file(
            &OpenOptions::new()
                .access_mode(0x80 /* FILE_READ_ATTRIBUTES */)
                .custom_flags(NO_FOLLOW)
                .open(p)?,
        )
    }
    /// Open for reading without following a link; read_stable then refuses it by its identity.
    pub fn open(p: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .custom_flags(NO_FOLLOW)
            .open(p)
    }
    pub fn is_link_refusal(_: &io::Error) -> bool {
        false
    }
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

/// Open a regular file and hand it to `consume`. Fails with Changed if the path is or becomes a link, if the
/// opened file isn't the one first seen, if it changes during the read, or if its real location isn't inside
/// `within` (a protected folder; optional). Never follows links.
pub fn read_stable<T>(
    file: &Path,
    within: Option<&Path>,
    consume: impl FnOnce(&mut File) -> io::Result<T>,
) -> Result<T> {
    let file = &exact(file);
    let within = within.map(exact);
    let before = identity::of_path(file)?.ok_or_else(|| changed("not a regular file"))?;
    let mut f = identity::open(file).map_err(|e| {
        if identity::is_link_refusal(&e) {
            changed("became a link")
        } else {
            e.into()
        }
    })?;
    if identity::of_file(&f)? != Some(before) {
        return Err(changed("replaced before open"));
    }
    if let Some(within) = &within
        && !is_inside(&fs::canonicalize(file)?, &fs::canonicalize(within)?)
    {
        return Err(changed("outside protected folder"));
    }
    let result = consume(&mut f)?;
    let after_open = identity::of_file(&f)?;
    let after_path = identity::of_path(file)
        .ok()
        .flatten()
        .ok_or_else(|| changed("path is gone or now a link"))?;
    if after_open != Some(before) || after_path != before {
        return Err(changed("modified during read"));
    }
    Ok(result)
}

/// Read everything from `from` into `each`, in 64 KB pieces.
fn pump(from: &mut impl Read, mut each: impl FnMut(&[u8]) -> io::Result<()>) -> io::Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => each(&buf[..n])?,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

pub fn hash_file(file: &Path, within: Option<&Path>) -> Result<String> {
    let mut hash = Sha256::new();
    read_stable(file, within, |f| {
        pump(f, |b| {
            hash.update(b);
            Ok(())
        })
    })?;
    Ok(hex(hash.finalize()))
}

// --- The store -------------------------------------------------------------------------------------------------

pub struct Store {
    objects_dir: PathBuf,
    tmp_dir: PathBuf,
    /// Puts hold it for reading; pruning holds it for writing, so nothing new can come to refer to stored content
    /// while pruning decides what to delete (v0's holdPuts).
    gate: RwLock<()>,
    /// Folders already created, so storing a file doesn't ask for them again.
    made: Mutex<HashSet<PathBuf>>,
}

pub struct Found {
    pub path: PathBuf,
    pub gzipped: bool,
}

impl Store {
    pub fn new(dir: &Path) -> Store {
        let dir = exact(dir);
        Store {
            objects_dir: dir.join("objects"),
            tmp_dir: dir.join("tmp"),
            gate: RwLock::new(()),
            made: Mutex::new(HashSet::new()),
        }
    }

    fn object_path(&self, hash: &str, gzipped: bool) -> Result<PathBuf> {
        if !valid_hash(hash) {
            return Err(StoreError::InvalidHash(hash.to_string()));
        }
        let name = if gzipped {
            format!("{hash}.gz")
        } else {
            hash.to_string()
        };
        Ok(self.objects_dir.join(&hash[..2]).join(name))
    }

    pub fn find(&self, hash: &str) -> Result<Option<Found>> {
        for gzipped in [false, true] {
            let path = self.object_path(hash, gzipped)?;
            if exists(&path)? {
                return Ok(Some(Found { path, gzipped }));
            }
        }
        Ok(None)
    }

    pub fn has(&self, hash: &str) -> Result<bool> {
        Ok(self.find(hash)?.is_some())
    }

    fn mkdir_once(&self, dir: &Path) -> io::Result<()> {
        let mut made = self.made.lock().unwrap_or_else(|e| e.into_inner());
        if !made.contains(dir) {
            fs::create_dir_all(dir)?;
            made.insert(dir.to_path_buf());
        }
        Ok(())
    }

    /// Hold new puts and wait for running ones; puts continue when the guard is dropped.
    pub fn hold_puts(&self) -> RwLockWriteGuard<'_, ()> {
        self.gate.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Store a file and return its hash. Already-stored content costs one read and no write.
    pub fn put(&self, file: &Path, within: Option<&Path>) -> Result<String> {
        let _held = self.gate.read().unwrap_or_else(|e| e.into_inner());
        self.store_file(file, within)
    }

    /// Store many files at once on a pool of 8 to 32 threads. One result per file, in the same order.
    pub fn put_batch(&self, files: &[PathBuf], within: Option<&Path>) -> Vec<Result<String>> {
        parallel_map(files, |file| self.put(file, within))
    }

    // Rename a finished temp file into place. If another put stored the same content meanwhile, replacing it is
    // harmless (same bytes); if the replace fails (Windows: open for a restore), the existing copy is kept.
    fn commit(&self, tmp: &Path, digest: &str, gzipped: bool) -> Result<()> {
        let dest = self.object_path(digest, gzipped)?;
        self.mkdir_once(dest.parent().expect("objects have a folder"))?;
        if let Err(e) = fs::rename(tmp, &dest)
            && !self.has(digest)?
        {
            return Err(e.into());
        }
        Ok(())
    }

    fn store_file(&self, file: &Path, within: Option<&Path>) -> Result<String> {
        // One read: hash, and keep small files in memory so new small content needs no second read.
        let mut hash0 = Sha256::new();
        let mut small: Option<Vec<u8>> = Some(Vec::new());
        read_stable(file, within, |f| {
            pump(f, |b| {
                hash0.update(b);
                if let Some(data) = &mut small {
                    if data.len() + b.len() > SMALL {
                        small = None; // big: stream it again below instead
                    } else {
                        data.extend_from_slice(b);
                    }
                }
                Ok(())
            })
        })?;
        let first = hex(hash0.finalize());
        if self.has(&first)? {
            return Ok(first);
        }
        let gzipped = gzipped_for(file);
        self.mkdir_once(&self.tmp_dir)?;
        let tmp = self.tmp_dir.join(format!("{}{TEMP_SUFFIX}", unique()));
        let stored = (|| -> Result<()> {
            let out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            if let Some(data) = small {
                write_object(out, gzipped, |w| w.write_all(&data))?;
            } else {
                let mut hash = Sha256::new();
                read_stable(file, within, |f| {
                    write_object(out, gzipped, |w| {
                        pump(f, |b| {
                            hash.update(b);
                            w.write_all(b)
                        })
                    })
                })?;
                if hex(hash.finalize()) != first {
                    return Err(changed("modified between reads"));
                }
            }
            self.commit(&tmp, &first, gzipped)
        })();
        if stored.is_err() {
            let _ = fs::remove_file(&tmp); // after a rename there's nothing left to remove
        }
        stored.map(|()| first)
    }

    /// Write stored content to a verified temp file next to `dest` and return its path; the caller renames it into
    /// place. Next to dest, not in the store's tmp folder, because a rename can't cross drives.
    pub fn extract(&self, hash: &str, dest: &Path) -> Result<PathBuf> {
        let dest = &exact(dest);
        let src = self
            .find(hash)?
            .ok_or_else(|| StoreError::NotStored(hash.to_string()))?;
        let tmp = PathBuf::from(format!("{}.{}{TEMP_SUFFIX}", dest.display(), unique()));
        let written = (|| -> Result<()> {
            let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            let mut check = Sha256::new();
            let input = File::open(&src.path)?;
            let mut input: Box<dyn Read> = if src.gzipped {
                Box::new(GzDecoder::new(input))
            } else {
                Box::new(input)
            };
            pump(&mut input, |b| {
                check.update(b);
                out.write_all(b)
            })
            .map_err(|e| {
                if e.kind() == io::ErrorKind::InvalidInput
                    || e.kind() == io::ErrorKind::InvalidData
                    || e.kind() == io::ErrorKind::UnexpectedEof
                {
                    StoreError::Corrupt(hash.to_string())
                } else {
                    e.into()
                }
            })?;
            out.sync_all()?;
            if hex(check.finalize()) != hash {
                return Err(StoreError::Corrupt(hash.to_string()));
            }
            Ok(())
        })();
        match written {
            Ok(()) => Ok(tmp),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                Err(e)
            }
        }
    }

    /// Copy stored content to `dest` through a temp file and a rename, verifying the hash. Never overwrites an
    /// existing dest: the caller moves the old file to Mewndo's trash first.
    pub fn copy_out(&self, hash: &str, dest: &Path) -> Result<()> {
        let dest = &exact(dest);
        if exists(dest)? {
            return Err(StoreError::DestinationExists(dest.to_path_buf()));
        }
        let tmp = self.extract(hash, dest)?;
        // ponytail: check-then-rename has a tiny race (as in v0); a hard link would be atomic but fails on FAT/exFAT.
        let done = if exists(dest)? {
            Err(StoreError::DestinationExists(dest.to_path_buf()))
        } else {
            fs::rename(&tmp, dest).map_err(Into::into)
        };
        let _ = fs::remove_file(&tmp);
        done
    }

    /// Every stored object file: (hash, path, bytes on disk). Only names that look like objects.
    fn object_files(&self) -> io::Result<Vec<(String, PathBuf, u64)>> {
        let mut out = Vec::new();
        let top = match fs::read_dir(&self.objects_dir) {
            Ok(t) => t,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(e),
        };
        for sub in top {
            let sub = sub?;
            if !sub.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(sub.path())? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let hash = name.strip_suffix(".gz").unwrap_or(&name);
                if entry.file_type()?.is_file() && valid_hash(hash) {
                    out.push((hash.to_string(), entry.path(), entry.metadata()?.len()));
                }
            }
        }
        Ok(out)
    }

    /// Total bytes on disk used by stored content.
    pub fn usage(&self) -> Result<u64> {
        Ok(self.object_files()?.iter().map(|(_, _, size)| size).sum())
    }

    /// Every stored object: hash -> bytes on disk.
    pub fn objects(&self) -> Result<HashMap<String, u64>> {
        let mut sizes = HashMap::new();
        for (hash, _, size) in self.object_files()? {
            *sizes.entry(hash).or_insert(0) += size;
        }
        Ok(sizes)
    }

    /// Hashes of everything stored.
    pub fn hashes(&self) -> Result<HashSet<String>> {
        Ok(self
            .object_files()?
            .into_iter()
            .map(|(hash, _, _)| hash)
            .collect())
    }

    /// Delete stored content. Only for content no save point or index refers to (see pruning).
    pub fn remove(&self, hash: &str) -> Result<()> {
        for gzipped in [false, true] {
            match fs::remove_file(self.object_path(hash, gzipped)?) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        }
        Ok(())
    }

    /// Run at startup. Removes stale temp files; never touches objects.
    pub fn clean_temp(&self, max_age: Duration) -> Result<usize> {
        Ok(remove_stale_temp(&self.tmp_dir, max_age)?)
    }

    /// After an unclean shutdown: re-check every object written at or after `since` and delete the ones whose content
    /// no longer matches its name (e.g. cut short by a power loss). Returns the deleted hashes.
    pub fn verify_since(&self, since: SystemTime) -> Result<Vec<String>> {
        let files = self.object_files()?;
        let next = AtomicUsize::new(0);
        let bad = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for _ in 0..pool_size().min(files.len()).max(1) {
                scope.spawn(|| {
                    while let Some((hash, path, _)) =
                        files.get(next.fetch_add(1, Ordering::Relaxed))
                    {
                        let recent = fs::symlink_metadata(path)
                            .and_then(|m| m.modified())
                            .is_ok_and(|t| t >= since);
                        if recent && !object_matches(path, hash) {
                            let _ = fs::remove_file(path);
                            bad.lock().unwrap().push(hash.clone());
                        }
                    }
                });
            }
        });
        Ok(bad.into_inner().unwrap())
    }
}

fn object_matches(path: &Path, hash: &str) -> bool {
    let Ok(input) = File::open(path) else {
        return false;
    };
    let mut input: Box<dyn Read> = if path.extension().is_some_and(|e| e == "gz") {
        Box::new(GzDecoder::new(input))
    } else {
        Box::new(input)
    };
    let mut check = Sha256::new();
    pump(&mut input, |b| {
        check.update(b);
        Ok(())
    })
    .is_ok()
        && hex(check.finalize()) == hash
}

/// Write an object's bytes, gzipped or not, to an open temp file.
fn write_object(
    out: File,
    gzipped: bool,
    write: impl FnOnce(&mut dyn Write) -> io::Result<()>,
) -> io::Result<()> {
    if gzipped {
        let mut gz = GzEncoder::new(out, Compression::default()); // level 6, as Node's zlib.gzip
        write(&mut gz)?;
        gz.finish()?;
    } else {
        let mut out = out;
        write(&mut out)?;
    }
    Ok(())
}

/// Run `f` on every item on a pool of pool_size() threads. Results come back in the items' order.
pub fn parallel_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<R>>> = items.iter().map(|_| Mutex::new(None)).collect();
    std::thread::scope(|scope| {
        for _ in 0..pool_size().min(items.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(i) else { break };
                    *results[i].lock().unwrap_or_else(|e| e.into_inner()) = Some(f(item));
                }
            });
        }
    });
    results
        .into_iter()
        .map(|r| {
            r.into_inner()
                .unwrap_or_else(|e| e.into_inner())
                .expect("every item gets a result")
        })
        .collect()
}

/// 8 to 32 threads: twice the CPUs, since most time goes to waiting on the disk (and antivirus).
pub fn pool_size() -> usize {
    (std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        * 2)
    .clamp(8, 32)
}

/// Delete *.mewndo-tmp files older than `max_age` directly inside `dir` (Mewndo's own folders only).
/// Returns how many were removed.
pub fn remove_stale_temp(dir: &Path, max_age: Duration) -> io::Result<usize> {
    let dir = &exact(dir);
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        if !entry.file_name().to_string_lossy().ends_with(TEMP_SUFFIX) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let old = meta
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if meta.file_type().is_file() && old && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Write a file through a temp file and a rename, so a crash leaves the old or the new version, never half of one.
/// Flushed before the rename. This is how a whole batch's metadata (an index or a manifest) is written at once.
pub fn write_file_atomic(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let file = &exact(file);
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.{}{TEMP_SUFFIX}", file.display(), unique()));
    let written = (|| {
        let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        rename_replacing(&tmp, file)
    })();
    let _ = fs::remove_file(&tmp);
    written
}

/// Windows won't replace a file another program has open at that moment, which antivirus and the search indexer do
/// briefly with files that were just written. Try again for up to about 5 s before giving up.
fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut delay = 10;
    loop {
        match fs::rename(from, to) {
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && delay <= 4000 => {
                std::thread::sleep(Duration::from_millis(delay));
                delay *= 2;
            }
            done => return done,
        }
    }
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
        let d = std::env::temp_dir().join(format!("mewndo-store-test-{}", unique()));
        fs::create_dir_all(&d).unwrap();
        Dir(d)
    }
    fn sha(b: &[u8]) -> String {
        hex(Sha256::digest(b))
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut n: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        n.sort();
        n
    }
    /// Deterministic bytes that don't compress much.
    fn noise(len: usize) -> Vec<u8> {
        let mut x: u64 = 0x9e3779b97f4a7c15;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                x as u8
            })
            .collect()
    }

    #[test]
    fn put_returns_the_sha256_and_copy_out_restores_byte_for_byte() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        let content = noise(3 * 1024 * 1024 + 7); // bigger than SMALL: read twice
        let file = d.0.join("big.bin");
        fs::write(&file, &content).unwrap();
        let hash = store.put(&file, None).unwrap();
        assert_eq!(hash, sha(&content));
        assert_eq!(hash_file(&file, None).unwrap(), hash);
        assert!(store.has(&hash).unwrap());
        assert!(!store.has(&"0".repeat(64)).unwrap());
        let out = d.0.join("out.bin");
        store.copy_out(&hash, &out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), content);
        assert!(!names(&d.0).iter().any(|n| n.contains("mewndo-tmp")));
        assert!(names(&d.0.join("data/tmp")).is_empty());
    }

    #[test]
    fn identical_content_is_stored_once() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("a.txt"), "same").unwrap();
        fs::write(d.0.join("b.txt"), "same").unwrap();
        let h1 = store.put(&d.0.join("a.txt"), None).unwrap();
        let used = store.usage().unwrap();
        assert_eq!(store.put(&d.0.join("b.txt"), None).unwrap(), h1);
        assert_eq!(store.usage().unwrap(), used);
        assert_eq!(store.objects().unwrap().len(), 1);
    }

    #[test]
    fn text_is_gzipped_already_compressed_formats_are_not() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        let text = "hello mewndo ".repeat(1000);
        fs::write(d.0.join("notes.txt"), &text).unwrap();
        fs::write(d.0.join("photo.PNG"), "pretend png bytes").unwrap();
        let t = store.put(&d.0.join("notes.txt"), None).unwrap();
        let p = store.put(&d.0.join("photo.PNG"), None).unwrap();
        assert_eq!(
            store.find(&t).unwrap().unwrap().path,
            exact(&d.0.join(format!("data/objects/{}/{t}.gz", &t[..2])))
        );
        assert_eq!(
            store.find(&p).unwrap().unwrap().path,
            exact(&d.0.join(format!("data/objects/{}/{p}", &p[..2])))
        );
        assert!(store.usage().unwrap() < text.len() as u64);
        store.copy_out(&t, &d.0.join("notes.out")).unwrap();
        assert_eq!(fs::read_to_string(d.0.join("notes.out")).unwrap(), text);
    }

    #[test]
    fn copy_out_never_overwrites_an_existing_file() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("a.txt"), "stored").unwrap();
        fs::write(d.0.join("keep.txt"), "user data").unwrap();
        let hash = store.put(&d.0.join("a.txt"), None).unwrap();
        let e = store.copy_out(&hash, &d.0.join("keep.txt")).unwrap_err();
        assert_eq!(e.code(), "destination_exists");
        assert_eq!(
            fs::read_to_string(d.0.join("keep.txt")).unwrap(),
            "user data"
        );
    }

    #[test]
    fn copy_out_detects_corrupt_content_and_leaves_nothing_behind() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("a.png"), "original").unwrap();
        let hash = store.put(&d.0.join("a.png"), None).unwrap();
        fs::write(store.find(&hash).unwrap().unwrap().path, "tampered").unwrap();
        assert_eq!(
            store
                .copy_out(&hash, &d.0.join("out.png"))
                .unwrap_err()
                .code(),
            "corrupt"
        );
        assert_eq!(names(&d.0), ["a.png", "data"]);
        // A damaged gzip object too.
        fs::write(d.0.join("b.txt"), "zipped").unwrap();
        let hash = store.put(&d.0.join("b.txt"), None).unwrap();
        fs::write(store.find(&hash).unwrap().unwrap().path, "not gzip").unwrap();
        assert_eq!(
            store
                .copy_out(&hash, &d.0.join("out.txt"))
                .unwrap_err()
                .code(),
            "corrupt"
        );
        assert_eq!(names(&d.0), ["a.png", "b.txt", "data"]);
    }

    #[test]
    fn rejects_malformed_hashes() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        for bad in ["../../etc/passwd", "", &"A".repeat(64), &"0".repeat(63)] {
            assert_eq!(store.has(bad).unwrap_err().code(), "invalid_hash", "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_store_links() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("real.txt"), "x").unwrap();
        std::os::unix::fs::symlink(d.0.join("real.txt"), d.0.join("link")).unwrap();
        let e = store.put(&d.0.join("link"), None).unwrap_err();
        assert!(e.to_string().contains("not a regular file"), "{e}");
        assert_eq!(store.usage().unwrap(), 0);
    }

    /// Names that plain Windows paths change ("notes." opens "notes") and paths over 260 characters: stored and
    /// put back exactly, as v0 does. Node creates such names; so do WSL, git and agents.
    #[cfg(windows)]
    #[test]
    fn names_with_trailing_dots_or_spaces_and_long_paths_are_kept_exactly() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        let deep = exact(
            &d.0.join("a".repeat(100))
                .join("b".repeat(100))
                .join("c".repeat(100)),
        );
        fs::create_dir_all(&deep).unwrap();
        for (i, name) in ["notes.", "draft ", "plain.txt"].into_iter().enumerate() {
            for dir in [exact(&d.0), deep.clone()] {
                let file = dir.join(name);
                fs::write(&file, format!("{i} {name}")).unwrap(); // exact path: the name as given
                let hash = store.put(&file, None).unwrap();
                let out = dir.join(format!("out-{name}"));
                store.copy_out(&hash, &out).unwrap();
                assert_eq!(fs::read_to_string(&out).unwrap(), format!("{i} {name}"));
                assert!(
                    names(&dir).contains(&format!("out-{name}")),
                    "{name:?} kept its exact name"
                );
            }
        }
    }

    /// A junction to a folder outside the protected one: what's behind it is never read. No admin needed.
    #[cfg(windows)]
    #[test]
    fn refuses_files_behind_a_junction_out_of_the_protected_folder() {
        let d = temp_dir();
        let (root, outside) = (d.0.join("root"), d.0.join("outside"));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(root.join("sneaky"))
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stdout)
        );
        let e = hash_file(&root.join("sneaky").join("secret.txt"), Some(&root)).unwrap_err();
        assert!(e.to_string().contains("outside protected folder"), "{e}");
        let e = hash_file(&root.join("sneaky"), Some(&root)).unwrap_err();
        assert!(e.to_string().contains("not a regular file"), "{e}");
    }

    /// File symlinks need Developer Mode or admin on Windows; tested when this PC allows making one.
    #[cfg(windows)]
    #[test]
    fn refuses_to_store_a_file_symlink() {
        let d = temp_dir();
        fs::write(d.0.join("real.txt"), "x").unwrap();
        if let Err(e) =
            std::os::windows::fs::symlink_file(d.0.join("real.txt"), d.0.join("link.txt"))
        {
            eprintln!("skipped: can't make a symlink here ({e})");
            return;
        }
        let e = Store::new(&d.0.join("data"))
            .put(&d.0.join("link.txt"), None)
            .unwrap_err();
        assert!(e.to_string().contains("not a regular file"), "{e}");
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let d = temp_dir();
        assert_eq!(
            Store::new(&d.0.join("data"))
                .put(&d.0.join("nope"), None)
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[test]
    fn read_stable_rejects_a_file_modified_while_reading() {
        let d = temp_dir();
        let file = d.0.join("a.txt");
        fs::write(&file, "before").unwrap();
        let e = read_stable(&file, None, |_| {
            std::thread::sleep(Duration::from_millis(20)); // a newer modified time on any file system
            fs::write(&file, "after, and longer").map(|_| ())
        })
        .unwrap_err();
        assert_eq!(e.code(), "changed");
    }

    #[test]
    fn read_stable_rejects_a_file_swapped_for_another_while_reading() {
        let d = temp_dir();
        let file = d.0.join("a.txt");
        fs::write(&file, "original").unwrap();
        fs::write(d.0.join("other.txt"), "original").unwrap();
        let e = read_stable(&file, None, |_| fs::rename(d.0.join("other.txt"), &file)).unwrap_err();
        assert_eq!(e.code(), "changed");
    }

    #[cfg(unix)]
    #[test]
    fn read_stable_rejects_a_path_whose_real_location_is_outside_the_protected_folder() {
        let d = temp_dir();
        let root = d.0.join("root");
        let outside = d.0.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        fs::write(root.join("ok.txt"), "fine").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("sneaky")).unwrap();
        let e = hash_file(&root.join("sneaky/secret.txt"), Some(&root)).unwrap_err();
        assert!(e.to_string().contains("outside protected folder"), "{e}");
        assert_eq!(
            hash_file(&root.join("ok.txt"), Some(&root)).unwrap(),
            sha(b"fine")
        );
    }

    #[test]
    fn put_stores_nothing_and_leaves_no_temp_file_when_the_read_is_refused() {
        let d = temp_dir();
        let data = d.0.join("data");
        let store = Store::new(&data);
        let outside = d.0.join("outside.txt");
        fs::write(&outside, "x").unwrap();
        fs::create_dir_all(d.0.join("root")).unwrap();
        assert_eq!(
            store
                .put(&outside, Some(&d.0.join("root")))
                .unwrap_err()
                .code(),
            "changed"
        );
        assert_eq!(store.usage().unwrap(), 0);
        assert!(!data.join("tmp").exists() || names(&data.join("tmp")).is_empty());
    }

    #[test]
    fn clean_temp_removes_stale_temp_files_only() {
        let d = temp_dir();
        let data = d.0.join("data");
        let store = Store::new(&data);
        fs::write(d.0.join("a.txt"), "keep me").unwrap();
        let hash = store.put(&d.0.join("a.txt"), None).unwrap();
        let tmp = data.join("tmp");
        let stale = tmp.join(format!("old{TEMP_SUFFIX}"));
        let recent = tmp.join(format!("new{TEMP_SUFFIX}"));
        let not_ours = tmp.join("other.txt");
        for f in [&stale, &recent, &not_ours] {
            fs::write(f, "x").unwrap();
        }
        let two_hours_ago = SystemTime::now() - Duration::from_secs(2 * 3600);
        for f in [&stale, &not_ours] {
            File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_modified(two_hours_ago)
                .unwrap();
        }
        assert_eq!(store.clean_temp(TEMP_MAX_AGE).unwrap(), 1);
        assert!(!stale.exists() && recent.exists() && not_ours.exists());
        store.copy_out(&hash, &d.0.join("out.txt")).unwrap();
        assert_eq!(fs::read_to_string(d.0.join("out.txt")).unwrap(), "keep me");
        assert_eq!(
            Store::new(&d.0.join("fresh"))
                .clean_temp(TEMP_MAX_AGE)
                .unwrap(),
            0
        );
    }

    #[test]
    fn hold_puts_makes_new_puts_wait_until_released() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("a.txt"), "held").unwrap();
        let held = store.hold_puts();
        std::thread::scope(|s| {
            let put = s.spawn(|| store.put(&d.0.join("a.txt"), None).unwrap());
            std::thread::sleep(Duration::from_millis(100));
            assert!(!put.is_finished(), "put must wait while held");
            drop(held);
            assert_eq!(put.join().unwrap(), sha(b"held"));
        });
    }

    #[test]
    fn put_batch_stores_many_files_with_one_result_each_in_order() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        let mut files = Vec::new();
        for i in 0..300 {
            let f = d.0.join(format!("f{i}.txt"));
            fs::write(&f, format!("file {i} {}", "x".repeat(i % 50))).unwrap();
            files.push(f);
        }
        files.push(d.0.join("missing.txt"));
        files.push(d.0.join("f0.txt")); // the same content twice in one batch
        let results = store.put_batch(&files, None);
        assert_eq!(results.len(), 302);
        for (i, r) in results.iter().take(300).enumerate() {
            assert_eq!(
                r.as_ref().unwrap(),
                &sha(format!("file {i} {}", "x".repeat(i % 50)).as_bytes())
            );
        }
        assert_eq!(results[300].as_ref().unwrap_err().code(), "not_found");
        assert_eq!(results[301].as_ref().unwrap(), results[0].as_ref().unwrap());
        assert_eq!(store.hashes().unwrap().len(), 300);
        assert!(names(&d.0.join("data/tmp")).is_empty());
        assert!((8..=32).contains(&pool_size()));
    }

    #[test]
    fn verify_since_removes_damaged_recent_objects_only() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("good.txt"), "good").unwrap();
        fs::write(d.0.join("bad.txt"), "bad").unwrap();
        let good = store.put(&d.0.join("good.txt"), None).unwrap();
        let bad = store.put(&d.0.join("bad.txt"), None).unwrap();
        fs::write(store.find(&bad).unwrap().unwrap().path, "cut short").unwrap();
        let later = SystemTime::now() + Duration::from_secs(3600);
        assert!(
            store.verify_since(later).unwrap().is_empty(),
            "older objects are not re-checked"
        );
        assert_eq!(
            store.verify_since(SystemTime::UNIX_EPOCH).unwrap(),
            std::slice::from_ref(&bad)
        );
        assert!(store.has(&good).unwrap() && !store.has(&bad).unwrap());
    }

    #[test]
    fn remove_deletes_either_form() {
        let d = temp_dir();
        let store = Store::new(&d.0.join("data"));
        fs::write(d.0.join("a.txt"), "a").unwrap();
        let h = store.put(&d.0.join("a.txt"), None).unwrap();
        store.remove(&h).unwrap();
        assert!(!store.has(&h).unwrap());
        store.remove(&h).unwrap(); // already gone: fine
    }

    #[test]
    fn write_file_atomic_replaces_whole_and_leaves_no_temp() {
        let d = temp_dir();
        let file = d.0.join("sub/index.json");
        write_file_atomic(&file, b"old").unwrap();
        write_file_atomic(&file, b"new").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(names(&d.0.join("sub")), ["index.json"]);
    }
}
