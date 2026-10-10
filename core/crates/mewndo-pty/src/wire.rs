// G2: moving bytes (spec §33.10 Part G step 2).
//
//   output  ->  binary frames: type 1, lane id, data          `frames`
//   reply   ->  the text, then `\r`                           `reply_bytes`
//   brake   ->  `\x03`                                        `BRAKE`
//   resize  ->  xterm's rows and cols, checked                `Resize`
//
// All four are pure functions over bytes, so the thing the §33.10 contract is actually about - what lands in
// the agent's standard input - is covered by `cargo test` in WSL and does not need a terminal (§32.5 rule 5).
//
// Why `\r` and not `\n`: the Enter key sends a carriage return. A terminal's line discipline turns that into
// the newline the program reads. Writing `\n` instead works by luck in some programs and is swallowed by
// others; writing `\r` is what the keyboard does.

use mewndo_proto::{Frame, HEADER, MAX_FRAME};

/// Ctrl+C. The brake (§24): one byte into the lane's input, which the terminal turns into SIGINT, or on
/// Windows into a console control event. The agent stops what it is doing and keeps its session.
pub const BRAKE: u8 = 0x03;

/// Carriage return: what Enter sends.
pub const ENTER: u8 = b'\r';

/// How many bytes of lane data fit in one frame, given the lane id in front of them.
///
/// A `Frame::Lane` payload is 1 byte of id length, the id, then the data (mewndo-proto), and the whole payload
/// has to stay under `MAX_FRAME`. A reader thread with a 64 KB buffer never comes close, but `frames` is also
/// what replays a 256 KB ring buffer into a reopened window, which does.
pub fn max_data(lane_id: &str) -> usize {
    MAX_FRAME.saturating_sub(1 + lane_id.len())
}

/// Output bytes as lane frames, split if they do not fit in one.
///
/// Empty input gives no frames: an empty frame would be a wake-up with nothing in it.
pub fn frames(lane_id: &str, data: &[u8]) -> Vec<Frame> {
    let chunk = max_data(lane_id).max(1);
    data.chunks(chunk)
        .map(|part| Frame::Lane {
            lane: lane_id.to_string(),
            data: part.to_vec(),
        })
        .collect()
}

/// The same, already encoded, which is what a reader thread wants: one `Vec<u8>` per write to the pipe.
///
/// A lane id over 255 bytes cannot be framed at all (mewndo-proto's 1-byte length), so it yields nothing
/// rather than a half-written frame. Lane ids are ULIDs - 26 characters - so this is a guard, not a case.
pub fn encoded(lane_id: &str, data: &[u8]) -> Vec<Vec<u8>> {
    frames(lane_id, data)
        .iter()
        .filter_map(|f| mewndo_proto::encode(f).ok())
        .collect()
}

/// What a reply types into the lane: the text, then Enter.
///
/// Interior newlines become `\r` too. A reply pasted from a phone keyboard arrives with `\n` or `\r\n` in it,
/// and a terminal reading `\n` mid-line does not submit that line - the agent would see one run-on prompt
/// with stray control bytes in it. One trailing newline is dropped rather than sent twice, so
/// `reply_bytes("ok\n")` and `reply_bytes("ok")` put the same thing in the lane.
pub fn reply_bytes(text: &str) -> Vec<u8> {
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .or_else(|| text.strip_suffix('\r'))
        .unwrap_or(text);
    let mut out = Vec::with_capacity(text.len() + 1);
    let mut bytes = text.as_bytes().iter().peekable();
    while let Some(&b) = bytes.next() {
        match b {
            b'\r' => {
                out.push(ENTER);
                if bytes.peek() == Some(&&b'\n') {
                    bytes.next(); // CRLF is one line ending, not two
                }
            }
            b'\n' => out.push(ENTER),
            other => out.push(other),
        }
    }
    out.push(ENTER);
    out
}

/// The brake, as the bytes it writes. A function, not a constant, so the call site reads like the other two.
pub fn brake_bytes() -> Vec<u8> {
    vec![BRAKE]
}

/// A terminal size from an xterm.js `resize` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resize {
    pub rows: u16,
    pub cols: u16,
}

/// §33.10 Part G step 1: the size a lane opens at.
pub const DEFAULT_ROWS: u16 = 30;
pub const DEFAULT_COLS: u16 = 120;

impl Default for Resize {
    fn default() -> Resize {
        Resize {
            rows: DEFAULT_ROWS,
            cols: DEFAULT_COLS,
        }
    }
}

impl Resize {
    /// A size the operating system will accept.
    ///
    /// xterm.js reports the size of its container, and a container can be 0 rows tall for a frame while a
    /// lane window is opening or minimised. A 0 reaches ConPTY as an invalid argument and reaches a Unix pty
    /// as "size unknown", which makes `stty` and every full-screen agent UI misdraw. So a 0 becomes a 1, and
    /// an absurd size is capped rather than refused - the window is not wrong to be large.
    pub fn clamped(self) -> Resize {
        Resize {
            rows: self.rows.clamp(1, 1000),
            cols: self.cols.clamp(1, 1000),
        }
    }
}

/// How big a frame is on the wire, for a test or a budget.
pub fn frame_len(lane_id: &str, data_len: usize) -> usize {
    HEADER + 1 + lane_id.len() + data_len
}

#[cfg(test)]
mod tests {
    use super::*;

    // The §33.10 Part G step 2 test: reply and brake byte encoding.
    #[test]
    fn a_reply_is_the_text_then_a_carriage_return() {
        assert_eq!(reply_bytes("yes, carry on"), b"yes, carry on\r");
        assert_eq!(reply_bytes(""), b"\r", "an empty reply is a bare Enter");
    }

    #[test]
    fn a_reply_never_sends_two_enters_for_one_trailing_newline() {
        for text in ["ok\n", "ok\r\n", "ok\r"] {
            assert_eq!(reply_bytes(text), b"ok\r", "{text:?}");
        }
    }

    #[test]
    fn interior_newlines_become_carriage_returns_so_every_line_is_submitted() {
        assert_eq!(reply_bytes("one\ntwo"), b"one\rtwo\r");
        assert_eq!(reply_bytes("one\r\ntwo\r\n"), b"one\rtwo\r");
        assert_eq!(
            reply_bytes("one\n\ntwo"),
            b"one\r\rtwo\r",
            "a blank line stays a blank line"
        );
        assert!(
            !reply_bytes("one\r\ntwo").contains(&b'\n'),
            "no raw \\n reaches the agent's input"
        );
    }

    #[test]
    fn the_brake_is_one_ctrl_c_byte() {
        assert_eq!(brake_bytes(), vec![0x03]);
        assert_eq!(BRAKE, 3);
    }

    #[test]
    fn output_becomes_type_1_frames_carrying_the_lane_id() {
        let f = frames("01JLANE", b"\x1b[32mok\x1b[0m\r\n");
        assert_eq!(f.len(), 1);
        assert_eq!(
            f[0],
            Frame::Lane {
                lane: "01JLANE".into(),
                data: b"\x1b[32mok\x1b[0m\r\n".to_vec(),
            }
        );
        let bytes = mewndo_proto::encode(&f[0]).unwrap();
        assert_eq!(bytes[0], 1, "frame type 1");
        assert_eq!(bytes[HEADER], 7, "then the lane id length");
        assert_eq!(&bytes[HEADER + 1..HEADER + 8], b"01JLANE");
        assert_eq!(bytes.len(), frame_len("01JLANE", 13));
    }

    #[test]
    fn nothing_out_means_no_frame() {
        assert!(frames("01JLANE", b"").is_empty());
        assert!(encoded("01JLANE", b"").is_empty());
    }

    #[test]
    fn output_too_big_for_one_frame_is_split_and_loses_nothing() {
        let lane = "01JLANE";
        let data: Vec<u8> = (0..(MAX_FRAME + 5000)).map(|i| (i % 251) as u8).collect();
        let f = frames(lane, &data);
        assert_eq!(f.len(), 2);
        let mut back = Vec::new();
        for frame in &f {
            let Frame::Lane { lane: id, data } = frame else {
                panic!("not a lane frame")
            };
            assert_eq!(id, lane);
            assert!(
                mewndo_proto::encode(frame).is_ok(),
                "every piece fits mewndo-proto's 8 MB limit"
            );
            back.extend_from_slice(data);
        }
        assert_eq!(back, data, "split, then joined, is the original stream");
        assert_eq!(encoded(lane, &data).len(), 2);
    }

    #[test]
    fn a_lane_id_too_long_to_frame_yields_nothing_rather_than_half_a_frame() {
        let huge = "x".repeat(300);
        assert!(encoded(&huge, b"hello").is_empty());
    }

    // The §33.10 Part G step 2 resize test, pure half: what reaches `master.resize`.
    #[test]
    fn a_lane_opens_at_30_by_120_and_a_resize_is_clamped_to_something_the_os_accepts() {
        assert_eq!(
            Resize::default(),
            Resize {
                rows: 30,
                cols: 120
            }
        );
        assert_eq!(
            Resize { rows: 0, cols: 0 }.clamped(),
            Resize { rows: 1, cols: 1 },
            "a minimised window must not send a 0 to the pty"
        );
        assert_eq!(
            Resize {
                rows: 9999,
                cols: 9999
            }
            .clamped(),
            Resize {
                rows: 1000,
                cols: 1000
            }
        );
        let normal = Resize {
            rows: 44,
            cols: 164,
        };
        assert_eq!(
            normal.clamped(),
            normal,
            "an ordinary size is passed through"
        );
    }
}
