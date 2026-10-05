// mewndo-core's log: <logs>/mewndo-core.log, next to the app's mewndo.log and rotated the same way (log.js): past
// 1 MB it becomes mewndo-core.log.1, older ones move up, 3 are kept. Its own file, so the app's rotation and this
// one never race. A failure to log never breaks the core.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Log {
    file: PathBuf,
    max_bytes: u64,
    keep: u32,
    lock: Mutex<()>,
}

impl Log {
    pub fn new(dir: &Path) -> Log {
        Log::with_limit(dir, 1024 * 1024, 3)
    }

    pub fn with_limit(dir: &Path, max_bytes: u64, keep: u32) -> Log {
        Log {
            file: dir.join("mewndo-core.log"),
            max_bytes,
            keep,
            lock: Mutex::new(()),
        }
    }

    pub fn info(&self, message: &str) {
        self.write("INFO", message)
    }
    pub fn warn(&self, message: &str) {
        self.write("WARN", message)
    }
    pub fn error(&self, message: &str) {
        self.write("ERROR", message)
    }

    fn write(&self, level: &str, message: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let line = format!(
            "{} {level:<5} {}\n",
            now_iso(),
            message.replace('\n', "\n    ")
        );
        let _ = (|| -> std::io::Result<()> {
            if let Some(dir) = self.file.parent() {
                fs::create_dir_all(dir)?;
            }
            let size = fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0);
            if size > 0 && size + line.len() as u64 > self.max_bytes {
                self.rotate();
            }
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.file)?
                .write_all(line.as_bytes())
        })();
    }

    fn rotate(&self) {
        let numbered = |i: u32| PathBuf::from(format!("{}.{i}", self.file.display()));
        for i in (1..self.keep).rev() {
            let _ = fs::rename(numbered(i), numbered(i + 1));
        }
        let _ = fs::rename(&self.file, numbered(1));
    }
}

/// "2023-11-14T22:13:20.123Z", like JavaScript's toISOString().
fn now_iso() -> String {
    iso(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

fn iso(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    // Days since 1970 to a calendar date (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_match_javascript() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z"); // leap day
        assert_eq!(iso(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn rotates_and_keeps_only_some_files() {
        let dir = std::env::temp_dir().join(format!("mewndo-core-log-test-{}", std::process::id()));
        let log = Log::with_limit(&dir, 200, 2);
        for i in 0..40 {
            log.info(&format!("line {i}"));
        }
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["mewndo-core.log", "mewndo-core.log.1", "mewndo-core.log.2"]
        );
        let current = fs::read_to_string(dir.join("mewndo-core.log")).unwrap();
        assert!(current.len() <= 200);
        assert!(current.trim_end().ends_with("INFO  line 39"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
