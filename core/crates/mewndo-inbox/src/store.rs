// Persisting every state change (spec §33.10 Part D step 4) into the §38.6 `cards` table.
//
// The real writer is mewndo-core's batched SQLite task (core/crates/mewndo-core/src/writer.rs): one thread
// owns every write, callers queue a statement without waiting, and whatever arrived in each 10 ms window is
// committed as one transaction. The Inbox must not wait on disk -- a hook is blocked on the other end of the
// card -- so queueing and forgetting is exactly the right shape, and [`CardWriter`] below is that shape and
// nothing more: `write(&self, &'static str, Vec<Value>)`, the same signature `Writer::write` already has, so
// the core's implementation is one line.
//
// Why a trait at all, when the writer already exists: mewndo-core depends on mewndo-inbox (core/Cargo.toml),
// so the dependency cannot run the other way. And real SQLite is a C build that the windows-gnu dev box has no
// compiler for (core/Cargo.toml's note on rusqlite), so a crate that reached for `rusqlite` to test its own
// state machine would not build there at all. With a trait, these tests assert the exact statements the Inbox
// issues -- which is a stricter check than reading rows back, because it catches a missing write as well as a
// wrong one.
//
// Nothing here reads. §33.10 Part D step 4's start-up sweep needs no query: see [`EXPIRE_STALE`].

use crate::card::{Answer, Card};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

/// The insert that happens when a card is created. The column list is §38.6's, in its order; the columns a
/// new card has nothing to say about (`answer_json`, `via`, `answered_at`, `released_at`, `savepoint_id`) are
/// left NULL rather than written as empty strings, so "never answered" and "answered with nothing" stay
/// different in the database.
pub const INSERT: &str = "INSERT INTO cards \
    (id, agent_id, trace_id, kind, title, body, options_json, risk, state, created_at) \
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)";

/// open -> answering (§33.9). The answer is stored *before* the grace ends, so a crash during the grace
/// leaves a row that says what the user chose and that it was never released -- the truthful record, and the
/// one the start-up sweep then expires.
pub const ANSWERED: &str =
    "UPDATE cards SET state = ?2, answer_json = ?3, via = ?4, answered_at = ?5 WHERE id = ?1";

/// answering -> open: Esc during the grace (§33.9).
///
/// The answer is cleared, not kept. A row that still held the answer the user took back is the database
/// version of the one mistake this crate exists to prevent: anything reading `answer_json` later -- the Agents
/// tab's agreement rate, a habit count, a support dump -- would be reading a decision the user reversed.
pub const REOPENED: &str = "UPDATE cards SET state = ?2, answer_json = NULL, via = NULL, \
     answered_at = NULL WHERE id = ?1";

/// answering -> released (§33.9), with the save point the Undo key will restore to (§33.4).
pub const RELEASED: &str =
    "UPDATE cards SET state = ?2, released_at = ?3, savepoint_id = ?4 WHERE id = ?1";

/// The save point arrived after the answer was released (§33.10 Part D step 3). State and `released_at` are
/// already right and are left alone; only the id is filled in.
pub const SAVEPOINT_LATE: &str = "UPDATE cards SET savepoint_id = ?2 WHERE id = ?1";

/// open -> expired, and released -> undone: the two transitions that change nothing but the state.
pub const STATE: &str = "UPDATE cards SET state = ?2 WHERE id = ?1";

/// §33.10 Part D step 4: "At start-up, mark old Open cards as Expired, because their hooks are gone."
///
/// One statement, no read. At start-up the Inbox holds no cards by definition, so *every* row left in `open`
/// or `answering` is from a process that is no longer running: the hook that was waiting died with it, and the
/// agent has long since fallen back to its own prompt (§33.9). `answering` is included for the same reason --
/// a grace that was draining when the core stopped never released, and "expired" is the honest word for it.
/// Running this unconditionally also means a crash loop cannot leave a card that looks answerable for ever.
pub const EXPIRE_STALE: &str =
    "UPDATE cards SET state = 'expired' WHERE state IN ('open', 'answering')";

/// One queued statement: the SQL and its `?n` parameters.
pub type Row = (&'static str, Vec<Value>);

/// mewndo-core's `Writer::write`, as the Inbox sees it.
pub trait CardWriter: Send + Sync + 'static {
    /// Queue one statement. Must not block: it is called from the actor loop, which has a hook waiting on it.
    /// A failed statement is the writer's business to log; the Inbox cannot do anything useful about it and
    /// must not hold an answer back over it (§32.5 rule 7).
    fn write(&self, sql: &'static str, params: Vec<Value>);
}

/// Nothing is persisted. The honest default, and what the windows-gnu build of mewndo-core already gives the
/// rest of the core (writer.rs's sink). Everything works except remembering across a restart -- and §33.10
/// Part D step 4 expires every card at start-up anyway, so no live behaviour depends on the memory.
pub struct NoStore;

impl CardWriter for NoStore {
    fn write(&self, _sql: &'static str, _params: Vec<Value>) {}
}

/// Keeps every statement, for tests and the fake agent harness. Cloning shares one log, so a test can hand a
/// clone to the Inbox and still read what was written.
#[derive(Clone, Default)]
pub struct Recording(Arc<Mutex<Vec<Row>>>);

impl Recording {
    pub fn rows(&self) -> Vec<Row> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The statements in order, which is the state machine's own history: insert, answered, reopened,
    /// answered, released.
    pub fn statements(&self) -> Vec<&'static str> {
        self.rows().into_iter().map(|(sql, _)| sql).collect()
    }

    /// Every value written into a `state` column, in order. `state` is parameter `?2` of every update and
    /// `?9` of the insert, which is why this knows where to look.
    pub fn states(&self) -> Vec<String> {
        self.rows()
            .into_iter()
            .filter_map(|(sql, params)| {
                let at = if sql == INSERT { 8 } else { 1 };
                match (sql, params.get(at)) {
                    (SAVEPOINT_LATE, _) => None,
                    (_, Some(Value::String(s))) => Some(s.clone()),
                    _ => None,
                }
            })
            .collect()
    }

    /// The parameters of the last statement that was this SQL.
    pub fn last(&self, sql: &'static str) -> Option<Vec<Value>> {
        self.rows()
            .into_iter()
            .rev()
            .find(|(s, _)| *s == sql)
            .map(|(_, p)| p)
    }
}

impl CardWriter for Recording {
    fn write(&self, sql: &'static str, params: Vec<Value>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((sql, params));
    }
}

/// [`INSERT`]'s parameters. `options_json` holds the labels *and* the "Recommended" flag, which §38.5's
/// `inbox.card` cannot carry yet (see `Opt`): the database is ours to shape, the protocol is not.
pub fn insert(card: &Card) -> Vec<Value> {
    vec![
        json!(card.id.to_string()),
        json!(card.agent_id),
        json!(card.trace_id),
        json!(card.kind.as_str()),
        json!(card.title),
        json!(card.body),
        // A list that will not serialize is stored as `[]` rather than dropping the whole row: the card's
        // title and state matter more than its options, and `Opt` has no field that can fail anyway.
        json!(serde_json::to_string(&card.options).unwrap_or_else(|_| "[]".into())),
        json!(card.risk),
        json!(card.state.as_str()),
        json!(card.created_at),
    ]
}

/// [`ANSWERED`]'s parameters.
///
/// Every builder here writes `card.state`, never a state of its own, and the actor sets the field before it
/// calls them. So the row cannot say something the card in memory does not: one place to be wrong instead of
/// two, and a test that reads the state column is really reading the state machine.
pub fn answered(card: &Card, answer: &Answer, at: i64) -> Vec<Value> {
    vec![
        json!(card.id.to_string()),
        json!(card.state.as_str()),
        json!(serde_json::to_string(answer).unwrap_or_else(|_| "null".into())),
        json!(serde_json::to_value(answer.via).unwrap_or(Value::Null)),
        json!(at),
    ]
}

/// [`REOPENED`]'s parameters.
pub fn reopened(card: &Card) -> Vec<Value> {
    vec![json!(card.id.to_string()), json!(card.state.as_str())]
}

/// [`RELEASED`]'s parameters. `savepoint_id` is NULL when the engine was slower than the budget or not there
/// at all; [`SAVEPOINT_LATE`] fills it in if it arrives.
pub fn released(card: &Card, at: i64, savepoint: Option<&String>) -> Vec<Value> {
    vec![
        json!(card.id.to_string()),
        json!(card.state.as_str()),
        json!(at),
        json!(savepoint),
    ]
}

/// [`SAVEPOINT_LATE`]'s parameters.
pub fn savepoint_late(card: &Card, savepoint: &str) -> Vec<Value> {
    vec![json!(card.id.to_string()), json!(savepoint)]
}

/// [`STATE`]'s parameters.
pub fn state(card: &Card) -> Vec<Value> {
    vec![json!(card.id.to_string()), json!(card.state.as_str())]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::card::{CardKind, CardState, Opt, choice};
    use mewndo_proto::Via;

    #[test]
    fn the_insert_writes_the_38_6_columns_in_order() {
        let mut card = Card::new(CardKind::Permission, "agent-1", "Run npm test?", "shop");
        card.options = vec![Opt::new("Allow once").recommended(), Opt::new("Deny")];
        card.risk = 2;
        card.created_at = 1_700_000_000_000;
        let params = insert(&card);
        assert_eq!(params.len(), 10, "ten columns, ten ?n parameters");
        assert_eq!(params[0], json!(card.id.to_string()));
        assert_eq!(
            params[2],
            Value::Null,
            "no trace is NULL, not an empty string"
        );
        assert_eq!(params[3], json!("permission"));
        assert_eq!(params[7], json!(2));
        assert_eq!(params[8], json!("open"));
        assert_eq!(params[9], json!(1_700_000_000_000i64));
        let options: Vec<Opt> = serde_json::from_str(params[6].as_str().unwrap()).unwrap();
        assert!(
            options[0].recommended,
            "the Recommended flag survives in the database"
        );
    }

    #[test]
    fn an_answer_is_stored_whole_so_nothing_has_to_guess_what_the_user_pressed() {
        let mut card = Card::new(CardKind::Question, "a", "t", "b");
        card.state = CardState::Answering {
            until: tokio::time::Instant::now(),
        };
        let answer = choice(card.id, 1, Via::Voice);
        let params = answered(&card, &answer, 42);
        assert_eq!(params[1], json!("answering"));
        assert_eq!(params[3], json!("voice"), "§38.6's via column");
        assert_eq!(params[4], json!(42));
        let back: Answer = serde_json::from_str(params[2].as_str().unwrap()).unwrap();
        assert_eq!(back, answer);
    }

    #[test]
    fn the_start_up_sweep_needs_no_read_and_catches_a_draining_grace_too() {
        assert!(EXPIRE_STALE.contains("'open'") && EXPIRE_STALE.contains("'answering'"));
        assert!(
            !EXPIRE_STALE.contains("released") && !EXPIRE_STALE.contains("undone"),
            "a released card keeps its save point: Undo must still work after a restart"
        );
    }
}
