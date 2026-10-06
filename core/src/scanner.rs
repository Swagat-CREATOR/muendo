// Folder scanner, ported from the v0 engine (apps/desktop/engine/scanner.js) with the same manifest, so an index
// either engine wrote works with the other: { "relative/path": entry }, '/' on every platform. It walks with lstat
// only: links and junctions are recorded, never entered. Files whose size and modified time match the previous
// manifest keep their hash; the rest are hashed (and stored) on the store's thread pool.
// With `dirs` it reads only those folders and keeps everything else from `previous`: the reconciliation scan
// after the change feed reports which folders changed.
use crate::paths::{display, exact, real};
use crate::store::{self, Store, StoreError, TEMP_SUFFIX};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_IGNORE: &[&str] = &[
    "node_modules",
    ".venv",
    "dist",
    "build",
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".parcel-cache",
];
pub const DEFAULT_MAX_FILE_SIZE: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Directory,
    Link,
    Unknown,
}

/// One manifest entry, with v0's field names. Only the fields that apply are written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    #[serde(rename = "type")]
    pub kind: Kind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Exactly what Node's stat gives (sec * 1000 + nsec / 1e6), so equal times compare equal across engines.
    #[serde(rename = "mtimeMs", skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// too-large, online-only or changed-while-reading
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
    /// Modified so recently it may still be being written; not hashed (see ScanOptions::settle_ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    /// A link's target, as Node's readlink gives it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Why it couldn't be read, as a Node error code (EPERM, EBUSY…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Entry {
    fn of(kind: Kind) -> Entry {
        Entry {
            kind,
            size: None,
            mtime_ms: None,
            hash: None,
            skipped: None,
            pending: None,
            target: None,
            error: None,
        }
    }
}

pub type Manifest = BTreeMap<String, Entry>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScanOptions {
    /// Folder names left out.
    pub ignore: Vec<String>,
    /// Extra file or folder names left out; * matches any run of characters ("*.log").
    pub ignore_patterns: Vec<String>,
    pub max_file_size: u64,
    /// Files modified less than this long ago are marked pending, not hashed. Times more than a second in the
    /// future don't count, so a wrong date can't hide a file.
    pub settle_ms: u64,
    /// Online-only cloud files (OneDrive Files On-Demand) are recorded as skipped, never opened (which would
    /// download them).
    pub skip_online_only: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        ScanOptions {
            ignore: DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect(),
            ignore_patterns: Vec::new(),
            max_file_size: DEFAULT_MAX_FILE_SIZE,
            settle_ms: 0,
            skip_online_only: cfg!(windows),
        }
    }
}

/// What a scan looked at: entries found (files, folders, links) and files hashed.
#[derive(Debug, Default, PartialEq)]
pub struct ScanStats {
    pub found: usize,
    pub hashed: usize,
}

// --- Names -----------------------------------------------------------------------------------------------------

/// Matches whole names against patterns with * for any run of characters. Case is ignored on Windows and macOS,
/// where file names are case-insensitive.
pub struct Patterns(Vec<Vec<char>>);

impl Patterns {
    pub fn new(patterns: &[String]) -> Patterns {
        Patterns(
            patterns
                .iter()
                .filter(|p| !p.is_empty())
                .map(|p| fold(p).chars().collect())
                .collect(),
        )
    }
    pub fn matches(&self, name: &str) -> bool {
        let name: Vec<char> = fold(name).chars().collect();
        self.0.iter().any(|p| wildcard(p, &name))
    }
}

fn fold(s: &str) -> String {
    if cfg!(target_os = "linux") {
        s.to_string()
    } else {
        s.to_lowercase()
    }
}

/// * matches any run of characters (including none); everything else matches itself.
fn wildcard(pattern: &[char], name: &[char]) -> bool {
    let (mut p, mut n) = (0, 0);
    let mut star: Option<(usize, usize)> = None; // where the last * was, and where it started matching
    while n < name.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, n));
            p += 1;
        } else if p < pattern.len() && pattern[p] == name[n] {
            p += 1;
            n += 1;
        } else if let Some((sp, sn)) = star {
            p = sp + 1;
            n = sn + 1;
            star = Some((sp, sn + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// Node's error code for an I/O error, as v0 records it.
pub fn node_code(e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::NotFound {
        return "ENOENT".into();
    }
    #[cfg(windows)]
    let name = match e.raw_os_error() {
        Some(5) => Some("EPERM"),
        Some(32) | Some(33) => Some("EBUSY"),
        Some(1920) => Some("ELOOP"),
        Some(267) => Some("ENOTDIR"),
        _ => None,
    };
    #[cfg(unix)]
    let name = match e.raw_os_error() {
        Some(libc::EACCES) => Some("EACCES"),
        Some(libc::EPERM) => Some("EPERM"),
        Some(libc::EBUSY) => Some("EBUSY"),
        Some(libc::ELOOP) => Some("ELOOP"),
        Some(libc::ENOTDIR) => Some("ENOTDIR"),
        Some(libc::EIO) => Some("EIO"),
        _ => None,
    };
    name.map(String::from).unwrap_or_else(|| "EIO".into())
}

fn mtime_ms(m: &Metadata) -> f64 {
    let t = m.modified().unwrap_or(UNIX_EPOCH);
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0), // before 1970: rare, never compared exactly
    }
}

#[cfg(windows)]
fn online_only(m: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // RECALL_ON_DATA_ACCESS, RECALL_ON_OPEN, OFFLINE: reading it would download it. (v0 guessed from disk space
    // used, as Node doesn't expose these.)
    m.file_attributes() & (0x0040_0000 | 0x0004_0000 | 0x1000) != 0
}

#[cfg(not(windows))]
fn online_only(m: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    m.len() > 4096 && m.blocks() == 0 // a size but no disk space, as v0 checks
}

fn parent_of(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// --- The scan --------------------------------------------------------------------------------------------------

/// Scan `root`. `previous`: the last manifest (hashes are kept for unchanged files). `dirs`: read only these
/// folders (relative, "" = the top) and keep the rest of `previous`; None walks everything. `store`: store each
/// new file's content as it's hashed. Returns the manifest and what was looked at.
pub fn scan(
    root: &Path,
    previous: &Manifest,
    dirs: Option<&[String]>,
    opts: &ScanOptions,
    store: Option<&Store>,
) -> io::Result<(Manifest, ScanStats)> {
    let scan_start = now_ms();
    let base = exact(root);
    let real_root = real(root)?;
    let ignored: HashSet<&str> = opts.ignore.iter().map(String::as_str).collect();
    let extra = Patterns::new(&opts.ignore_patterns);
    let mut manifest = if dirs.is_some() {
        previous.clone()
    } else {
        Manifest::new()
    };
    let mut to_hash: Vec<String> = Vec::new();
    let mut walk: Vec<String> = Vec::new();
    let mut stats = ScanStats::default();
    let abs = |rel: &str| {
        if rel.is_empty() {
            base.clone()
        } else {
            base.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
        }
    };

    // Record one entry (lstat only). Subfolders are queued for walking when walk_all, or when they're new.
    let mut visit = |rel: String,
                     name: &str,
                     walk_all: bool,
                     manifest: &mut Manifest,
                     walk: &mut Vec<String>| {
        let path = abs(&rel);
        let m = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    manifest.insert(
                        rel,
                        Entry {
                            error: Some(node_code(&e)),
                            ..Entry::of(Kind::Unknown)
                        },
                    );
                }
                return;
            }
        };
        let prev = previous.get(&rel);
        if m.file_type().is_symlink() {
            // Symbolic links and junctions: recorded with their target, never entered.
            match fs::read_link(&path) {
                Ok(t) => {
                    manifest.insert(
                        rel,
                        Entry {
                            target: Some(display(&t)),
                            ..Entry::of(Kind::Link)
                        },
                    );
                }
                Err(e) if e.kind() != io::ErrorKind::NotFound => {
                    manifest.insert(
                        rel,
                        Entry {
                            error: Some(node_code(&e)),
                            ..Entry::of(Kind::Link)
                        },
                    );
                }
                Err(_) => {}
            }
        } else if m.is_dir() {
            if ignored.contains(name) {
                return;
            }
            if walk_all || prev.map(|p| p.kind) != Some(Kind::Directory) {
                walk.push(rel.clone());
            }
            manifest.insert(rel, Entry::of(Kind::Directory));
        } else if m.is_file() {
            if name.ends_with(TEMP_SUFFIX) {
                return; // Mewndo's own in-progress restore writes
            }
            let mtime = mtime_ms(&m);
            let mut entry = Entry {
                size: Some(m.len()),
                mtime_ms: Some(mtime),
                ..Entry::of(Kind::File)
            };
            let age = scan_start - mtime;
            if m.len() > opts.max_file_size {
                entry.skipped = Some("too-large".into());
            } else if opts.skip_online_only && online_only(&m) {
                entry.skipped = Some("online-only".into());
            } else if opts.settle_ms > 0 && age < opts.settle_ms as f64 && age > -1000.0 {
                entry.pending = Some(true);
            } else if let Some(p) = prev.filter(|p| {
                p.kind == Kind::File
                    && p.hash.is_some()
                    && p.size == entry.size
                    && p.mtime_ms == entry.mtime_ms
            }) {
                entry.hash = p.hash.clone();
            } else {
                to_hash.push(rel.clone());
            }
            manifest.insert(rel, entry);
        } else {
            return; // ponytail: sockets, FIFOs and devices are not user files; skipped (as in v0)
        }
        stats.found += 1;
    };

    let read_dir = |rel: &str| -> io::Result<Vec<String>> {
        let mut names: Vec<String> = fs::read_dir(abs(rel))?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        Ok(names)
    };

    if let Some(changed) = dirs {
        // Children of each folder in `previous`, to find what was removed.
        let mut kids: HashMap<&str, Vec<&str>> = HashMap::new();
        for rel in previous.keys() {
            kids.entry(parent_of(rel)).or_default().push(rel);
        }
        fn remove_tree(rel: &str, manifest: &mut Manifest, kids: &HashMap<&str, Vec<&str>>) {
            manifest.remove(rel);
            for k in kids.get(rel).into_iter().flatten() {
                remove_tree(k, manifest, kids);
            }
        }
        let in_ignored = |rel: &str| {
            rel.split('/')
                .any(|part| extra.matches(part) || ignored.contains(part))
        };
        // A changed folder Mewndo didn't know as a folder is read from the nearest known folder above it.
        let mut todo: Vec<String> = Vec::new();
        for d in changed {
            let mut d = d.as_str();
            while !d.is_empty() && previous.get(d).map(|e| e.kind) != Some(Kind::Directory) {
                d = parent_of(d);
            }
            if (d.is_empty() || !in_ignored(d)) && !todo.iter().any(|t| t == d) {
                todo.push(d.to_string());
            }
        }
        for d in &todo {
            let names = match read_dir(d) {
                Ok(n) => n,
                Err(e) if d.is_empty() => return Err(e),
                Err(e) => {
                    if e.kind() == io::ErrorKind::NotFound {
                        remove_tree(d, &mut manifest, &kids);
                    } else if let Some(entry) = manifest.get_mut(d.as_str()) {
                        entry.error = Some(node_code(&e));
                    }
                    continue;
                }
            };
            let present: HashSet<&str> = names
                .iter()
                .map(String::as_str)
                .filter(|n| !extra.matches(n))
                .collect();
            for child in kids.get(d.as_str()).into_iter().flatten() {
                let name = &child[if d.is_empty() { 0 } else { d.len() + 1 }..];
                if !present.contains(name) {
                    remove_tree(child, &mut manifest, &kids); // gone (or renamed)
                }
            }
            for name in names.iter().filter(|n| present.contains(n.as_str())) {
                let rel = join(d, name);
                let was_dir = previous.get(&rel).map(|e| e.kind) == Some(Kind::Directory);
                visit(rel.clone(), name, false, &mut manifest, &mut walk);
                if was_dir && manifest.get(&rel).map(|e| e.kind) != Some(Kind::Directory) {
                    // A folder replaced by something else: drop what was inside it.
                    let entry = manifest.get(&rel).cloned();
                    remove_tree(&rel, &mut manifest, &kids);
                    if let Some(entry) = entry {
                        manifest.insert(rel, entry);
                    }
                }
            }
        }
    } else {
        walk.push(String::new());
    }

    while let Some(dir) = walk.pop() {
        let names = match read_dir(&dir) {
            Ok(n) => n,
            Err(e) if dir.is_empty() => return Err(e),
            Err(e) => {
                if e.kind() == io::ErrorKind::NotFound {
                    manifest.remove(&dir);
                } else if let Some(entry) = manifest.get_mut(&dir) {
                    entry.error = Some(node_code(&e));
                }
                continue;
            }
        };
        for name in names.iter().filter(|n| !extra.matches(n)) {
            visit(join(&dir, name), name, true, &mut manifest, &mut walk);
        }
    }

    // Hash (and store) on the pool; each result lands on its own entry.
    let files: Vec<PathBuf> = to_hash.iter().map(|rel| abs(rel)).collect();
    let results = match store {
        Some(s) => s.put_batch(&files, Some(&real_root)),
        None => store::parallel_map(&files, |f| store::hash_file(f, Some(&real_root))),
    };
    for (rel, result) in to_hash.iter().zip(results) {
        stats.hashed += 1;
        match result {
            Ok(hash) => {
                if let Some(e) = manifest.get_mut(rel) {
                    e.hash = Some(hash);
                }
            }
            Err(StoreError::Io(e)) if e.kind() == io::ErrorKind::NotFound => {
                manifest.remove(rel);
            }
            Err(StoreError::Changed(_)) => {
                if let Some(e) = manifest.get_mut(rel) {
                    e.skipped = Some("changed-while-reading".into());
                }
            }
            Err(e) => {
                if let Some(entry) = manifest.get_mut(rel) {
                    entry.error = Some(match &e {
                        StoreError::Io(io) => node_code(io),
                        other => other.to_string(),
                    });
                }
            }
        }
    }
    Ok((manifest, stats))
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
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "mewndo-scan-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&d).unwrap();
        Dir(d)
    }
    fn write(root: &Path, rel: &str, content: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }
    fn opts() -> ScanOptions {
        ScanOptions {
            max_file_size: 1000,
            skip_online_only: false,
            ..ScanOptions::default()
        }
    }
    fn full(root: &Path, o: &ScanOptions) -> Manifest {
        scan(root, &Manifest::new(), None, o, None).unwrap().0
    }

    /// The tree from v0's scanner tests: nested files, an empty folder, an ignored node_modules, an included
    /// .git, a file over the size limit, and a link out of the folder.
    fn make_tree() -> (Dir, PathBuf) {
        let base = temp_dir();
        let root = base.0.join("root");
        write(&root, "a.txt", b"A");
        write(&root, "docs/b.txt", b"BB");
        write(&root, "docs/deep/c.txt", b"CCC");
        write(&root, "node_modules/pkg/index.js", b"ignored");
        write(&root, ".git/HEAD", b"ref: refs/heads/main\n");
        write(&root, "huge.bin", &[1u8; 2000]);
        fs::create_dir_all(root.join("empty")).unwrap();
        write(&base.0, "outside/secret/x.txt", b"outside");
        link_dir(&base.0.join("outside"), &root.join("outside-link"));
        (base, root)
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, at: &Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }
    #[cfg(windows)]
    fn link_dir(target: &Path, at: &Path) {
        // A junction: no admin needed, as v0's tests use.
        let ok = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(at.to_string_lossy().replace('/', "\\")) // mklink takes backslashes only
            .arg(target.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(ok.status.success());
    }

    #[test]
    fn manifest_records_files_folders_and_links() {
        let (base, root) = make_tree();
        let m = full(&root, &opts());
        let keys: Vec<&str> = m.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                ".git",
                ".git/HEAD",
                "a.txt",
                "docs",
                "docs/b.txt",
                "docs/deep",
                "docs/deep/c.txt",
                "empty",
                "huge.bin",
                "outside-link"
            ]
        );
        for d in [".git", "docs", "docs/deep", "empty"] {
            assert_eq!(m[d], Entry::of(Kind::Directory));
        }
        for f in ["a.txt", "docs/b.txt", "docs/deep/c.txt", ".git/HEAD"] {
            let st = fs::symlink_metadata(root.join(f)).unwrap();
            assert_eq!(m[f].size, Some(st.len()));
            assert_eq!(
                m[f].hash.as_deref(),
                Some(store::hash_file(&root.join(f), None).unwrap().as_str())
            );
        }
        assert_eq!(m["huge.bin"].skipped.as_deref(), Some("too-large"));
        assert_eq!(
            (m["huge.bin"].size, m["huge.bin"].hash.as_ref()),
            (Some(2000), None)
        );
        assert_eq!(m["outside-link"].kind, Kind::Link);
        let target = PathBuf::from(m["outside-link"].target.as_ref().unwrap());
        assert_eq!(
            real(&target).unwrap(),
            real(&base.0.join("outside")).unwrap()
        );
    }

    #[test]
    fn only_files_with_changed_size_or_mtime_are_rehashed() {
        let (_base, root) = make_tree();
        let (first, s1) = scan(&root, &Manifest::new(), None, &opts(), None).unwrap();
        assert_eq!(s1.hashed, 4);
        let (second, s2) = scan(&root, &first, None, &opts(), None).unwrap();
        assert_eq!(s2.hashed, 0);
        assert_eq!(second, first);
        fs::write(root.join("docs/b.txt"), "changed").unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        fs::File::options()
            .write(true)
            .open(root.join("a.txt"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        let (third, s3) = scan(&root, &second, None, &opts(), None).unwrap();
        assert_eq!(s3.hashed, 2);
        assert_ne!(third["docs/b.txt"].hash, first["docs/b.txt"].hash);
        assert_eq!(third["a.txt"].hash, first["a.txt"].hash);
    }

    #[test]
    fn a_store_hashes_and_stores_in_one_pass() {
        let (base, root) = make_tree();
        let store = Store::new(&base.0.join("data"));
        let (m, _) = scan(&root, &Manifest::new(), None, &opts(), Some(&store)).unwrap();
        for (rel, e) in m
            .iter()
            .filter(|(_, e)| e.kind == Kind::File && e.skipped.is_none())
        {
            let out = base.0.join("restored").join(rel);
            fs::create_dir_all(out.parent().unwrap()).unwrap();
            store.copy_out(e.hash.as_ref().unwrap(), &out).unwrap();
            assert_eq!(
                fs::read(&out).unwrap(),
                fs::read(root.join(rel)).unwrap(),
                "{rel}"
            );
        }
    }

    #[test]
    fn custom_ignore_list_patterns_and_a_missing_root() {
        let (_base, root) = make_tree();
        let o = ScanOptions {
            ignore: vec!["docs".into()],
            ignore_patterns: vec!["*.TXT".into(), "".into()],
            ..opts()
        };
        let m = full(&root, &o);
        assert!(m.contains_key("node_modules/pkg/index.js"));
        assert!(!m.contains_key("docs"));
        assert_eq!(
            m.contains_key("a.txt"),
            cfg!(target_os = "linux"),
            "patterns ignore case off Linux"
        );
        assert_eq!(
            node_code(
                &scan(&root.join("nope"), &Manifest::new(), None, &opts(), None).unwrap_err()
            ),
            "ENOENT"
        );
    }

    #[test]
    fn mewndo_temp_files_are_left_out_and_recent_files_are_pending() {
        let d = temp_dir();
        write(&d.0, "x.mewndo-tmp", b"half a restore");
        write(&d.0, "new.txt", b"just written");
        let m = full(
            &d.0,
            &ScanOptions {
                settle_ms: 60_000,
                ..opts()
            },
        );
        assert!(!m.contains_key("x.mewndo-tmp"));
        assert_eq!(
            (m["new.txt"].pending, m["new.txt"].hash.as_ref()),
            (Some(true), None)
        );
    }

    #[test]
    fn rescanning_only_the_changed_folders_gives_exactly_what_a_full_scan_gives() {
        let d = temp_dir();
        let root = &d.0;
        for rel in [
            "a.txt",
            "docs/b.md",
            "docs/old/c.md",
            "src/x.js",
            "src/lib/y.js",
            "src/lib/deep/z.js",
            "gone/q.txt",
            "swap/inner.txt",
            "Case.txt",
        ] {
            write(root, rel, rel.as_bytes());
        }
        write(root, "swapfile", b"a file that becomes a folder");
        let before = full(root, &opts());
        let mut changed: Vec<String> = Vec::new();
        let mut touch = |rel: &str| changed.push(parent_of(rel).to_string());
        write(root, "src/x.js", b"edited");
        touch("src/x.js");
        write(root, "src/new/deeper/n.js", b"n");
        touch("src/new");
        fs::remove_file(root.join("docs/b.md")).unwrap();
        touch("docs/b.md");
        fs::remove_dir_all(root.join("gone")).unwrap();
        touch("gone");
        fs::rename(root.join("src/lib"), root.join("src/library")).unwrap();
        touch("src/lib");
        touch("src/library");
        fs::remove_dir_all(root.join("swap")).unwrap();
        write(root, "swap", b"a folder that became a file");
        touch("swap");
        fs::remove_file(root.join("swapfile")).unwrap();
        write(root, "swapfile/now-a-folder.txt", b"x");
        touch("swapfile");
        fs::rename(root.join("Case.txt"), root.join("case-tmp")).unwrap();
        fs::rename(root.join("case-tmp"), root.join("case.txt")).unwrap();
        touch("case.txt");
        write(root, "node_modules/pkg/i.js", b"ignored");
        touch("node_modules/pkg/i.js");
        link_dir(&root.join("docs"), &root.join("src/docs-link"));
        touch("src/docs-link");

        let (partial, _) = scan(root, &before, Some(&changed), &opts(), None).unwrap();
        assert_eq!(partial, full(root, &opts()));
        assert!(!partial.contains_key("docs/b.md") && !partial.contains_key("src/lib/deep/z.js"));
        assert!(partial["src/library/deep/z.js"].hash.is_some());
        assert_eq!(partial["src/docs-link"].kind, Kind::Link);
    }

    #[test]
    fn a_partial_rescan_reads_only_the_changed_folders() {
        let d = temp_dir();
        for i in 0..20 {
            write(&d.0, &format!("d{i}/f.txt"), i.to_string().as_bytes());
        }
        let before = full(&d.0, &opts());
        fs::write(d.0.join("d3/f.txt"), "changed").unwrap();
        let (after, stats) = scan(&d.0, &before, Some(&["d3".to_string()]), &opts(), None).unwrap();
        assert_eq!(
            stats,
            ScanStats {
                found: 1,
                hashed: 1
            },
            "only d3/f.txt was looked at"
        );
        assert_ne!(after["d3/f.txt"].hash, before["d3/f.txt"].hash);
        assert_eq!(after["d4/f.txt"], before["d4/f.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn online_only_files_are_skipped_never_opened() {
        let d = temp_dir();
        write(&d.0, "local.txt", &[b'x'; 10_000]);
        let cloud = fs::File::create(d.0.join("cloud.docx")).unwrap();
        cloud.set_len(1_000_000).unwrap(); // sparse: a size, no space, like a placeholder
        use std::os::unix::fs::MetadataExt;
        if fs::metadata(d.0.join("cloud.docx")).unwrap().blocks() != 0 {
            return; // a file system without sparse files
        }
        let m = full(
            &d.0,
            &ScanOptions {
                skip_online_only: true,
                ..ScanOptions::default()
            },
        );
        assert_eq!(m["cloud.docx"].skipped.as_deref(), Some("online-only"));
        assert!(m["cloud.docx"].hash.is_none() && m["local.txt"].hash.is_some());
    }

    #[test]
    fn mtimes_are_computed_as_node_does() {
        let d = temp_dir();
        write(&d.0, "f", b"x");
        let t = UNIX_EPOCH + std::time::Duration::new(1_759_670_000, 123_456_700);
        fs::File::options()
            .write(true)
            .open(d.0.join("f"))
            .unwrap()
            .set_modified(t)
            .unwrap();
        // Node: 1759670000 * 1000 + 123456700 / 1e6
        assert_eq!(
            full(&d.0, &opts())["f"].mtime_ms,
            Some(1_759_670_000.0 * 1000.0 + 123_456_700.0 / 1e6)
        );
    }

    /// v0 writes mtimes as JS prints them; reading one back must give the very same number, or every file
    /// looks changed and gets re-hashed. Needs serde_json's exact float parsing (feature float_roundtrip).
    #[test]
    fn mtimes_from_a_v0_index_read_back_exactly() {
        for text in [
            "1791260419190.2947",
            "1791260419194.2947",
            "1759670000123.4567",
            "0.1",
            "1e21",
        ] {
            let x: f64 = serde_json::from_str(text).unwrap();
            assert_eq!(x, text.parse::<f64>().unwrap(), "{text}");
        }
    }

    #[test]
    fn wildcards_match_whole_names() {
        let p = |pat: &str, name: &str| Patterns::new(&[pat.to_string()]).matches(name);
        assert!(p("*.log", "a.log") && p("*.log", ".log") && !p("*.log", "a.log.txt"));
        assert!(
            p("tmp", "tmp") && !p("tmp", "tmp2") && p("a*b*c", "aXXbYc") && !p("a*b*c", "aXXbY")
        );
        assert!(p("*", "") && p("**", "x") && p("x*", "x"));
        assert!(p("a.b", "a.b") && !p("a.b", "aXb"), "dots are literal");
    }
}
