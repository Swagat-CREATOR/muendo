// Flight Recorder: Mewndo's local ledger (spec §30.2). Every guard decision,
// heal, hold, approval, save point and restore becomes an event carrying the
// §30.2 fields. Events are hash-chained per device and signed with a device key
// (HMAC-SHA256) kept in Windows Credential Manager, so rewriting or dropping any
// event is detectable. Restore receipts include the verification result.
//
// What this does NOT do yet: hourly Merkle roots, cloud anchoring and the public
// transparency log / standalone verifier are P7.2. The signature here is
// symmetric (HMAC), which proves integrity to anyone holding the device key;
// P7.2 can swap in an asymmetric device key for third-party verification.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The §30.2 event fields. Serialized in this fixed order so its hash is stable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub time_ms: u64,
    /// guard | heal | hold | approval | save_point | restore
    pub kind: String,
    pub agent: String,
    pub vendor: String,
    pub principal: String,
    pub brief_hash: String,
    pub action: serde_json::Value,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_hash: Option<String>,
    pub decision: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub model_probabilities: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approver: Option<String>,
    /// For a restore: what was restored, from which save point, and the verification result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_receipt: Option<serde_json::Value>,
}

/// One chained, signed record on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub seq: u64,
    /// Hex hash of the previous record, or "genesis" for the first.
    pub prev: String,
    pub event: Event,
    /// Hex sha256 over (seq, prev, event): the chain link.
    pub hash: String,
    /// Hex HMAC-SHA256(device_key, hash): the device signature.
    pub sig: String,
}

pub const GENESIS: &str = "genesis";

#[derive(Debug, PartialEq)]
pub enum Tamper {
    /// A record's contents don't match its stored hash.
    Altered { seq: u64 },
    /// A record's signature doesn't match (hash signed with another key, or forged).
    BadSignature { seq: u64 },
    /// The chain is broken: a wrong prev link or a gap in seq (an event was dropped or reordered).
    Broken { seq: u64 },
}

impl std::fmt::Display for Tamper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Tamper::Altered { seq } => write!(f, "record {seq} was altered"),
            Tamper::BadSignature { seq } => write!(f, "record {seq} has a bad signature"),
            Tamper::Broken { seq } => write!(
                f,
                "the chain is broken at record {seq} (an event was dropped or reordered)"
            ),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// HMAC-SHA256 (RFC 2104) over `msg` with `key`, hand-rolled on sha2 to avoid a
/// crate for twenty lines. Guarded by an RFC 4231 test vector below.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > 64 {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= block[i];
        opad[i] ^= block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    outer.finalize().into()
}

/// The chain link: sha256 over seq, prev and the event's canonical JSON.
fn link_hash(seq: u64, prev: &str, event: &Event) -> String {
    let mut h = Sha256::new();
    h.update(seq.to_le_bytes());
    h.update(prev.as_bytes());
    h.update(b"\0");
    h.update(serde_json::to_vec(event).expect("an event serializes"));
    hex(&h.finalize())
}

pub struct Ledger {
    path: PathBuf,
    key: Vec<u8>,
    records: Mutex<Vec<Record>>,
}

impl Ledger {
    /// Open the ledger at `<data_dir>/ledger.jsonl`, loading existing records and
    /// the device key (from Windows Credential Manager; a fresh per-process key
    /// elsewhere, since Mewndo ships on Windows and we never write a key to disk).
    pub fn open(data_dir: &Path) -> std::io::Result<Ledger> {
        let key = device_key()?;
        Self::open_with_key(data_dir, key)
    }

    pub fn open_with_key(data_dir: &Path, key: Vec<u8>) -> std::io::Result<Ledger> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("ledger.jsonl");
        let records = match std::fs::read_to_string(&path) {
            Ok(text) => text
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(serde_json::from_str::<Record>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        Ok(Ledger {
            path,
            key,
            records: Mutex::new(records),
        })
    }

    /// Append an event, chaining and signing it. Returns the new record.
    pub fn append(&self, event: Event) -> std::io::Result<Record> {
        let mut records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        let (seq, prev) = match records.last() {
            Some(r) => (r.seq + 1, r.hash.clone()),
            None => (0, GENESIS.to_string()),
        };
        let hash = link_hash(seq, &prev, &event);
        let sig = hex(&hmac_sha256(&self.key, hash.as_bytes()));
        let record = Record {
            seq,
            prev,
            event,
            hash,
            sig,
        };
        // Append the line first; only then keep it in memory, so a write error doesn't desync the two.
        let line = serde_json::to_string(&record).expect("a record serializes");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{line}")?;
        f.flush()?;
        records.push(record.clone());
        Ok(record)
    }

    /// Check the whole chain: every hash, every signature and every link. Returns
    /// the first problem found, or Ok if the ledger is intact.
    pub fn verify(&self) -> Result<(), Tamper> {
        let records = self.records.lock().unwrap_or_else(|e| e.into_inner());
        verify_chain(&records, &self.key)
    }

    pub fn len(&self) -> usize {
        self.records.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Verify a sequence of records against `key`. Pulled out so tests (and a future
/// P7.2 verifier) can check records that were tampered with on disk.
pub fn verify_chain(records: &[Record], key: &[u8]) -> Result<(), Tamper> {
    let mut expected_prev = GENESIS.to_string();
    for (i, r) in records.iter().enumerate() {
        if r.seq != i as u64 {
            return Err(Tamper::Broken { seq: r.seq });
        }
        if r.prev != expected_prev {
            return Err(Tamper::Broken { seq: r.seq });
        }
        if link_hash(r.seq, &r.prev, &r.event) != r.hash {
            return Err(Tamper::Altered { seq: r.seq });
        }
        if hex(&hmac_sha256(key, r.hash.as_bytes())) != r.sig {
            return Err(Tamper::BadSignature { seq: r.seq });
        }
        expected_prev = r.hash.clone();
    }
    Ok(())
}

/// Hash some bytes to the hex form the ledger uses for brief_hash/before/after.
#[cfg(test)]
pub fn hash_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

// ---- device key ----

#[cfg(windows)]
fn device_key() -> std::io::Result<Vec<u8>> {
    win_cred::load_or_create()
}

// Non-Windows (dev/CI only): a fresh random key each process. Never written to
// disk (CLAUDE.md rule 4). Old signatures won't verify across restarts here, which
// is fine because the core ships on Windows, where the key persists in Cred Manager.
#[cfg(not(windows))]
fn device_key() -> std::io::Result<Vec<u8>> {
    random_bytes(32)
}

#[cfg(unix)]
fn random_bytes(n: usize) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf)
}

#[cfg(windows)]
mod win_cred {
    // Device key in Windows Credential Manager (Generic credential), created on
    // first use with BCryptGenRandom. The key never touches a file on disk.
    use std::io::{Error, Result};
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW, CredWriteW,
    };
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };

    const TARGET: &[u16] = &{
        // "Mewndo/ledger-device-key\0" as UTF-16.
        const S: &str = "Mewndo/ledger-device-key";
        let mut out = [0u16; 25];
        let b = S.as_bytes();
        let mut i = 0;
        while i < b.len() {
            out[i] = b[i] as u16;
            i += 1;
        }
        out
    };

    pub fn load_or_create() -> Result<Vec<u8>> {
        if let Some(k) = read()? {
            return Ok(k);
        }
        let mut key = vec![0u8; 32];
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                key.as_mut_ptr(),
                key.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status != 0 {
            return Err(Error::other("BCryptGenRandom failed"));
        }
        write(&key)?;
        Ok(key)
    }

    fn read() -> Result<Option<Vec<u8>>> {
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(TARGET.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) };
        if ok == 0 {
            let e = Error::last_os_error();
            if e.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(None);
            }
            return Err(e);
        }
        let key = unsafe {
            let c = &*cred;
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
        };
        unsafe { CredFree(cred as *const _ as *mut _) };
        Ok(Some(key))
    }

    fn write(key: &[u8]) -> Result<()> {
        let mut cred: CREDENTIALW = unsafe { std::mem::zeroed() };
        cred.Type = CRED_TYPE_GENERIC;
        cred.TargetName = TARGET.as_ptr() as *mut u16;
        cred.CredentialBlob = key.as_ptr() as *mut u8;
        cred.CredentialBlobSize = key.len() as u32;
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
        cred.LastWritten = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            return Err(Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, target: &str) -> Event {
        Event {
            time_ms: 1,
            kind: kind.into(),
            agent: "claude".into(),
            vendor: "anthropic".into(),
            principal: "me".into(),
            brief_hash: hash_hex(b"brief"),
            action: serde_json::json!({"type": "delete"}),
            target: target.into(),
            before_hash: Some(hash_hex(b"before")),
            after_hash: None,
            decision: "deny".into(),
            model_probabilities: serde_json::json!({"recipient_ok": 0.1}),
            approver: None,
            restore_receipt: None,
        }
    }

    fn ledger() -> (Ledger, tempdir::TempDir) {
        let dir = tempdir::TempDir::new();
        let l = Ledger::open_with_key(dir.path(), b"device-key-0123456789".to_vec()).unwrap();
        (l, dir)
    }

    #[test]
    fn hmac_matches_rfc4231_test_case_2() {
        // RFC 4231 §4.3.
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn a_clean_chain_verifies() {
        let (l, _d) = ledger();
        l.append(event("guard", "a.txt")).unwrap();
        l.append(event("save_point", "b.txt")).unwrap();
        l.append(event("restore", "c.txt")).unwrap();
        assert_eq!(l.verify(), Ok(()));
        assert_eq!(l.len(), 3);
    }

    #[test]
    fn tampering_with_one_event_is_detected() {
        let (l, _d) = ledger();
        l.append(event("guard", "a.txt")).unwrap();
        l.append(event("hold", "b.txt")).unwrap();
        l.append(event("approval", "c.txt")).unwrap();
        // Read the records back and alter one event's target, leaving its hash and sig.
        let mut records = l.records.lock().unwrap().clone();
        records[1].event.target = "hacked.txt".into();
        assert_eq!(
            verify_chain(&records, &l.key),
            Err(Tamper::Altered { seq: 1 })
        );
        // Even if the attacker recomputes the hash, they can't forge the signature.
        records[1].hash = link_hash(records[1].seq, &records[1].prev, &records[1].event);
        assert_eq!(
            verify_chain(&records, &l.key),
            Err(Tamper::BadSignature { seq: 1 })
        );
        // Even with the device key to re-sign it, the next record's prev link no longer matches.
        records[1].sig = hex(&hmac_sha256(&l.key, records[1].hash.as_bytes()));
        assert_eq!(
            verify_chain(&records, &l.key),
            Err(Tamper::Broken { seq: 2 }),
            "rehashing one record breaks the next record's prev link"
        );
    }

    #[test]
    fn dropping_one_event_is_detected() {
        let (l, _d) = ledger();
        l.append(event("guard", "a.txt")).unwrap();
        l.append(event("guard", "b.txt")).unwrap();
        l.append(event("guard", "c.txt")).unwrap();
        let mut records = l.records.lock().unwrap().clone();
        records.remove(1); // drop the middle event
        // seq now goes 0, 2 -> the gap is caught.
        assert_eq!(
            verify_chain(&records, &l.key),
            Err(Tamper::Broken { seq: 2 })
        );
    }

    #[test]
    fn a_forged_signature_with_another_key_is_detected() {
        let (l, _d) = ledger();
        l.append(event("guard", "a.txt")).unwrap();
        let mut records = l.records.lock().unwrap().clone();
        records[0].sig = hex(&hmac_sha256(b"attacker-key", records[0].hash.as_bytes()));
        assert_eq!(
            verify_chain(&records, &l.key),
            Err(Tamper::BadSignature { seq: 0 })
        );
    }

    #[test]
    fn records_survive_a_reopen() {
        let dir = tempdir::TempDir::new();
        let key = b"device-key-0123456789".to_vec();
        {
            let l = Ledger::open_with_key(dir.path(), key.clone()).unwrap();
            l.append(event("guard", "a.txt")).unwrap();
            l.append(event("restore", "b.txt")).unwrap();
        }
        let l2 = Ledger::open_with_key(dir.path(), key).unwrap();
        assert_eq!(l2.len(), 2);
        assert_eq!(l2.verify(), Ok(()));
    }

    // Minimal temp dir without a dev-dependency.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct TempDir(PathBuf);
        impl TempDir {
            pub fn new() -> TempDir {
                let mut p = std::env::temp_dir();
                let n = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                p.push(format!(
                    "mewndo-ledger-test-{n}-{:?}",
                    std::thread::current().id()
                ));
                std::fs::create_dir_all(&p).unwrap();
                TempDir(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
