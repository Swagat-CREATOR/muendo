// G3: the replay buffer (spec §33.10 Part G step 3).
//
// "Keep a 256 KB ring buffer per lane, so a reopened window shows recent output." That is the whole contract,
// and the two halves of it are equally load-bearing:
//
//   * the last 256 KB are kept, so closing and reopening a lane window shows what the agent just said;
//   * no more than 256 KB are kept, so a lane that has been running `cargo build` all afternoon costs the same
//     as one that started a minute ago. A lane that grew without limit would be a memory leak with a terminal
//     attached to it.
//
// Raw bytes, not lines and not parsed escape sequences: xterm.js in the lane window is the terminal emulator,
// and replaying the exact byte stream is the only way a reopened window lands in the same state - the same
// colours, the same cursor position, the same alternate screen - as the one that was closed. Splitting on
// newlines would cut an escape sequence in half.
//
// Pure: no clock, no handles, no platform. §32.5 rule 5 keeps it that way so `cargo test` covers it in WSL.

/// §33.10 Part G step 3.
pub const CAPACITY: usize = 256 * 1024;

/// The last [`CAPACITY`] bytes a lane produced, in order.
#[derive(Debug)]
pub struct Ring {
    buf: Vec<u8>,
    /// Where the next byte goes. Also the oldest byte once `full`.
    head: usize,
    full: bool,
    /// Everything ever written, including what has been overwritten. The lane window uses it to tell
    /// "nothing yet" from "a lot, and you are seeing the end of it".
    total: u64,
}

impl Default for Ring {
    fn default() -> Ring {
        Ring::with_capacity(CAPACITY)
    }
}

impl Ring {
    /// `capacity` is raised to 1: a zero-length ring would make `head % capacity` divide by zero, and a lane
    /// that remembers nothing is not a thing the spec asks for.
    pub fn with_capacity(capacity: usize) -> Ring {
        Ring {
            buf: vec![0; capacity.max(1)],
            head: 0,
            full: false,
            total: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    pub fn len(&self) -> usize {
        if self.full { self.buf.len() } else { self.head }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Total bytes ever pushed, including the ones that have since been overwritten.
    pub fn written(&self) -> u64 {
        self.total
    }

    /// True once bytes have been dropped off the front, so the lane window can say so.
    pub fn truncated(&self) -> bool {
        self.total > self.buf.len() as u64
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        let cap = self.buf.len();
        // A single chunk bigger than the ring: only its tail can survive, so copy only that. Without this the
        // loop below would wrap the whole chunk round the buffer for nothing - 8 MB of copying to keep 256 KB.
        let bytes = if bytes.len() > cap {
            self.full = true;
            self.head = 0;
            &bytes[bytes.len() - cap..]
        } else {
            bytes
        };
        // At most two memcpy: up to the end of the buffer, then the wrap.
        let first = (cap - self.head).min(bytes.len());
        self.buf[self.head..self.head + first].copy_from_slice(&bytes[..first]);
        if first < bytes.len() {
            let rest = bytes.len() - first;
            self.buf[..rest].copy_from_slice(&bytes[first..]);
        }
        let head = self.head + bytes.len();
        if head >= cap {
            self.full = true;
        }
        self.head = head % cap;
    }

    /// Everything kept, oldest first. What a reopened lane window is sent before any live output.
    pub fn snapshot(&self) -> Vec<u8> {
        if !self.full {
            return self.buf[..self.head].to_vec();
        }
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.head..]);
        out.extend_from_slice(&self.buf[..self.head]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_ring_replays_nothing() {
        let r = Ring::default();
        assert_eq!(r.capacity(), 256 * 1024);
        assert!(r.is_empty());
        assert_eq!(r.snapshot(), Vec::<u8>::new());
        assert!(!r.truncated());
    }

    #[test]
    fn under_capacity_everything_is_kept_in_order() {
        let mut r = Ring::default();
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.snapshot(), b"hello world");
        assert_eq!(r.len(), 11);
        assert_eq!(r.written(), 11);
        assert!(!r.truncated());
    }

    // The §33.10 Part G step 3 test: the last 256 KB and no more.
    #[test]
    fn the_last_256_kb_are_kept_and_no_more() {
        let mut r = Ring::default();
        // 300 KB in 1 KB writes, each byte its own position in the stream, so "which 256 KB" is checkable.
        let mut stream = Vec::new();
        for i in 0..300 {
            let chunk: Vec<u8> = (0..1024)
                .map(|b| (i as u8).wrapping_mul(31).wrapping_add(b as u8))
                .collect();
            r.push(&chunk);
            stream.extend_from_slice(&chunk);
        }
        assert_eq!(stream.len(), 300 * 1024);
        let kept = r.snapshot();
        assert_eq!(kept.len(), CAPACITY, "exactly 256 KB, never more");
        assert_eq!(r.len(), CAPACITY);
        assert_eq!(
            kept,
            stream[stream.len() - CAPACITY..],
            "and it is the LAST 256 KB"
        );
        assert_eq!(r.written(), 300 * 1024);
        assert!(
            r.truncated(),
            "the window must be able to say bytes were dropped"
        );
    }

    #[test]
    fn exactly_capacity_is_kept_whole_and_one_more_byte_drops_the_first() {
        let mut r = Ring::with_capacity(8);
        r.push(b"12345678");
        assert_eq!(r.snapshot(), b"12345678");
        assert!(!r.truncated(), "nothing has been dropped yet");
        r.push(b"9");
        assert_eq!(r.snapshot(), b"23456789");
        assert!(r.truncated());
        assert_eq!(r.len(), 8);
    }

    #[test]
    fn one_write_larger_than_the_ring_keeps_only_its_tail() {
        let mut r = Ring::with_capacity(4);
        r.push(b"abcdefghij");
        assert_eq!(r.snapshot(), b"ghij");
        assert_eq!(r.written(), 10);
        // And the ring still works afterwards: the head was reset, not left past the end.
        r.push(b"kl");
        assert_eq!(r.snapshot(), b"ijkl");
    }

    #[test]
    fn wrapping_writes_land_in_the_right_order() {
        // Every offset of a write across the wrap point, checked against a plain Vec that keeps the tail.
        for write in 1..=9usize {
            let mut r = Ring::with_capacity(6);
            let mut plain: Vec<u8> = Vec::new();
            for round in 0..7u8 {
                let chunk: Vec<u8> = (0..write).map(|i| round * 16 + i as u8).collect();
                r.push(&chunk);
                plain.extend_from_slice(&chunk);
                let want = &plain[plain.len().saturating_sub(6)..];
                assert_eq!(r.snapshot(), want, "write {write}, round {round}");
            }
        }
    }

    #[test]
    fn empty_writes_change_nothing() {
        let mut r = Ring::with_capacity(4);
        r.push(b"ab");
        r.push(b"");
        assert_eq!(r.snapshot(), b"ab");
        assert_eq!(r.written(), 2);
    }

    #[test]
    fn a_zero_capacity_ring_is_raised_to_one_rather_than_dividing_by_zero() {
        let mut r = Ring::with_capacity(0);
        r.push(b"xyz");
        assert_eq!(r.snapshot(), b"z");
    }

    #[test]
    fn escape_sequences_are_replayed_byte_for_byte() {
        // Not lines, not parsed: a reopened window has to get the same bytes xterm.js saw the first time.
        let mut r = Ring::with_capacity(32);
        let painted = b"\x1b[2J\x1b[H\x1b[32mok\x1b[0m\r\n\x1b[?25l";
        r.push(painted);
        assert_eq!(r.snapshot(), painted);
    }
}
