// R7: the decision cache (spec §34.9 R7, §34.8). The same brief hash and action signature reuse the verdict
// for 5 minutes.
//
// §34.9 R7 names `moka::future::Cache`. This is thirty lines of HashMap behind a Mutex instead, because moka
// buys concurrency this does not need: the cache is read once per agent action, a few times a second at
// worst, and the lock is held for a hash lookup. When the router is answering thousands of actions a second,
// swap the inside of this file and nothing above it changes.
//
// Why a cache at all, since the rules are microseconds: the cache is in front of the *network*, not in front
// of the rules. An agent that runs `npm test` five times in a minute should cost one Clef call.
//
// And why it holds the model's *answers* rather than the finished decision, which is what §34.9 R7's type
// signature suggests: the decision also depends on the agent's mode and on the user's habits, both of which
// can change inside five minutes. A cached decision would let an active-mode allow be replayed to a
// shadow-mode agent, which is exactly what §34.6 forbids. Caching the answers caches the part that cost a
// network round trip and leaves `decide` to run fresh on every action, where it belongs.

use crate::sig::Sig;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// §34.8: five minutes.
pub const TTL: Duration = Duration::from_secs(300);

pub struct TtlCache<T> {
    ttl: Duration,
    entries: Mutex<HashMap<Sig, (Instant, T)>>,
}

impl<T: Clone> Default for TtlCache<T> {
    fn default() -> TtlCache<T> {
        TtlCache::new(TTL)
    }
}

impl<T: Clone> TtlCache<T> {
    pub fn new(ttl: Duration) -> TtlCache<T> {
        TtlCache {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// `now` is passed in rather than read, so a test can prove the entry expires without sleeping for five
    /// minutes.
    pub fn get_at(&self, key: &Sig, now: Instant) -> Option<T> {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries
            .get(key)
            .filter(|(at, _)| now.duration_since(*at) < self.ttl)
            .map(|(_, v)| v.clone())
    }

    pub fn put_at(&self, key: Sig, value: T, now: Instant) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        // Expired entries are dropped on write, so a long session cannot grow the map without bound and no
        // background sweeper is needed.
        entries.retain(|_, (at, _)| now.duration_since(*at) < self.ttl);
        entries.insert(key, (now, value));
    }

    pub fn get(&self, key: &Sig) -> Option<T> {
        self.get_at(key, Instant::now())
    }

    pub fn put(&self, key: Sig, value: T) {
        self.put_at(key, value, Instant::now())
    }

    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
