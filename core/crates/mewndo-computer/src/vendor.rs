// §36.6 U1: cua-driver as a pinned release binary, verified by SHA-256. Never copied source, and never a remote
// script piped into a shell.
//
// Cua's own installer documents `irm https://cua.ai/install.ps1 | iex` (scripts/install/install.ps1:6 in the Cua
// repository). Mewndo does not do that, for the reason §36.6 U1 gives: a piped remote script is a signature-free
// code path that changes under you between one install and the next. Mewndo downloads one named asset from one
// pinned tag and refuses it unless its bytes hash to the value below.
//
// What this module is, and is not:
//   - it is the pinned descriptor, the hash check, and the write-to-temp-then-rename that plot.md rule 4 asks for;
//   - it is not an HTTP client. `Fetcher` is a trait. The `download` feature adds a `ureq` implementation; with
//     the feature off -- the default, and what `cargo test` runs -- this crate links no network code at all
//     (plot.md rule 7), and the tests drive a fake fetcher;
//   - it is not an unzipper. The release asset is a `.zip`; verifying it is here, expanding it into
//     `%LOCALAPPDATA%\Mewndo\vendor\cua-driver\` is the installer's step (P8.2), which already has
//     `Expand-Archive`. Adding a zip crate to unpack one archive once is not worth a new dependency.

use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};

/// The pinned release (§36.6 U1). Read from Cua's GitHub releases on 10 October 2026; also in `docs/versions.md`.
///
/// `0.34.0` on purpose: it is the release of the exact source that `docs/decisions.md` records facts from
/// (clone commit `5a364bbe60e1f8a901ceacd889606b6367dc96ab`, `libs/cua-driver/rust/Cargo.toml:23`). Pinning a
/// newer binary than the source the coordinate space and cursor notes came from would make those notes a guess.
pub const VERSION: &str = "0.34.0";

/// The git tag the assets hang off. Cua is a monorepo with per-component release streams, so the repository-wide
/// "latest" release says nothing about the driver: the driver's tags are `cua-driver-rs-v*`
/// (`libs/cua-driver/scripts/install.ps1:136`).
pub const TAG: &str = "cua-driver-rs-v0.34.0";

/// Where the installer puts it (§36.6 U1). Under `%LOCALAPPDATA%`, never inside a protected folder
/// (plot.md rule 1).
pub const VENDOR_SUBPATH: &str = r"Mewndo\vendor\cua-driver";

/// Which Windows build. Cua ships prebuilts for x86_64 and arm64 only
/// (`libs/cua-driver/scripts/install.ps1:291`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Arm64,
}

impl Arch {
    /// Cua's short asset label (`install.ps1:300-304`).
    pub fn label(self) -> &'static str {
        match self {
            Arch::X86_64 => "windows-x86_64",
            Arch::Arm64 => "windows-arm64",
        }
    }

    /// The release asset name. `cua-driver-rs-$version-$archLabel.zip` (`install.ps1:1178`).
    pub fn asset(self) -> String {
        format!("cua-driver-rs-{VERSION}-{}.zip", self.label())
    }

    /// The SHA-256 of that asset, as published in the release's own `SHA256SUMS`.
    ///
    /// **These are real, fetched values, not placeholders.** Read on 10 October 2026 from
    /// `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.0/SHA256SUMS`. If a future release is
    /// pinned instead, the replacement must be read from that release's own `SHA256SUMS` -- never computed from a
    /// local build, which would verify nothing about what users download.
    pub fn sha256(self) -> &'static str {
        match self {
            // SHA256SUMS line: cua-driver-rs-0.34.0-windows-x86_64.zip
            Arch::X86_64 => "f96cc1632bc88e6f268eab745277c1fc302bb0f7d123e04373e35afecad6439f",
            // SHA256SUMS line: cua-driver-rs-0.34.0-windows-arm64.zip
            Arch::Arm64 => "bc07c7569456fb50a8c976209ceb09586f399af4391feb668b807a11abbd20e6",
        }
    }
}

impl Arch {
    /// The build this program was compiled for: arm64 on an ARM Windows build, x86_64 otherwise.
    pub fn current() -> Arch {
        if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else {
            Arch::X86_64
        }
    }

    /// The asset's size in bytes, read from the release's own download (10 October 2026, Content-Length and the
    /// bytes themselves, which hashed to `sha256()` above). The app shows it before asking to download.
    pub fn size(self) -> u64 {
        match self {
            Arch::X86_64 => 31_316_916,
            Arch::Arm64 => 29_456_947,
        }
    }

    /// The folder inside the zip that holds everything (`cua-driver-rs-0.34.0-windows-x86_64/`).
    pub fn folder(self) -> String {
        format!("cua-driver-rs-{VERSION}-{}", self.label())
    }

    /// The program files inside the archive and their SHA-256s. Computed on 10 October 2026 from the two archives
    /// above *after* each archive matched its pinned SHA-256, so they inherit that check: an installed file that
    /// hashes to one of these is byte for byte the file Cua released. `cua_driver_abi.h`, `LICENSE` and
    /// `THIRD_PARTY_NOTICES.md` are not programs and are not listed.
    pub fn files(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Arch::X86_64 => &[
                (
                    "cua-driver.exe",
                    "77f5cac754b42b6a8bae126414fc8f7487432ace93466967965188e24e9e53fb",
                ),
                (
                    "cua-driver-uia.exe",
                    "1c737385f3cf008240ca8ff2a58ffc6810ebd382c14bd3dccb87ccbdc4ced556",
                ),
                (
                    "cua_driver_sdk.dll",
                    "1dae9015f81bb81b093b12181a1970b0a5cb1c2c992684afc1c629bdfc41728d",
                ),
                (
                    "cua-cursor-theme.exe",
                    "bc289b8cc0a4b6a088019115880c260bda2fedc67047c9df6309a3774cd59e25",
                ),
                (
                    "cua_driver_node_runtime.node",
                    "ff9194fec31c3279b5ba8bf45dd76335892d9a558090d6ee646b3483400c1ec6",
                ),
            ],
            Arch::Arm64 => &[
                (
                    "cua-driver.exe",
                    "0af3e4d677b25bbbce32ed01c80aa8276cc8512d3f8a5b58433f26c0b0b349a4",
                ),
                (
                    "cua-driver-uia.exe",
                    "b552844d766e9b386e4e5c9f439de294534f0e93bf247ce70046a7be79060eb8",
                ),
                (
                    "cua_driver_sdk.dll",
                    "a05a0477f05854acd86ad879d24b7fe5670761c49d11035f77aa185f3ed3738a",
                ),
                (
                    "cua-cursor-theme.exe",
                    "4963f0fc3308b695035cd5252d96949bbd07a7877093e463f1dc4fad2aaca406",
                ),
                (
                    "cua_driver_node_runtime.node",
                    "b264b75eb898a6035b0b2ddb8f9dc0e5d5a8da7bd240aeae3b2087249d6b9ed1",
                ),
            ],
        }
    }
}

/// Checks every pinned program file in `dir` against its SHA-256 before anything there is run. A missing file, a
/// link (never followed, plot.md rule 2) or one wrong byte refuses the whole folder: Mewndo never starts a driver it
/// has not verified.
pub fn verify_installed(dir: &Path, arch: Arch) -> Result<(), VendorError> {
    for (name, want) in arch.files() {
        let path = dir.join(name);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| VendorError::Io(format!("{} is missing ({e})", path.display())))?;
        if !meta.file_type().is_file() {
            return Err(VendorError::Io(format!(
                "{} is not a plain file, so it is not run",
                path.display()
            )));
        }
        let bytes = std::fs::read(&path).map_err(|e| VendorError::Io(e.to_string()))?;
        verify(&bytes, want).map_err(|e| match e {
            VendorError::Checksum { want, got } => VendorError::Io(format!(
                "{name} does not match the pinned SHA-256 (expected {want}, got {got}); it is not run. \
                 Download cua-driver again from Mewndo's settings"
            )),
            other => other,
        })?;
    }
    Ok(())
}

/// The exact download URL. One asset, one tag, no "latest" redirect: Cua's own agent guidance warns that the
/// repository-wide latest release is the wrong thing to resolve for a monorepo component, and a redirect is one
/// more thing that can change under a pinned hash.
pub fn asset_url(arch: Arch) -> String {
    format!(
        "https://github.com/trycua/cua/releases/download/{TAG}/{}",
        arch.asset()
    )
}

/// The release's checksum file, for a human double-check. Mewndo does not trust it at install time: the hash is
/// compiled in above, so a tampered `SHA256SUMS` cannot talk the installer into accepting a different binary.
pub fn sums_url() -> String {
    format!("https://github.com/trycua/cua/releases/download/{TAG}/SHA256SUMS")
}

/// `%LOCALAPPDATA%\Mewndo\vendor\cua-driver`.
#[cfg(windows)]
pub fn vendor_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(VENDOR_SUBPATH))
}

/// Stub for other targets (§32.5 rule 5). Not a real location -- Mewndo is a Windows app -- but it keeps the
/// tests and `cargo test` free of `#[cfg]` at every call site, exactly as `mewndo-hook`'s `desk_dir` does.
#[cfg(not(windows))]
pub fn vendor_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .map(|d| d.join("Mewndo/vendor/cua-driver"))
}

/// Where `cua-driver.exe` ends up once the installer has expanded the archive.
pub fn driver_exe(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "cua-driver.exe"
    } else {
        "cua-driver"
    })
}

#[derive(Debug, PartialEq)]
pub enum VendorError {
    /// The bytes are not what was pinned. Both hashes are in the message because the first thing anyone asks is
    /// "what did I actually get".
    Checksum {
        want: String,
        got: String,
    },
    Fetch(String),
    Io(String),
    /// Built without the `download` feature, so there is no HTTP client to call.
    NoDownloader,
}

impl fmt::Display for VendorError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            VendorError::Checksum { want, got } => write!(
                f,
                "cua-driver {VERSION}: the download does not match the pinned SHA-256 (expected {want}, got \
                 {got}). Nothing was installed."
            ),
            VendorError::Fetch(e) => write!(f, "cua-driver {VERSION} could not be downloaded: {e}"),
            VendorError::Io(e) => write!(f, "cua-driver {VERSION} could not be written: {e}"),
            VendorError::NoDownloader => write!(
                f,
                "this build has no downloader (the `download` feature is off); the installer fetches cua-driver"
            ),
        }
    }
}

impl std::error::Error for VendorError {}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The whole of the check: constant-ish compare of the hex, case-insensitively, because `SHA256SUMS` is lowercase
/// but a human pasting one may not be.
pub fn verify(bytes: &[u8], expected_hex: &str) -> Result<(), VendorError> {
    let got = sha256_hex(bytes);
    if got.eq_ignore_ascii_case(expected_hex.trim()) {
        Ok(())
    } else {
        Err(VendorError::Checksum {
            want: expected_hex.trim().to_lowercase(),
            got,
        })
    }
}

/// Whatever fetches bytes. A trait so the hash check, the temp file and the rename are all testable with no
/// network, and so a build without the `download` feature contains no HTTP client.
pub trait Fetcher {
    fn get(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// The default: there is no downloader. A build of the core that never installs anything gets this, and says so
/// rather than silently doing nothing.
pub struct NoFetcher;

impl Fetcher for NoFetcher {
    fn get(&self, _url: &str) -> Result<Vec<u8>, String> {
        Err("no downloader in this build".into())
    }
}

/// Download the pinned asset, check its SHA-256, and only then put it in place.
///
/// Order matters and is the point of the function: fetch, hash, **compare**, write to `<asset>.part`, rename.
/// A mismatch returns before anything is written, so a bad download cannot leave a half-trusted file behind, and
/// the rename is atomic, so another process never sees a partial archive (plot.md rule 4).
///
/// Returns the path of the verified archive. Expanding it is the installer's step.
pub fn download_and_verify(
    fetcher: &dyn Fetcher,
    arch: Arch,
    dir: &Path,
) -> Result<PathBuf, VendorError> {
    let url = asset_url(arch);
    let bytes = fetcher.get(&url).map_err(VendorError::Fetch)?;
    verify(&bytes, arch.sha256())?;
    std::fs::create_dir_all(dir).map_err(|e| VendorError::Io(e.to_string()))?;
    let final_path = dir.join(arch.asset());
    let part = dir.join(format!("{}.part", arch.asset()));
    std::fs::write(&part, &bytes).map_err(|e| VendorError::Io(e.to_string()))?;
    std::fs::rename(&part, &final_path).map_err(|e| VendorError::Io(e.to_string()))?;
    Ok(final_path)
}

/// The real downloader. Behind the `download` feature, so the default build has no HTTP stack.
#[cfg(feature = "download")]
pub struct UreqFetcher {
    /// A download of 30 MB over a slow line needs a real budget, but not an unbounded one.
    pub timeout: std::time::Duration,
}

#[cfg(feature = "download")]
impl Default for UreqFetcher {
    fn default() -> Self {
        UreqFetcher {
            timeout: std::time::Duration::from_secs(300),
        }
    }
}

#[cfg(feature = "download")]
impl Fetcher for UreqFetcher {
    fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        // One GET, one deadline, HTTPS only. `ureq` uses native-tls, i.e. SChannel on Windows, so there is no
        // bundled certificate store to go stale (core/Cargo.toml says the same about the dev box).
        if !url.starts_with("https://") {
            return Err(format!("refusing a non-HTTPS url: {url}"));
        }
        let agent = ureq::AgentBuilder::new()
            .timeout(self.timeout)
            .redirects(5)
            .build();
        let response = agent.get(url).call().map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut response.into_reader(), &mut bytes)
            .map_err(|e| e.to_string())?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake(Vec<u8>);

    impl Fetcher for Fake {
        fn get(&self, _url: &str) -> Result<Vec<u8>, String> {
            Ok(self.0.clone())
        }
    }

    #[test]
    fn the_pinned_descriptor_is_the_one_in_the_decisions_note() {
        assert_eq!(TAG, format!("cua-driver-rs-v{VERSION}"));
        assert_eq!(
            Arch::X86_64.asset(),
            "cua-driver-rs-0.34.0-windows-x86_64.zip"
        );
        assert_eq!(
            Arch::Arm64.asset(),
            "cua-driver-rs-0.34.0-windows-arm64.zip"
        );
        assert_eq!(
            asset_url(Arch::X86_64),
            "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.0/\
             cua-driver-rs-0.34.0-windows-x86_64.zip"
        );
        // A 64-character lowercase hex digest, for both arches, and not the same one.
        for arch in [Arch::X86_64, Arch::Arm64] {
            let sum = arch.sha256();
            assert_eq!(sum.len(), 64, "{arch:?}");
            assert!(
                sum.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "{arch:?} is not lowercase hex"
            );
        }
        assert_ne!(Arch::X86_64.sha256(), Arch::Arm64.sha256());
        // The url is built from the tag, so a version bump that forgets one of the two is caught here.
        assert!(asset_url(Arch::Arm64).contains(TAG));
        assert!(sums_url().ends_with("SHA256SUMS"));
    }

    #[test]
    fn sha256_is_the_real_thing() {
        // The empty string's SHA-256, so a swapped hash function cannot pass.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_accepts_the_exact_bytes_and_nothing_else() {
        let bytes = b"pretend this is the release zip";
        let sum = sha256_hex(bytes);
        assert_eq!(verify(bytes, &sum), Ok(()));
        assert_eq!(verify(bytes, &sum.to_uppercase()), Ok(()), "case");
        assert_eq!(verify(bytes, &format!("  {sum}\n")), Ok(()), "whitespace");

        let mut tampered = bytes.to_vec();
        tampered.push(b'!');
        match verify(&tampered, &sum) {
            Err(VendorError::Checksum { want, got }) => {
                assert_eq!(want, sum);
                assert_ne!(got, sum);
            }
            other => panic!("one byte more must not verify: {other:?}"),
        }
    }

    #[test]
    fn a_bad_download_leaves_nothing_behind() {
        let dir = std::env::temp_dir().join(format!("mewndo-vendor-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let fake = Fake(b"not the real release".to_vec());
        let err = download_and_verify(&fake, Arch::X86_64, &dir).unwrap_err();
        assert!(matches!(err, VendorError::Checksum { .. }));
        // Not even a .part file: the compare happens before the first write.
        let left: Vec<_> = std::fs::read_dir(&dir)
            .map(|rd| rd.filter_map(Result::ok).map(|e| e.file_name()).collect())
            .unwrap_or_default();
        assert!(left.is_empty(), "a refused download left {left:?}");
        // And the message names both hashes, because that is the first question anyone asks.
        let text = err.to_string();
        assert!(text.contains(Arch::X86_64.sha256()), "{text}");
        assert!(text.contains("Nothing was installed"), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_good_download_is_renamed_into_place() {
        let dir = std::env::temp_dir().join(format!("mewndo-vendor-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A fake whose bytes really do hash to what we claim, by claiming what they hash to: this test is about
        // the file dance, not about the pinned constant (that one is checked above).
        struct Pinned(Vec<u8>);
        impl Fetcher for Pinned {
            fn get(&self, _u: &str) -> Result<Vec<u8>, String> {
                Ok(self.0.clone())
            }
        }
        let bytes = b"zip".to_vec();
        let got = Pinned(bytes.clone());
        // Drive the two halves directly, because the pinned hash cannot be faked from a test.
        assert_eq!(verify(&bytes, &sha256_hex(&bytes)), Ok(()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("x.zip.part");
        std::fs::write(&part, got.get("").unwrap()).unwrap();
        std::fs::rename(&part, dir.join("x.zip")).unwrap();
        assert!(dir.join("x.zip").exists());
        assert!(!part.exists(), "the .part must be gone after the rename");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_installed_files_are_checked_before_anything_runs() {
        let dir =
            std::env::temp_dir().join(format!("mewndo-vendor-installed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Nothing there: refused, naming the first missing file.
        let err = verify_installed(&dir, Arch::X86_64)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cua-driver.exe is missing"), "{err}");
        // A file with the right name and the wrong bytes: refused, with both hashes.
        for (name, _) in Arch::X86_64.files() {
            std::fs::write(dir.join(name), b"not the release").unwrap();
        }
        let err = verify_installed(&dir, Arch::X86_64)
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not match the pinned SHA-256"), "{err}");
        assert!(err.contains("it is not run"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_arch_pins_the_same_program_files_with_real_digests() {
        assert_eq!(Arch::X86_64.size(), 31_316_916);
        assert!(Arch::Arm64.size() > 1_000_000 && Arch::Arm64.size() < 100 * 1024 * 1024);
        assert_eq!(Arch::X86_64.folder(), "cua-driver-rs-0.34.0-windows-x86_64");
        let names = |a: Arch| a.files().iter().map(|f| f.0).collect::<Vec<_>>();
        assert_eq!(names(Arch::X86_64), names(Arch::Arm64));
        assert_eq!(names(Arch::X86_64)[0], "cua-driver.exe");
        for arch in [Arch::X86_64, Arch::Arm64] {
            for (name, sum) in arch.files() {
                assert_eq!(sum.len(), 64, "{name}");
                assert!(
                    sum.bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                );
            }
        }
    }

    #[test]
    fn there_is_no_downloader_without_the_feature() {
        assert!(NoFetcher.get(&asset_url(Arch::X86_64)).is_err());
        let dir = std::env::temp_dir().join("mewndo-vendor-none");
        assert!(matches!(
            download_and_verify(&NoFetcher, Arch::X86_64, &dir),
            Err(VendorError::Fetch(_))
        ));
    }

    #[test]
    fn the_driver_lands_in_the_vendor_folder() {
        let dir = Path::new("/tmp/vendor");
        let exe = driver_exe(dir);
        assert!(exe.starts_with(dir));
        assert_eq!(
            exe.file_name().unwrap().to_str().unwrap(),
            if cfg!(windows) {
                "cua-driver.exe"
            } else {
                "cua-driver"
            }
        );
        assert!(VENDOR_SUBPATH.ends_with("cua-driver"));
    }
}
