// Exact paths on Windows. Normal Windows paths quietly drop trailing dots and spaces from names ("notes." opens
// "notes") and stop at 260 characters. The \\?\ form does neither, so a file named "notes." or one deep in a long
// path is reached as it really is. Node, and so the v0 engine, uses \\?\ for every file call; this matches it:
// resolve . and .. as text (as Node's path.resolve does, never through links), then add \\?\.
// Every path the core gets for file work goes through exact(). Elsewhere it changes nothing.
use std::path::{Path, PathBuf};

/// A path as people and Node show it: exact() undone, so \\?\C:\x is C:\x and \\?\UNC\s\x is \\s\x. Node's
/// readlink gives link targets this way too, and v0 stores them so.
pub fn display(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s
        .strip_prefix(r"\\?\")
        .filter(|r| r.as_bytes().get(1) == Some(&b':'))
    {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// The folder's long real path: links followed, Windows 8.3 short aliases (JOHNSM~1) expanded. Every protected
/// folder is known by this (see docs/known-issues.md), in exact() form.
pub fn real(p: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(exact(p))
}

#[cfg(not(windows))]
pub fn exact(p: &Path) -> PathBuf {
    p.to_path_buf()
}

#[cfg(windows)]
pub fn exact(p: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::path::{Component, Prefix};
    let mut components = p.components().peekable();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return p.to_path_buf(); // relative: nothing to anchor it to
    };
    let mut out = match prefix.kind() {
        Prefix::Disk(drive) => OsString::from(format!(r"\\?\{}:", drive as char)),
        Prefix::UNC(server, share) => {
            let mut s = OsString::from(r"\\?\UNC\");
            s.push(server);
            s.push(r"\");
            s.push(share);
            s
        }
        _ => return p.to_path_buf(), // already \\?\ or a device path
    };
    if components.peek() != Some(&Component::RootDir) {
        return p.to_path_buf(); // "C:notes.txt" is relative to C:'s current folder
    }
    let mut names = Vec::new();
    for c in components {
        match c {
            Component::Normal(name) => names.push(name),
            Component::ParentDir => {
                names.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    if names.is_empty() {
        out.push(r"\");
    }
    for name in names {
        out.push(r"\");
        out.push(name);
    }
    PathBuf::from(out)
}

#[cfg(test)]
mod display_tests {
    use super::display;
    use std::path::Path;

    #[test]
    fn display_undoes_the_exact_prefix_only() {
        assert_eq!(display(Path::new(r"\\?\C:\Users\me")), r"C:\Users\me");
        assert_eq!(
            display(Path::new(r"\\?\UNC\server\share\x")),
            r"\\server\share\x"
        );
        assert_eq!(
            display(Path::new(r"\\?\Volume{1234}\x")),
            r"\\?\Volume{1234}\x"
        );
        assert_eq!(display(Path::new("relative/x")), "relative/x");
        assert_eq!(display(Path::new("/home/me")), "/home/me");
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::exact;
    use std::path::Path;

    fn ex(p: &str) -> String {
        exact(Path::new(p)).to_string_lossy().into_owned()
    }

    #[test]
    fn drive_paths_get_the_prefix_and_keep_trailing_dots_and_spaces() {
        assert_eq!(ex(r"C:\Users\me\notes."), r"\\?\C:\Users\me\notes.");
        assert_eq!(ex(r"C:\Users\me\draft "), r"\\?\C:\Users\me\draft ");
        assert_eq!(ex(r"D:\"), r"\\?\D:\");
    }

    #[test]
    fn dots_and_slashes_are_resolved_as_text() {
        assert_eq!(ex(r"C:\a\.\b\..\c"), r"\\?\C:\a\c");
        assert_eq!(ex("C:/a/b/c.txt"), r"\\?\C:\a\b\c.txt");
        assert_eq!(ex(r"C:\..\..\a"), r"\\?\C:\a");
    }

    #[test]
    fn network_paths_use_the_unc_form() {
        assert_eq!(
            ex(r"\\server\share\dir\f.txt"),
            r"\\?\UNC\server\share\dir\f.txt"
        );
    }

    #[test]
    fn exact_relative_and_drive_relative_paths_are_left_alone() {
        for p in [
            r"\\?\C:\already",
            "relative\\x",
            r"C:notes.txt",
            r"\\.\pipe\x",
        ] {
            assert_eq!(ex(p), p);
        }
    }
}
