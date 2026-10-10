// R4: the action signature (spec §34.9 R4). `blake3(agent_kind | kind | command_norm | sorted paths)`,
// truncated to 16 bytes.
//
// Why a signature at all: three different things need to say "this is the same action as that one" -- the
// 5-minute cache (§34.8), the loop brake ("the same command failed twice", §34.4 row 4) and habits ("3
// identical answers", §34.7). All three must agree, or a habit learned on one key would never be found under
// another. One function, one definition.
//
// Why sorted: `rm a b` and `rm b a` are the same action. Why truncated to 16: it is a lookup key, not a
// security claim. 128 bits is far past collision range for the few thousand actions a session produces, and
// it fits in a u128 column and a cache key without a heap allocation.
// Why blake3 and not the workspace's sha2: §34.9 R4 names it, and it is the faster of the two on short input.

/// 16 bytes: the first half of a blake3 hash.
pub type Sig = [u8; 16];

fn first16(h: blake3::Hash) -> Sig {
    let mut out = [0u8; 16];
    out.copy_from_slice(&h.as_bytes()[..16]);
    out
}

/// The §34.9 R4 signature. A zero byte separates the fields so that `kind = "a"`, `command = "bc"` cannot
/// hash the same as `kind = "ab"`, `command = "c"`.
pub fn action_sig(agent_kind: &str, kind: &str, command_norm: &str, paths: &[String]) -> Sig {
    let mut sorted: Vec<&str> = paths.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut h = blake3::Hasher::new();
    for field in [agent_kind, kind, command_norm] {
        h.update(field.as_bytes());
        h.update(b"\0");
    }
    for p in sorted {
        h.update(p.as_bytes());
        h.update(b"\0");
    }
    first16(h.finalize())
}

/// A hash of any text: the brief, a command output. Used for the brief half of the cache key and for the
/// "same output hash" test in §34.4 row 4.
pub fn text_hash(text: &str) -> Sig {
    first16(blake3::hash(text.as_bytes()))
}

/// §34.8's cache key: `blake3(brief_hash | action_sig)`. The brief is in the key because the same command
/// under a different brief is a different question -- `rm -rf db` is fine when the brief says to rebuild the
/// database and is the §34.3 example of a deny when it does not.
pub fn cache_key(brief_hash: &Sig, action: &Sig) -> Sig {
    let mut h = blake3::Hasher::new();
    h.update(brief_hash);
    h.update(action);
    first16(h.finalize())
}

/// For logs and the `x-mewndo-sig` header (§34.9 R6).
pub fn hex(sig: &Sig) -> String {
    let mut s = String::with_capacity(32);
    for b in sig {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap_or('0'));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_action_hashes_the_same_whatever_the_path_order() {
        let a = action_sig(
            "claude-code",
            "delete",
            "rm a b",
            &["/x/a".into(), "/x/b".into()],
        );
        let b = action_sig(
            "claude-code",
            "delete",
            "rm a b",
            &["/x/b".into(), "/x/a".into()],
        );
        assert_eq!(a, b);
        assert_ne!(
            a,
            action_sig(
                "cursor",
                "delete",
                "rm a b",
                &["/x/a".into(), "/x/b".into()]
            ),
            "a different agent is a different habit"
        );
        assert_eq!(hex(&a).len(), 32);
    }

    #[test]
    fn fields_cannot_run_into_each_other() {
        assert_ne!(
            action_sig("a", "b", "c", &[]),
            action_sig("ab", "", "c", &[]),
            "the zero separator keeps the fields apart"
        );
    }
}
