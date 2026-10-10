//! The desktop's WebSocket link to the cloud hub: cloud-agent cards into the local Inbox, answers back
//! (spec §37.6 K8).
//!
//! Cloud agents -- ChatGPT dots, Grok Bot, Meta Muse, claude.ai -- have no hooks, so they ask the user by
//! calling the hosted MCP's `ask_user` (§37.6 K6). That raises a card in the tester's `HubDO` (K7), which
//! pushes it down this socket. The card appears on the bar next to the local ones, the user answers it there,
//! and the answer goes back up. Nothing else does.
//!
//! **What goes up, exactly.** P5.4: "File contents and names never leave the PC." The outbound half of this
//! module can carry exactly one message type -- [`Answered`], an answer to a card -- and the channel the
//! socket drains is typed `mpsc::Receiver<Answered>`, so there is no `skills.share`, no file list and no
//! telemetry it could send even by mistake. That is a property of the types, not of a careful author;
//! `nothing_but_a_card_answer_can_be_sent` asserts it at runtime as well.
//!
//! `hub.js` also accepts `{"type":"skills.share","slug":…,"text":…}` from the desktop, which uploads redacted
//! `SKILL.md` text (§36.5 step 6). This module deliberately does not send it: that is file content leaving the
//! PC, and P5.4 does not allow it. Whoever builds Show Me sharing needs the user's explicit per-workflow
//! consent and a second, separate sender -- not this one.
//!
//! **The shape of the file** follows §32.5 rule 5: the card mapping, the backoff schedule and the message
//! encoding are plain code with no socket in sight, compiled and tested on every target. Only [`socket`] --
//! the thing that opens a TLS WebSocket -- is behind `#[cfg(windows)]`, because `native-tls` is SChannel on
//! Windows and OpenSSL everywhere else and the dev box has no OpenSSL headers (see `core/Cargo.toml`).
//!
//! **Fail open** (§32.5 rule 7): an unreachable cloud breaks nothing local. Every failure here -- no token, a
//! refused upgrade, a dropped socket, a message in a shape we have never seen -- ends in a retry or in the
//! message being dropped. Nothing panics, nothing blocks the Inbox, and no local card depends on the link
//! being up.
//!
//! **Honest limits.**
//!
//!   - Never run against a deployed Worker. `cloud/gateway/README.md` says the same of the other side: the
//!     hub's WebSocket is driven by tests, not by a real socket. The contract below is read off
//!     `cloud/gateway/src/hub.js` and `src/index.js` line by line, not guessed, but "matches the code" is not
//!     "has talked to it".
//!   - The link is not wired into `main.rs` yet (that file belongs to another part of this sprint), so nothing
//!     calls [`run`] in a shipped build. That is why the module allows dead code, in the same way as
//!     `store.rs`.
//!   - A typed answer is the user's own words, sent as the user wrote them. The link does not read it and does
//!     not redact it: if the user types a path into the answer box, that path goes up. Truncated at
//!     [`MAX_TEXT`], which is what `hub.js` stores.
//!   - No clock skew handling. A card's local order comes from the `created_at` the hub recorded, so a Worker
//!     whose clock is ahead puts its cards above local ones.
//!   - The socket half uses the blocking `tungstenite` client on one dedicated thread, not `connect_async`.
//!     An async loop needs `futures_util::{SinkExt, StreamExt}` to drive `WebSocketStream`, and `futures-util`
//!     is not a dependency of this crate; adding one means editing `mewndo-core/Cargo.toml`, which this file
//!     may not do. One thread for one socket costs a thread and up to [`socket::TICK`] of latency on an
//!     outgoing answer.

// Nothing calls this module yet: `main.rs` declares `mod cloud_link;` but the wiring (reading the invite
// token, starting the task, handing it the Desk) is in main.rs, which belongs to another agent this sprint.
// Same reason and same remedy as `store.rs`: the code is finished and tested, and the allow goes away with the
// first caller.
#![allow(dead_code)]

use mewndo_inbox::{Answer, Card, CardKind, Inbox, Opt};
use mewndo_proto::{AgentStatus, Via};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use tokio::sync::mpsc;
use ulid::Ulid;

// --- the contract with cloud/gateway -------------------------------------------------------------------------------
//
// Read off the cloud, which is built and tested. Every constant here has a line number on the other side, so a
// change there is findable from here.
//
// Down the socket, from `HubDO` (cloud/gateway/src/index.js) and `Hub` (src/hub.js):
//
//   {"type":"hub.open","cards":[…]}                  on connect: every card raised while we were away
//   {"type":"inbox.card","source":"cloud","agent":…,"card":{…}}
//   {"type":"agent.status","source":"cloud","agent":…,"status":"working","last_line":…,"at":…}
//   {"type":"inbox.release","card_id":…}             the hub wrote our answer down
//   {"type":"skills.ok","slug":…}  {"type":"error","message":…}
//
// A card, as `Hub.createCard` builds it:
//
//   {id, source:"cloud", agent, kind:"question"|"permission"|"done", title, body|null,
//    options:[string], risk, state:"open"|"answered", created_at, answer|null}
//
// Up the socket, and this is the whole list:
//
//   {"type":"inbox.answer","card_id":…,"choice":<index>|"text":<string>,"via":…}
//
// `Hub.answer` (hub.js:80-91) is the half that matters most, because getting it wrong means answers silently
// never arrive. What it actually does:
//
//   const picked = Number.isInteger(choice) && card.options[choice] != null ? card.options[choice] : null
//
//   * `choice` is an INDEX into the card's own `options`, zero-based, and it must be a JSON integer. A string
//     index, a float, or an index the card does not have all give `picked = null` -- the card still moves to
//     `answered`, so the agent is told the user answered and is handed nothing. That is the silent failure.
//     `Answered::to` refuses to build a message in that state (see `answer_out_of_range_is_not_sent`).
//   * `text` is stored as given, truncated to 2000 characters.
//   * `via` is stored as given and defaults to "key".
//   * A card not in `open` is returned unchanged: a second answer is ignored, not an error.
//   * The answer is written to storage BEFORE the waiting `ask_user` is woken, so one answer is enough even if
//     the Durable Object is evicted; the agent reads it later with `get_answer`.

/// `hub.js`'s `MAX_OPTIONS`: the Inbox answers with the number keys 1-9 (§33.2), so a card can hold nine
/// options and no more. A longer list from the cloud is truncated rather than refused -- a card the user can
/// mostly answer beats no card.
pub const MAX_OPTIONS: usize = 9;

/// `hub.js` truncates `text` to 2000 characters. Truncating here too means what we send is exactly what the
/// hub stores, so the user is never shown an answer that silently lost its tail.
pub const MAX_TEXT: usize = 2000;

/// `hub.js`'s `CARD_KEEP_MS`: the hub forgets a card after 24 hours, after which no answer could ever reach
/// the agent. That is the honest deadline for the local card as well (§33.9 "nobody is blocked forever").
///
/// It is deliberately not §33.9's 300 s. A cloud agent that got no answer within `ASK_WAIT_MS` (110 s) is told
/// "no answer yet" and polls `get_answer`, so an answer given ten minutes later still arrives. Expiring the
/// local card at 300 s would throw away an answer the cloud is still waiting for.
pub const CARD_KEEP: Duration = Duration::from_secs(24 * 3600);

// --- configuration -------------------------------------------------------------------------------------------------

/// Where to connect and what to prove it with.
///
/// The token is held in memory for as long as the link runs and nowhere else: this module never writes it to
/// disk, never puts it in a log line and never puts it in an error message (CLAUDE.md rule 4). Reading it --
/// from Windows Credential Manager, or from the Connect page -- is the core's job, not this file's.
#[derive(Clone)]
pub struct Config {
    /// The Worker's base URL, e.g. `https://mewndo-cloud.someone.workers.dev`. `http`/`https` are rewritten to
    /// `ws`/`wss`; `/hub` is appended.
    pub base: String,
    /// The tester's invite token (§37.5).
    pub token: String,
    /// `GET /hub` takes the token from `Authorization: Bearer …` or from `?token=` (index.js:76). The header is
    /// the default because a URL ends up in logs and crash reports; the query string is there for the case
    /// where a header is impossible.
    pub token_in_query: bool,
}

impl Config {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Config {
        Config {
            base: base.into(),
            token: token.into(),
            token_in_query: false,
        }
    }

    /// The `wss://…/hub` URL to connect to, or why it could not be built.
    ///
    /// With `token_in_query` the result contains the token, so it must never be logged. [`Config::safe_url`]
    /// is the one for log lines.
    pub fn url(&self) -> Result<String, String> {
        if self.token.trim().is_empty() {
            return Err("no invite token: the cloud link stays off".into());
        }
        let mut url = self.ws_base()?;
        url.push_str("/hub");
        if self.token_in_query {
            // The token is not percent-encoded, because `/invite/redeem` mints a base64url token and every
            // character of that alphabet is already URL-safe. A token with anything else in it is not ours.
            url.push_str("?token=");
            url.push_str(&self.token);
        }
        Ok(url)
    }

    /// The same URL with the token taken out. Everything this module logs uses this one.
    pub fn safe_url(&self) -> String {
        match self.ws_base() {
            Ok(base) => format!("{base}/hub"),
            Err(_) => "<no usable worker url>".into(),
        }
    }

    fn ws_base(&self) -> Result<String, String> {
        let base = self.base.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("no worker url: the cloud link stays off".into());
        }
        let (scheme, rest) = base
            .split_once("://")
            .ok_or_else(|| format!("a worker url needs a scheme, got {base:?}"))?;
        if rest.is_empty() {
            return Err(format!("a worker url needs a host, got {base:?}"));
        }
        let ws = match scheme.to_ascii_lowercase().as_str() {
            "https" | "wss" => "wss",
            // Only useful for `wrangler dev` on localhost. The hub refuses a token over plain HTTP in
            // production because Cloudflare terminates TLS before the Worker ever sees the request.
            "http" | "ws" => "ws",
            other => return Err(format!("a worker url cannot use {other}://")),
        };
        Ok(format!("{ws}://{rest}"))
    }
}

// --- the backoff ---------------------------------------------------------------------------------------------------

/// §37.6 K8: "Connects with backoff from 1 s to 30 s."
///
/// Doubling, capped: 1, 2, 4, 8, 16, 30, 30, … A connection that worked resets it, so one bad night does not
/// leave a working link waiting 30 s after the next blip.
///
/// Pure on purpose. This is the one piece of a reconnect loop that is easy to get wrong and impossible to
/// observe from the outside, so it is a value with a test rather than two lines inside the socket thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backoff {
    next: Duration,
}

impl Backoff {
    pub const FIRST: Duration = Duration::from_secs(1);
    pub const CAP: Duration = Duration::from_secs(30);

    pub fn new() -> Backoff {
        Backoff {
            next: Backoff::FIRST,
        }
    }

    /// How long to wait before the next attempt, and then move the schedule on.
    pub fn take(&mut self) -> Duration {
        let now = self.next;
        self.next = (now * 2).min(Backoff::CAP);
        now
    }

    /// A connection succeeded: the next failure starts again at 1 s.
    pub fn reset(&mut self) {
        self.next = Backoff::FIRST;
    }

    /// What `take` would return, without moving the schedule on.
    pub fn peek(&self) -> Duration {
        self.next
    }
}

impl Default for Backoff {
    fn default() -> Backoff {
        Backoff::new()
    }
}

// --- which cloud agent is this? ------------------------------------------------------------------------------------

/// §37.6 K8: the agent kind comes "from the MCP client's name".
///
/// `cloud/gateway/src/index.js:68` takes it from `rpc.params.clientInfo.name`, falling back to
/// `x-mewndo-agent` and then to the string `"cloud agent"`, and hands it to the hub as `agent`. So what
/// arrives here is whatever the agent app calls itself -- "ChatGPT", "grok-bot", "Meta Muse", "claude-ai" --
/// with no agreed spelling. Matching is on a lowercased substring for that reason.
///
/// An unrecognised name is [`UNKNOWN_KIND`], never a guess at one of the four. A wrong bubble on the bar is a
/// lie about which agent is about to do something, which is the one thing the bar is for.
pub fn agent_kind(client_name: &str) -> &'static str {
    let name = client_name.to_ascii_lowercase();
    let has = |needle: &str| name.contains(needle);
    // claude first: "claude-ai" also contains nothing else, but keeping the four in one visible order makes
    // the precedence a decision rather than an accident.
    if has("claude") {
        "claude-ai"
    } else if has("dots") || has("chatgpt") || has("openai") {
        "dots"
    } else if has("grok") {
        "grok-bot"
    } else if has("muse") || has("meta") {
        "muse"
    } else {
        UNKNOWN_KIND
    }
}

/// The kind for a cloud agent we cannot name. Not one of §37.6 K8's four: those four are claims about who is
/// acting, and this one says plainly that we do not know.
pub const UNKNOWN_KIND: &str = "cloud";

/// The agent id every card and status from one cloud agent shares, so the dock draws one bubble per agent
/// rather than one per card. There is no session id to use: a cloud agent has no process on this PC.
fn agent_id(kind: &str) -> String {
    format!("cloud:{kind}")
}

/// §33.2's five card kinds, from the three `hub.js` can produce. An unknown kind becomes a Question: a cloud
/// card is `ask_user` at bottom, and a question is the one kind that only asks and teaches the habit counter
/// nothing.
fn card_kind(kind: &str) -> CardKind {
    match kind {
        "permission" => CardKind::Permission,
        "done" => CardKind::Done,
        "drift" => CardKind::Drift,
        "receipt" => CardKind::Receipt,
        _ => CardKind::Question,
    }
}

// --- reading what the hub sent -------------------------------------------------------------------------------------

/// One message from the hub, after parsing. Everything we do not understand is [`Hub::Ignored`] rather than an
/// error: the cloud may learn a new message type before the desktop does, and a desktop that disconnects over
/// one is worse than a desktop that shrugs.
#[derive(Debug, Clone, PartialEq)]
pub enum Hub {
    /// `hub.open`: every card raised while the desktop was away.
    Open(Vec<CloudCard>),
    /// `inbox.card`: one new card.
    Card(CloudCard),
    /// `agent.status`: the dock shows the agent working, with its last line.
    Status {
        agent: String,
        status: String,
        last_line: Option<String>,
    },
    /// `inbox.release`: the hub has our answer written down. The local card was released two seconds before
    /// this arrived; the only thing left to do is forget the card.
    Release { card_id: String },
    /// A message with a type we have no use for: `skills.ok` (we never send `skills.share`), `error`, or
    /// anything added to the hub later.
    Ignored,
}

/// A card as the hub stores it (`hub.js`'s `createCard`).
///
/// Read field by field out of a `serde_json::Value` rather than with a `Deserialize` derive, because this is a
/// wire we do not own: a derive refuses the whole message when one field changes type, and refusing a card is
/// how a user never hears that an agent is waiting. A missing `options` means no options; a `risk` of `"2"`
/// means the default risk; only `id` and `title` are required, because a card without them cannot be answered
/// or shown.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudCard {
    pub id: String,
    pub agent: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub options: Vec<String>,
    pub risk: u8,
    /// Milliseconds since the epoch, as the hub recorded it.
    pub created_at: i64,
}

impl CloudCard {
    /// None when there is no usable card here.
    fn read(value: &Value, agent_hint: Option<&str>) -> Option<CloudCard> {
        let id = text_at(value, "id")?;
        let title = text_at(value, "title")?;
        let agent = text_at(value, "agent")
            .or_else(|| agent_hint.map(str::to_string))
            .unwrap_or_else(|| "cloud agent".into());
        let options = value
            .get("options")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .take(MAX_OPTIONS)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some(CloudCard {
            id,
            agent,
            kind: text_at(value, "kind").unwrap_or_else(|| "question".into()),
            title,
            body: text_at(value, "body").unwrap_or_default(),
            options,
            // §33.2's risk is 1-5. hub.js defaults to 2 and uses 1 for a Done card.
            risk: value
                .get("risk")
                .and_then(Value::as_u64)
                .unwrap_or(2)
                .clamp(1, 5) as u8,
            created_at: value
                .get("created_at")
                .and_then(Value::as_i64)
                .filter(|ms| *ms > 0)
                .unwrap_or_else(mewndo_inbox::card::now_ms),
        })
    }

    /// The local Inbox card for this cloud card (§37.6 K8: "Maps cloud cards into the local Inbox").
    ///
    /// The id is built from the hub's `created_at` rather than from the clock, so the Ulid's own timestamp and
    /// `Card::created_at` agree -- `card.rs` relies on that, and the stack's tie-break is the id. The random
    /// half of the Ulid still makes two cards from the same millisecond distinct.
    ///
    /// Options teach the habit counter nothing (`Opt::new`, not `Opt::teaching`). A habit is "always allow
    /// *this action* in *this project*" (§34.7) and a cloud agent's card carries neither: there is no action
    /// signature and no local project behind it.
    pub fn to_card(&self) -> Card {
        let kind = agent_kind(&self.agent);
        let mut card = Card::new(
            card_kind(&self.kind),
            agent_id(kind),
            &self.title,
            &self.body,
        );
        card.id = ulid_at(self.created_at);
        card.created_at = self.created_at;
        card.options = self.options.iter().map(Opt::new).collect();
        card.risk = self.risk;
        card.deadline = Some(CARD_KEEP);
        card
    }

    /// `agent.status` for the app, so the dock can show this agent at all. The hub pushes a status only while
    /// an agent reports progress; a card arriving is the other moment the app needs to know the agent exists.
    pub fn to_status(&self) -> AgentStatus {
        status_for(&self.agent, "working", None)
    }
}

/// Parse one text frame. `None` means "nothing usable here": not JSON, not an object, no `type`.
///
/// This is the whole of the malformed-message defence, and it is a `None` rather than a panic or a
/// disconnection on purpose. A cloud that sends rubbish must not be able to take the bar down.
pub fn parse(raw: &str) -> Option<Hub> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let kind = value.get("type")?.as_str()?;
    Some(match kind {
        "hub.open" => Hub::Open(
            value
                .get("cards")
                .and_then(Value::as_array)
                .map(|cards| {
                    cards
                        .iter()
                        .filter_map(|card| CloudCard::read(card, None))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        // The agent name is on the envelope as well as on the card (hub.js:58); the card's own wins, and the
        // envelope is the fallback for a card that somehow has none.
        "inbox.card" => match value
            .get("card")
            .and_then(|card| CloudCard::read(card, text_at(&value, "agent").as_deref()))
        {
            Some(card) => Hub::Card(card),
            // A push with no usable card in it. Nothing to show and nothing to answer: drop it.
            None => Hub::Ignored,
        },
        "agent.status" => Hub::Status {
            agent: text_at(&value, "agent").unwrap_or_else(|| "cloud agent".into()),
            status: text_at(&value, "status").unwrap_or_else(|| "working".into()),
            last_line: text_at(&value, "last_line").filter(|line| !line.is_empty()),
        },
        "inbox.release" => match text_at(&value, "card_id") {
            Some(card_id) => Hub::Release { card_id },
            None => Hub::Ignored,
        },
        _ => Hub::Ignored,
    })
}

/// `agent.status` as §38.5 types it. The hub's `at` is dropped: `AgentStatus` has no field for it, and
/// inventing one would mean changing the protocol on both sides in one commit (§32.5 rule 1).
fn status_for(agent: &str, status: &str, last_line: Option<String>) -> AgentStatus {
    let kind = agent_kind(agent);
    AgentStatus {
        agent_id: agent_id(kind),
        kind: kind.to_string(),
        // What the agent calls itself, which is what the user should read. The kind is for the icon.
        name: agent.to_string(),
        // Not "hooked": a cloud agent has no hook and no process here. It is reachable only while this socket
        // is up, and the Connect page says so.
        connection: "cloud".into(),
        status: status.to_string(),
        last_line,
    }
}

fn text_at(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// A Ulid whose timestamp is `ms`, so the id and `created_at` cannot disagree. A nonsense timestamp (negative,
/// or so far in the future that the Ulid's 48-bit millisecond field would overflow) falls back to now.
fn ulid_at(ms: i64) -> Ulid {
    const ULID_MAX_MS: i64 = (1 << 48) - 1;
    match u64::try_from(ms) {
        Ok(ms) if ms <= ULID_MAX_MS as u64 => {
            Ulid::from_datetime(UNIX_EPOCH + Duration::from_millis(ms))
        }
        _ => Ulid::new(),
    }
}

// --- what goes up --------------------------------------------------------------------------------------------------

/// The only message this module can send to the cloud: an answer to one card.
///
/// One variant, and a struct rather than an enum, so that "file contents and names never leave the PC" (P5.4)
/// is enforced by the type of the outbound channel and not by remembering. Adding a second outbound message
/// means changing this type, which means changing `socket`, which means reading this comment.
///
/// `choice` and `text` are skipped when absent rather than sent as `null`. Either is fine for `hub.js`
/// (`Number.isInteger(null)` is false, and `text == null` is its own default), but a message with only the
/// field that carries the answer is the one the README documents, and it is smaller.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Answered {
    #[serde(rename = "type")]
    kind: &'static str,
    card_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    choice: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    via: Via,
}

impl Answered {
    /// The hub's `type` for an answer, and the only `type` this module ever writes.
    pub const TYPE: &'static str = "inbox.answer";

    /// Build the message for `answer`, or `None` when there is nothing the hub could do with it.
    ///
    /// `cloud_id` is the hub's own card id, not the local Ulid: the local card is a copy, and `Hub.answer`
    /// looks the card up by `card:<id>` in its own storage.
    ///
    /// `options` is how many options the *cloud* card had. An index outside that range gives `hub.js` a
    /// `picked` of `null` while still moving the card to `answered`, so the agent would be told the user
    /// answered and handed nothing. Refusing to send it leaves the card open and the agent still asking, which
    /// is the failure the user can see and act on.
    pub fn to(cloud_id: &str, options: usize, answer: &Answer) -> Option<Answered> {
        let text = answer
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| truncate(t, MAX_TEXT));
        let choice = answer.choice.filter(|n| *n < options);
        if choice.is_none() && text.is_none() {
            // Either an answer that picked an option the cloud card does not have, or one that carries neither
            // a choice nor any words. Nothing to say.
            return None;
        }
        Some(Answered {
            kind: Answered::TYPE,
            card_id: cloud_id.to_string(),
            choice,
            text,
            via: answer.via,
        })
    }

    /// The JSON frame to put on the socket. Infallible: every field is a string, a `usize` or a `Via`.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            // Unreachable, and still not a panic: an answer that cannot be encoded must not take down a link
            // that other cards are waiting on.
            format!(
                r#"{{"type":"{}","card_id":"","via":"key"}}"#,
                Answered::TYPE
            )
        })
    }

    pub fn card_id(&self) -> &str {
        &self.card_id
    }
}

/// Characters, not bytes: `hub.js` does `String(text).slice(0, 2000)`, which counts UTF-16 code units, and
/// cutting on a character boundary is the only version that cannot produce invalid UTF-8. A string of
/// astral-plane characters is therefore cut slightly later than the hub would cut it; the hub then trims the
/// rest, which is the safe direction.
fn truncate(text: &str, chars: usize) -> String {
    match text.char_indices().nth(chars) {
        Some((at, _)) => text[..at].to_string(),
        None => text.to_string(),
    }
}

// --- the link's own state ------------------------------------------------------------------------------------------

/// Which cloud cards are on the bar right now.
///
/// The only reason this exists is `hub.open`. The hub replays every card still open on every connect, so a
/// socket that drops and comes back while the user is reading a card would otherwise show that card twice. A
/// card is retired when it is no longer the user's to answer -- answered, expired, or the Inbox gone -- and a
/// replay after that is a real second chance, not a duplicate: it means our answer never reached the hub.
#[derive(Debug, Default)]
pub struct Live {
    showing: HashSet<String>,
}

impl Live {
    pub fn new() -> Live {
        Live::default()
    }

    /// True if this card is new to us and should be shown. Remembers it.
    pub fn claim(&mut self, cloud_id: &str) -> bool {
        self.showing.insert(cloud_id.to_string())
    }

    /// The card is finished with locally.
    pub fn retire(&mut self, cloud_id: &str) {
        self.showing.remove(cloud_id);
    }

    pub fn len(&self) -> usize {
        self.showing.len()
    }

    pub fn is_empty(&self) -> bool {
        self.showing.is_empty()
    }
}

/// What the link does with one hub message. The driver turns these into Inbox calls; keeping them as values
/// means every mapping in §37.6 K8 can be checked without an Inbox, a socket or a clock.
#[derive(Debug, PartialEq)]
pub enum Action {
    /// Put this card on the bar, and send the answer back to `cloud_id` when the user gives one.
    Show {
        cloud_id: String,
        /// How many options the cloud card had, for `Answered::to`.
        options: usize,
        card: Box<Card>,
    },
    /// Tell the app about the agent (§38.5 `agent.status`).
    Status(Box<AgentStatus>),
    /// Forget this cloud card: the hub has the answer.
    Retire(String),
}

/// One hub message in, the local actions out. The one piece of policy in this file, and it holds no handles,
/// so the whole of §37.6 K8's mapping is testable on Linux.
pub fn actions(live: &mut Live, message: Hub) -> Vec<Action> {
    match message {
        // Every card raised while we were away (index.js:396). Order is whatever `storage.list` gave; the
        // stack sorts by urgency then time (§33.10 Part D step 5), so it does not matter here.
        Hub::Open(cards) => cards
            .into_iter()
            .filter_map(|card| show(live, card))
            .collect(),
        Hub::Card(card) => {
            // The status goes first so the dock has an agent to hang the card on, even if this is the first
            // we have heard of it.
            let status = Action::Status(Box::new(card.to_status()));
            match show(live, card) {
                Some(show) => vec![status, show],
                // Already on the bar: the hub pushed a card we are showing. Nothing to add, and no second
                // status either -- the agent is already there.
                None => Vec::new(),
            }
        }
        Hub::Status {
            agent,
            status,
            last_line,
        } => vec![Action::Status(Box::new(status_for(
            &agent, &status, last_line,
        )))],
        Hub::Release { card_id } => vec![Action::Retire(card_id)],
        Hub::Ignored => Vec::new(),
    }
}

fn show(live: &mut Live, card: CloudCard) -> Option<Action> {
    if !live.claim(&card.id) {
        return None;
    }
    Some(Action::Show {
        cloud_id: card.id.clone(),
        options: card.options.len(),
        card: Box::new(card.to_card()),
    })
}

// --- the driver ----------------------------------------------------------------------------------------------------

/// What the socket half tells the driver. Three cases and no bytes: the driver never sees a frame header, and
/// the socket never sees a `Card`.
#[derive(Debug, Clone, PartialEq)]
pub enum Wire {
    /// Connected. `hub.open` follows.
    Up,
    /// One text frame.
    Text(String),
    /// The socket is gone. Cards already on the bar stay there -- they are the user's to answer, and §32.5
    /// rule 7 says an unreachable cloud breaks nothing local. An answer given while the link is down waits in
    /// the outbound channel and goes up on reconnect.
    Down,
}

/// Where `agent.status` goes.
///
/// A trait with a no-op default, like `mewndo-inbox`'s `Deps`, so the link is usable -- and honest -- in a
/// build where the desk is not running. `Desk::publish` is the real one.
pub trait StatusSink: Send + Sync + 'static {
    fn status(&self, status: &AgentStatus);
}

/// Drops every status. What a build with no app connected uses.
pub struct NoStatus;

impl StatusSink for NoStatus {
    fn status(&self, _status: &AgentStatus) {}
}

// The one line that wires this module to the rest of the core: the desk's publisher broadcasts any §38.5 body to
// every connected app and drops it when none is (desk_agents.rs). Delete this impl and the module still builds.
impl StatusSink for crate::desk_agents::Publisher {
    fn status(&self, status: &AgentStatus) {
        self.send(status);
    }
}

/// How many answers may wait while the link is down.
///
/// Small on purpose. The queue exists so that answering a card during a two-second blip is not lost; it is not
/// a store-and-forward buffer, and a desktop that has been offline for an hour has nothing useful to say about
/// a card the hub dropped after 24 hours. When it is full, the task holding the newest answer waits -- it owns
/// nothing, and no local card and no other agent waits on it.
const OUTBOUND: usize = 32;

/// Run the link's local half: read what the socket gives us, put cards on the bar, send answers back.
///
/// Returns when `wire` closes, which is when the socket half has stopped for good.
///
/// Cross-platform on purpose (§32.5 rule 5): give it a channel and a fake `StatusSink` and the whole of K8's
/// behaviour can be driven from a test on any OS.
pub async fn drive(
    mut wire: mpsc::Receiver<Wire>,
    out: mpsc::Sender<Answered>,
    inbox: Inbox,
    status: Arc<dyn StatusSink>,
) {
    let mut live = Live::new();
    // Cards retire themselves: the task waiting on one tells us when it is finished, so `Live` never holds a
    // card the user can no longer answer. Held here for the whole run, so the branch never goes dead.
    let (done, mut finished) = mpsc::channel::<String>(OUTBOUND);
    loop {
        tokio::select! {
            message = wire.recv() => match message {
                Some(Wire::Text(raw)) => {
                    // A frame we cannot read is dropped here, and the link carries on.
                    if let Some(message) = parse(&raw) {
                        for action in actions(&mut live, message) {
                            apply(action, &out, &inbox, &status, &done).await;
                        }
                    }
                }
                // Nothing to do for either: `hub.open` does the catching up, and a dropped socket leaves every
                // local card exactly where it was.
                Some(Wire::Up) | Some(Wire::Down) => {}
                None => break,
            },
            Some(cloud_id) = finished.recv() => live.retire(&cloud_id),
        }
    }
}

async fn apply(
    action: Action,
    out: &mpsc::Sender<Answered>,
    inbox: &Inbox,
    status: &Arc<dyn StatusSink>,
    done: &mpsc::Sender<String>,
) {
    match action {
        Action::Show {
            cloud_id,
            options,
            card,
        } => {
            let (_id, answer) = inbox.create(*card).await;
            let (out, done) = (out.clone(), done.clone());
            tokio::spawn(async move {
                // `answer` resolves only when the 2 s grace has passed (§33.4) -- Esc during the grace drops
                // the sender instead, and `Err` is also what an expired card, an Undo or a stopped Inbox
                // gives. So nothing leaves the PC for a card the user took back, and nothing leaves it for a
                // card nobody answered.
                if let Ok(answer) = answer.await
                    && let Some(message) = Answered::to(&cloud_id, options, &answer)
                {
                    let _ = out.send(message).await;
                }
                // Answered, cancelled or expired: either way this card is no longer ours. A `hub.open` replay
                // after this is the hub saying our answer never arrived, and showing it again is right.
                let _ = done.send(cloud_id).await;
            });
        }
        Action::Status(agent) => status.status(&agent),
        Action::Retire(cloud_id) => {
            let _ = done.send(cloud_id).await;
        }
    }
}

/// Start the link: the socket thread and the driver, wired together.
///
/// On a platform without the socket half this starts the driver alone, over a channel nothing writes to. That
/// is deliberate: the core calls `start` unconditionally and the link is simply never up, rather than the core
/// having to know which platforms have one.
pub fn start(
    config: Config,
    inbox: Inbox,
    status: Arc<dyn StatusSink>,
    stop: tokio::sync::watch::Receiver<bool>,
) {
    let (wire_tx, wire_rx) = mpsc::channel::<Wire>(64);
    let (out_tx, out_rx) = mpsc::channel::<Answered>(OUTBOUND);
    #[cfg(windows)]
    socket::spawn(config, wire_tx, out_rx, stop);
    #[cfg(not(windows))]
    {
        // Named so the signature is the same everywhere and the core needs no cfg of its own.
        let _ = (config, wire_tx, out_rx, stop);
    }
    tokio::spawn(drive(wire_rx, out_tx, inbox, status));
}

// --- the socket ----------------------------------------------------------------------------------------------------

/// The only part of this file that touches the network, and the only part behind a `cfg`.
///
/// Windows-only because `native-tls` is SChannel there and OpenSSL everywhere else, and the dev box has no
/// OpenSSL headers (`core/Cargo.toml` says so for `ureq` as well). Everything above this line is compiled and
/// tested on Linux, Windows and macOS.
#[cfg(windows)]
pub mod socket {
    use super::{Answered, Backoff, Config, Wire};
    use std::io;
    use std::time::Duration;
    use tokio::sync::{mpsc, watch};
    use tokio_tungstenite::tungstenite::http::{Request, header};
    use tokio_tungstenite::tungstenite::stream::MaybeTlsStream;
    use tokio_tungstenite::tungstenite::{Error as WsError, Message, WebSocket, connect};

    /// How long a read waits before the loop looks at the outbound queue and the stop flag.
    ///
    /// The cost of a tick is up to this much delay on an outgoing answer, after the user has already waited
    /// 2 s for the grace, so 250 ms is invisible. The benefit is that one thread can both read and write a
    /// blocking socket without a second thread and the shutdown race that comes with it.
    pub const TICK: Duration = Duration::from_millis(250);

    type Socket = WebSocket<MaybeTlsStream<std::net::TcpStream>>;

    /// One thread, for as long as the core runs.
    ///
    /// A plain `std::thread`, not `spawn_blocking`: a blocking-pool task cannot be cancelled and would hold
    /// the runtime open at shutdown. This thread is detached, checks `stop` every `TICK`, and the process
    /// exits whether or not it has noticed.
    pub fn spawn(
        config: Config,
        wire: mpsc::Sender<Wire>,
        out: mpsc::Receiver<Answered>,
        stop: watch::Receiver<bool>,
    ) {
        std::thread::Builder::new()
            .name("mewndo-cloud-link".into())
            .spawn(move || reconnect(config, wire, out, stop))
            .ok();
    }

    /// §37.6 K8's reconnect loop. Never returns except on `stop`.
    fn reconnect(
        config: Config,
        wire: mpsc::Sender<Wire>,
        mut out: mpsc::Receiver<Answered>,
        stop: watch::Receiver<bool>,
    ) {
        let mut backoff = Backoff::new();
        // A url this bad will not get better: no token, or a base that is not a url. Say so once and stop,
        // rather than retry every 30 s for ever.
        let url = match config.url() {
            Ok(url) => url,
            Err(_) => return,
        };
        while !*stop.borrow() {
            // A refused upgrade, a bad token, no network: all the same from here. §32.5 rule 7 -- try again,
            // break nothing local.
            if let Ok(mut socket) = open(&url, &config) {
                backoff.reset();
                if wire.blocking_send(Wire::Up).is_err() {
                    return; // the driver is gone: so is the link
                }
                pump(&mut socket, &wire, &mut out, &stop);
                // Best effort: a hub that has already gone will refuse this, which is not a failure.
                let _ = socket.close(None);
                if wire.blocking_send(Wire::Down).is_err() {
                    return;
                }
            }
            sleep_unless_stopped(backoff.take(), &stop);
        }
    }

    /// Connect, with the token in the header unless `Config` says it has to be in the query.
    fn open(url: &str, config: &Config) -> Result<Socket, WsError> {
        let mut socket = if config.token_in_query {
            // The token is already in `url` (index.js:76 accepts `?token=`), so no header is needed.
            connect(url)?.0
        } else {
            let request = Request::builder()
                .uri(url)
                .header(header::AUTHORIZATION, format!("Bearer {}", config.token))
                .body(())
                .map_err(|e| WsError::Io(io::Error::other(e)))?;
            connect(request)?.0
        };
        // Without this the loop below would block in `read` for ever and never send an answer.
        set_read_timeout(&mut socket, TICK)?;
        Ok(socket)
    }

    fn set_read_timeout(socket: &mut Socket, timeout: Duration) -> Result<(), WsError> {
        // `MaybeTlsStream` is non-exhaustive, so a stream this doesn't know (a second TLS backend) is an error
        // here rather than a socket silently left blocking for ever.
        let tcp = match socket.get_mut() {
            MaybeTlsStream::Plain(tcp) => tcp,
            MaybeTlsStream::NativeTls(tls) => tls.get_ref(),
            _ => {
                return Err(WsError::Io(io::Error::other(
                    "the cloud link got a TLS stream it can't set a timeout on",
                )));
            }
        };
        tcp.set_read_timeout(Some(timeout)).map_err(WsError::Io)
    }

    /// Read frames and send answers until the socket or the core stops.
    fn pump(
        socket: &mut Socket,
        wire: &mpsc::Sender<Wire>,
        out: &mut mpsc::Receiver<Answered>,
        stop: &watch::Receiver<bool>,
    ) {
        while !*stop.borrow() {
            // Everything the user has answered since the last tick. `try_recv` and not `blocking_recv`: this
            // thread must get back to `read`.
            while let Ok(answer) = out.try_recv() {
                if socket.send(Message::text(answer.encode())).is_err() {
                    return;
                }
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    if wire
                        .blocking_send(Wire::Text(text.as_str().to_string()))
                        .is_err()
                    {
                        return;
                    }
                }
                // Ping and Pong are answered by tungstenite itself, on the next write. Binary and Frame are
                // not part of this contract: the hub sends JSON text and nothing else.
                Ok(_) => {}
                // Nothing arrived this tick, which is the normal case: back round to the outbound queue.
                Err(WsError::Io(e)) if waiting(&e) => {}
                // A close frame, a broken pipe, a protocol error: reconnect with the backoff.
                Err(_) => return,
            }
        }
    }

    /// The read timeout expiring, not a real error. Windows gives `TimedOut` for `SO_RCVTIMEO`; a socket that
    /// was put in non-blocking mode elsewhere would give `WouldBlock`.
    fn waiting(e: &io::Error) -> bool {
        matches!(
            e.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        )
    }

    /// Wait, in slices, so shutdown does not have to wait out a 30 s backoff.
    fn sleep_unless_stopped(total: Duration, stop: &watch::Receiver<bool>) {
        let slice = Duration::from_millis(100);
        let mut left = total;
        while !left.is_zero() && !*stop.borrow() {
            let step = left.min(slice);
            std::thread::sleep(step);
            left -= step;
        }
    }
}

// --- tests ---------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_inbox::{CardState, Config as InboxConfig, Deps as InboxDeps, TOP, choice, text};
    use std::sync::Mutex;

    // --- the backoff -----------------------------------------------------------------------------------------------

    #[test]
    fn the_backoff_runs_from_1s_to_30s_and_stays_there() {
        let mut backoff = Backoff::new();
        let seconds: Vec<u64> = (0..8).map(|_| backoff.take().as_secs()).collect();
        assert_eq!(
            seconds,
            [1, 2, 4, 8, 16, 30, 30, 30],
            "§37.6 K8: backoff from 1 s to 30 s, doubling and capped"
        );
    }

    #[test]
    fn a_connection_that_worked_resets_the_backoff() {
        let mut backoff = Backoff::new();
        for _ in 0..5 {
            backoff.take();
        }
        assert_eq!(backoff.peek(), Duration::from_secs(30));
        backoff.reset();
        assert_eq!(
            backoff.take(),
            Backoff::FIRST,
            "one bad night must not leave a working link waiting 30 s after the next blip"
        );
    }

    // --- the url and the token -------------------------------------------------------------------------------------

    #[test]
    fn the_hub_url_is_wss_worker_hub() {
        let config = Config::new("https://mewndo-cloud.someone.workers.dev", "tok");
        assert_eq!(
            config.url().unwrap(),
            "wss://mewndo-cloud.someone.workers.dev/hub"
        );
        // A trailing slash, and a base already given as wss://.
        assert_eq!(
            Config::new("wss://w.example/", "tok").url().unwrap(),
            "wss://w.example/hub"
        );
        // `wrangler dev` on localhost is the only reason plain ws is allowed.
        assert_eq!(
            Config::new("http://127.0.0.1:8787", "tok").url().unwrap(),
            "ws://127.0.0.1:8787/hub"
        );
    }

    #[test]
    fn the_token_goes_in_the_query_only_when_asked_and_never_in_a_log_line() {
        let mut config = Config::new("https://w.example", "s3cret");
        assert_eq!(config.url().unwrap(), "wss://w.example/hub");
        assert!(
            !config.url().unwrap().contains("s3cret"),
            "the header is the default, so the url carries no secret"
        );
        config.token_in_query = true;
        assert_eq!(config.url().unwrap(), "wss://w.example/hub?token=s3cret");
        assert!(
            !config.safe_url().contains("s3cret"),
            "safe_url is the one that may be logged (CLAUDE.md rule 4)"
        );
    }

    #[test]
    fn a_url_or_token_that_cannot_work_is_refused_with_a_reason() {
        // The token value is deliberately nothing like the word "token": the point of the second assertion is
        // that a reason never quotes the secret, and a needle that appears in "no invite token" would pass by
        // accident.
        const SECRET: &str = "zqx-9f41-secret";
        for (base, token) in [
            ("https://w.example", "   "),
            ("", SECRET),
            ("w.example", SECRET),
            ("ftp://w.example", SECRET),
            ("https://", SECRET),
        ] {
            let error = Config {
                base: base.into(),
                token: token.into(),
                token_in_query: false,
            }
            .url()
            .expect_err(&format!("{base:?} should be refused"));
            assert!(
                !error.contains(SECRET),
                "a reason never quotes the token, got {error:?}"
            );
        }
    }

    // --- the agent kinds -------------------------------------------------------------------------------------------

    #[test]
    fn the_mcp_clients_name_becomes_one_of_the_four_cloud_kinds() {
        // §37.6 K8: dots, grok-bot, muse, claude-ai, taken from the MCP client's name. index.js:68 passes
        // `clientInfo.name` through untouched, so these are the spellings an agent app might send.
        for (name, kind) in [
            ("dots", "dots"),
            ("ChatGPT", "dots"),
            ("openai-dots", "dots"),
            ("grok-bot", "grok-bot"),
            ("Grok Bot", "grok-bot"),
            ("muse", "muse"),
            ("Meta Muse", "muse"),
            ("claude-ai", "claude-ai"),
            ("claude.ai", "claude-ai"),
            ("Claude", "claude-ai"),
        ] {
            assert_eq!(agent_kind(name), kind, "{name:?}");
        }
    }

    #[test]
    fn an_agent_we_cannot_name_is_not_given_one_of_the_four() {
        // hub.js's own default, and anything new.
        for name in ["cloud agent", "", "Some New Agent", "gemini"] {
            assert_eq!(
                agent_kind(name),
                UNKNOWN_KIND,
                "a wrong bubble is a lie about who is acting"
            );
        }
        assert!(
            !["dots", "grok-bot", "muse", "claude-ai"].contains(&UNKNOWN_KIND),
            "the unknown kind must not collide with one of the four"
        );
    }

    // --- mapping one cloud card into the Inbox ---------------------------------------------------------------------

    /// An `inbox.card` push exactly as `hub.js:58` writes it, with a card from `createCard`.
    fn card_push(id: &str, agent: &str) -> String {
        serde_json::json!({
            "type": "inbox.card",
            "source": "cloud",
            "agent": agent,
            "card": {
                "id": id,
                "source": "cloud",
                "agent": agent,
                "kind": "question",
                "title": "Send the invoice to ada@example.com?",
                "body": "the September one",
                "options": ["Send it", "Not yet", "Let me edit it"],
                "risk": 3,
                "state": "open",
                "created_at": 1_760_000_000_000_i64,
                "answer": Value::Null,
            }
        })
        .to_string()
    }

    #[test]
    fn an_inbox_card_becomes_one_local_card_with_the_agents_kind() {
        let mut live = Live::new();
        let actions = actions(&mut live, parse(&card_push("c1", "grok-bot")).unwrap());
        let (status, card, options, cloud_id) = match &actions[..] {
            [
                Action::Status(status),
                Action::Show {
                    cloud_id,
                    options,
                    card,
                },
            ] => (status, card, *options, cloud_id),
            other => panic!("expected a status and one card, got {other:?}"),
        };
        assert_eq!(
            cloud_id, "c1",
            "the hub's id is what an answer is addressed to"
        );
        assert_eq!(options, 3);
        assert_eq!(card.kind, CardKind::Question);
        assert_eq!(card.agent_id, "cloud:grok-bot");
        assert_eq!(card.title, "Send the invoice to ada@example.com?");
        assert_eq!(card.body, "the September one");
        assert_eq!(
            card.options
                .iter()
                .map(|o| o.label.as_str())
                .collect::<Vec<_>>(),
            ["Send it", "Not yet", "Let me edit it"]
        );
        assert_eq!(card.risk, 3);
        assert_eq!(card.state, CardState::Open);
        assert_eq!(card.created_at, 1_760_000_000_000);
        assert_eq!(
            card.deadline,
            Some(CARD_KEEP),
            "the hub keeps a card for 24 h; expiring sooner would throw away an answer it still wants"
        );
        assert_eq!(
            card.id.timestamp_ms() as i64,
            card.created_at,
            "card.rs relies on the Ulid's own timestamp agreeing with created_at"
        );
        assert!(
            card.options.iter().all(|o| o.answer.is_none()),
            "a cloud card has no action signature and no project, so it teaches the habit counter nothing"
        );
        assert!(card.permission.is_none());
        assert_eq!(
            (&status.kind, &status.agent_id),
            (&"grok-bot".to_string(), &card.agent_id)
        );
        assert_eq!(status.connection, "cloud", "a cloud agent has no hook here");
        assert_eq!(
            status.name, "grok-bot",
            "the user reads the agent's own name"
        );
    }

    #[test]
    fn each_hub_card_kind_becomes_the_right_33_2_kind() {
        // The three kinds hub.js can produce: `createCard`'s default, `ask` with no options, and `done`.
        for (hub, local) in [
            ("question", CardKind::Question),
            ("permission", CardKind::Permission),
            ("done", CardKind::Done),
            // Anything new on the cloud side asks the user and teaches nothing, which is a Question.
            ("something-new", CardKind::Question),
        ] {
            let card = CloudCard {
                id: "c".into(),
                agent: "dots".into(),
                kind: hub.into(),
                title: "t".into(),
                body: String::new(),
                options: Vec::new(),
                risk: 2,
                created_at: 1,
            };
            assert_eq!(card.to_card().kind, local, "{hub}");
        }
    }

    #[test]
    fn an_agent_status_becomes_one_agent_status_for_the_app() {
        let raw = serde_json::json!({
            "type": "agent.status", "source": "cloud", "agent": "ChatGPT",
            "status": "working", "last_line": "reading the invoice", "at": 1_760_000_000_000_i64
        })
        .to_string();
        let mut live = Live::new();
        match &actions(&mut live, parse(&raw).unwrap())[..] {
            [Action::Status(status)] => {
                assert_eq!(status.kind, "dots");
                assert_eq!(status.agent_id, "cloud:dots");
                assert_eq!(status.name, "ChatGPT");
                assert_eq!(status.status, "working");
                assert_eq!(status.last_line.as_deref(), Some("reading the invoice"));
                assert_eq!(status.connection, "cloud");
            }
            other => panic!("expected one status, got {other:?}"),
        }
        assert!(live.is_empty(), "a status is not a card");
    }

    #[test]
    fn an_empty_last_line_is_no_last_line() {
        let raw = r#"{"type":"agent.status","agent":"muse","status":"working","last_line":""}"#;
        match parse(raw) {
            Some(Hub::Status { last_line, .. }) => assert_eq!(last_line, None),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_inbox_release_retires_the_card() {
        let mut live = Live::new();
        actions(&mut live, parse(&card_push("c1", "dots")).unwrap());
        assert_eq!(live.len(), 1);
        let got = actions(
            &mut live,
            parse(r#"{"type":"inbox.release","card_id":"c1"}"#).unwrap(),
        );
        assert_eq!(got, [Action::Retire("c1".into())]);
    }

    // --- hub.open --------------------------------------------------------------------------------------------------

    fn hub_open(ids: &[&str]) -> String {
        let cards: Vec<Value> = ids
            .iter()
            .enumerate()
            .map(|(n, id)| {
                serde_json::json!({
                    "id": id, "source": "cloud", "agent": "claude-ai", "kind": "permission",
                    "title": format!("question {n}"), "body": Value::Null, "options": ["Yes", "No"],
                    "risk": 2, "state": "open", "created_at": 1_760_000_000_000_i64 + n as i64,
                })
            })
            .collect();
        serde_json::json!({ "type": "hub.open", "cards": cards }).to_string()
    }

    #[test]
    fn hub_open_replays_every_card_raised_while_the_desktop_was_away() {
        let mut live = Live::new();
        let actions = actions(&mut live, parse(&hub_open(&["a", "b", "c"])).unwrap());
        let shown: Vec<&str> = actions
            .iter()
            .filter_map(|a| match a {
                Action::Show { cloud_id, .. } => Some(cloud_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(shown, ["a", "b", "c"], "every missed card reaches the bar");
        assert_eq!(live.len(), 3);
        // A card with no body is a card with an empty body, not a dropped card.
        match &actions[0] {
            Action::Show { card, .. } => assert_eq!(card.body, ""),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_reconnect_does_not_show_a_card_the_user_is_already_reading() {
        let mut live = Live::new();
        actions(&mut live, parse(&card_push("c1", "dots")).unwrap());
        // The socket drops and comes back; the hub replays every open card, including that one.
        let again = actions(&mut live, parse(&hub_open(&["c1", "c2"])).unwrap());
        let shown: Vec<&str> = again
            .iter()
            .filter_map(|a| match a {
                Action::Show { cloud_id, .. } => Some(cloud_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(shown, ["c2"], "c1 is already on the bar");
        // A second push of the same card adds nothing either -- not even a status.
        assert_eq!(
            actions(&mut live, parse(&card_push("c1", "dots")).unwrap()),
            []
        );
    }

    #[test]
    fn a_replay_after_the_card_is_finished_with_is_a_real_second_chance() {
        let mut live = Live::new();
        actions(&mut live, parse(&card_push("c1", "dots")).unwrap());
        // The answer went nowhere: the socket died before the hub acknowledged it, so the card is retired
        // locally and the hub still has it open.
        live.retire("c1");
        let again = actions(&mut live, parse(&hub_open(&["c1"])).unwrap());
        assert!(
            matches!(&again[..], [Action::Show { cloud_id, .. }] if cloud_id == "c1"),
            "the hub still listing it open means our answer never arrived"
        );
    }

    #[test]
    fn hub_open_with_no_cards_is_not_an_error() {
        let mut live = Live::new();
        assert_eq!(
            actions(
                &mut live,
                parse(r#"{"type":"hub.open","cards":[]}"#).unwrap()
            ),
            []
        );
        assert_eq!(
            actions(&mut live, parse(r#"{"type":"hub.open"}"#).unwrap()),
            []
        );
    }

    // --- what an answer looks like on the wire ---------------------------------------------------------------------

    #[test]
    fn an_answer_serializes_to_exactly_what_hub_js_accepts() {
        // hub.js:80-91: `{card_id, choice, text, via}`, `choice` an integer index into the card's options.
        let answer = choice(Ulid::new(), 1, Via::Key);
        let message = Answered::to("card-7", 3, &answer).unwrap();
        assert_eq!(
            message.encode(),
            r#"{"type":"inbox.answer","card_id":"card-7","choice":1,"via":"key"}"#
        );
        // The hub reads it back with JSON.parse and indexes `card.options[choice]`.
        let parsed: Value = serde_json::from_str(&message.encode()).unwrap();
        assert_eq!(parsed["type"], "inbox.answer");
        assert_eq!(parsed["card_id"], "card-7");
        assert!(
            parsed["choice"].is_u64(),
            "Number.isInteger(choice) must be true"
        );
        assert_eq!(parsed["choice"].as_u64(), Some(1));
        assert_eq!(parsed["via"], "key");
    }

    #[test]
    fn a_typed_answer_sends_text_and_no_choice() {
        let answer = text(Ulid::new(), "wait until Friday", Via::Voice);
        let message = Answered::to("card-7", 3, &answer).unwrap();
        assert_eq!(
            message.encode(),
            r#"{"type":"inbox.answer","card_id":"card-7","text":"wait until Friday","via":"voice"}"#
        );
    }

    #[test]
    fn answer_zero_is_a_real_choice_and_not_a_missing_one() {
        // The trap in a JS contract: `choice: 0` is falsy, and `Number.isInteger(0)` is true, so hub.js takes
        // it. Sending nothing, or sending `null`, would silently lose the first option on every card.
        let message = Answered::to("c", 2, &choice(Ulid::new(), 0, Via::Click)).unwrap();
        assert_eq!(
            message.encode(),
            r#"{"type":"inbox.answer","card_id":"c","choice":0,"via":"click"}"#
        );
    }

    #[test]
    fn an_answer_the_cloud_card_has_no_option_for_is_not_sent() {
        // `card.options[choice] == null` makes hub.js store `picked: null` and still mark the card answered --
        // the agent is told the user replied and handed nothing. Better to leave the card open.
        assert_eq!(
            Answered::to("c", 2, &choice(Ulid::new(), 2, Via::Key)),
            None
        );
        assert_eq!(
            Answered::to("c", 0, &choice(Ulid::new(), 0, Via::Key)),
            None
        );
        // An answer with neither a choice nor words says nothing at all.
        let empty = Answer {
            card_id: "x".into(),
            choice: None,
            text: Some("   ".into()),
            via: Via::Key,
        };
        assert_eq!(Answered::to("c", 2, &empty), None);
    }

    #[test]
    fn a_long_typed_answer_is_cut_where_the_hub_would_cut_it() {
        let long = "x".repeat(MAX_TEXT + 500);
        let message = Answered::to("c", 0, &text(Ulid::new(), long, Via::Key)).unwrap();
        let parsed: Value = serde_json::from_str(&message.encode()).unwrap();
        assert_eq!(parsed["text"].as_str().unwrap().chars().count(), MAX_TEXT);
        // On a character boundary, so what we send is always valid UTF-8.
        let wide = "é".repeat(MAX_TEXT + 10);
        let message = Answered::to("c", 0, &text(Ulid::new(), wide, Via::Key)).unwrap();
        assert!(serde_json::from_str::<Value>(&message.encode()).is_ok());
    }

    #[test]
    fn an_answer_carries_no_file_name_and_no_file_content() {
        // P5.4: "File contents and names never leave the PC." The card's own title and body came *down* from
        // the cloud and may name anything; the answer must not echo them, and must not add a path of its own.
        let card = CloudCard {
            id: "c9".into(),
            agent: "claude-ai".into(),
            kind: "permission".into(),
            title: "Delete C:\\Users\\ada\\taxes\\2026-return.pdf?".into(),
            body: "it looks like a duplicate".into(),
            options: vec!["Delete it".into(), "Keep it".into()],
            risk: 5,
            created_at: 1,
        };
        let message = Answered::to(
            "c9",
            card.options.len(),
            &choice(card.to_card().id, 1, Via::Key),
        )
        .unwrap();
        let wire = message.encode();
        let parsed: Value = serde_json::from_str(&wire).unwrap();
        let mut keys: Vec<&str> = parsed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["card_id", "choice", "type", "via"],
            "an answer is a card id, a choice and how it was given -- nothing else"
        );
        for leak in [
            "taxes",
            "2026-return.pdf",
            "Users",
            "ada",
            "duplicate",
            "Delete",
        ] {
            assert!(!wire.contains(leak), "{leak:?} must not appear in {wire}");
        }
    }

    // --- a message we cannot read ----------------------------------------------------------------------------------

    #[test]
    fn a_malformed_message_is_ignored_rather_than_crashing_the_link() {
        let mut live = Live::new();
        for raw in [
            "",
            "not json at all",
            "{",
            r#"{"type":"inbox.card","card":{"#, // truncated mid-frame
            "[]",                               // not an object
            "null",
            "42",
            r#"{"no":"type"}"#,
            r#"{"type":7}"#,
            r#"{"type":"inbox.card"}"#, // a push with no card
            r#"{"type":"inbox.card","card":{"title":"no id"}}"#,
            r#"{"type":"inbox.card","card":{"id":"c","body":"no title"}}"#,
            r#"{"type":"hub.open","cards":"not a list"}"#,
            r#"{"type":"hub.open","cards":[null,7,{"id":"ok","title":"t"}]}"#,
            r#"{"type":"inbox.release"}"#,
            r#"{"type":"skills.ok","slug":"x"}"#,
            r#"{"type":"error","message":"no such card"}"#,
            r#"{"type":"something.new","body":{}}"#,
        ] {
            // Neither of these may panic, and `live` must survive every one of them.
            let got = parse(raw).map(|message| actions(&mut live, message));
            if let Some(got) = got {
                for action in got {
                    // The only card in this list that is usable at all is `{"id":"ok","title":"t"}`.
                    if let Action::Show { cloud_id, .. } = action {
                        assert_eq!(cloud_id, "ok", "from {raw}");
                    }
                }
            }
        }
        assert_eq!(live.len(), 1, "only the one readable card was taken");
    }

    #[test]
    fn a_card_with_fields_in_the_wrong_shape_is_still_shown() {
        // Refusing a card means the user never hears that an agent is waiting, so a strange `risk`, a strange
        // `options` or a missing `created_at` must not be fatal.
        let raw = serde_json::json!({
            "type": "inbox.card", "agent": "dots",
            "card": { "id": "c", "title": "ok?", "risk": "high", "options": [1, "Yes", Value::Null, "No"],
                      "created_at": -5 }
        })
        .to_string();
        let mut live = Live::new();
        match &actions(&mut live, parse(&raw).unwrap())[..] {
            [_, Action::Show { card, options, .. }] => {
                assert_eq!(card.risk, 2, "an unreadable risk is hub.js's own default");
                assert_eq!(*options, 2);
                assert_eq!(
                    card.options
                        .iter()
                        .map(|o| o.label.as_str())
                        .collect::<Vec<_>>(),
                    ["Yes", "No"],
                    "options that are not strings are dropped, the rest are kept"
                );
                assert!(
                    card.created_at > 0,
                    "a nonsense created_at falls back to now"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_card_with_more_options_than_the_number_keys_is_truncated() {
        let many: Vec<String> = (0..20).map(|n| format!("option {n}")).collect();
        let raw = serde_json::json!({
            "type": "inbox.card", "agent": "muse",
            "card": { "id": "c", "title": "pick one", "options": many }
        })
        .to_string();
        let mut live = Live::new();
        match &actions(&mut live, parse(&raw).unwrap())[..] {
            [_, Action::Show { card, options, .. }] => {
                assert_eq!(*options, MAX_OPTIONS, "§33.2 answers with the keys 1-9");
                assert_eq!(card.options.len(), MAX_OPTIONS);
            }
            other => panic!("{other:?}"),
        }
    }

    // --- the driver, end to end ------------------------------------------------------------------------------------

    /// Records every status the link publishes, in place of the Desk.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<AgentStatus>>);

    impl StatusSink for Recorder {
        fn status(&self, status: &AgentStatus) {
            self.0.lock().unwrap().push(status.clone());
        }
    }

    struct Harness {
        wire: mpsc::Sender<Wire>,
        out: mpsc::Receiver<Answered>,
        inbox: Inbox,
        statuses: Arc<Recorder>,
    }

    /// A driver with a real Inbox behind it. The grace is 20 ms rather than §33.4's 2 s so the tests are not
    /// 2 s each; it is the same code path, and `nothing_is_sent_while_the_grace_is_running` is the one that
    /// cares that there is a grace at all.
    fn harness() -> Harness {
        let (wire, wire_rx) = mpsc::channel(16);
        let (out_tx, out) = mpsc::channel(16);
        let inbox = Inbox::start(
            InboxConfig {
                grace: Duration::from_millis(20),
                ..InboxConfig::default()
            },
            InboxDeps::default(),
        );
        let statuses = Arc::new(Recorder::default());
        tokio::spawn(drive(wire_rx, out_tx, inbox.clone(), statuses.clone()));
        Harness {
            wire,
            out,
            inbox,
            statuses,
        }
    }

    /// Wait for the card the link just made. The driver runs in its own task, so there is nothing to await on.
    async fn wait_for_card(inbox: &Inbox) -> mewndo_inbox::Card {
        for _ in 0..200 {
            let stack = inbox.stack(TOP).await;
            if let Some(card) = stack.cards.first() {
                return card.clone();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the link never put a card on the bar");
    }

    #[tokio::test]
    async fn a_cloud_card_reaches_the_bar_and_the_answer_reaches_the_hub() {
        let mut h = harness();
        h.wire.send(Wire::Up).await.unwrap();
        h.wire
            .send(Wire::Text(card_push("c1", "grok-bot")))
            .await
            .unwrap();

        let card = wait_for_card(&h.inbox).await;
        assert_eq!(card.agent_id, "cloud:grok-bot");
        assert_eq!(card.options.len(), 3);

        h.inbox.answer(card.id, choice(card.id, 2, Via::Key)).await;
        let sent = h.out.recv().await.expect("the answer goes up");
        assert_eq!(
            sent.card_id(),
            "c1",
            "addressed to the hub's id, not the local Ulid"
        );
        assert_eq!(
            sent.encode(),
            r#"{"type":"inbox.answer","card_id":"c1","choice":2,"via":"key"}"#
        );
        assert_eq!(
            h.statuses.0.lock().unwrap().len(),
            1,
            "one agent.status for the dock"
        );
    }

    #[tokio::test]
    async fn nothing_is_sent_while_the_grace_is_running_and_esc_sends_nothing_at_all() {
        let mut h = harness();
        h.wire
            .send(Wire::Text(card_push("c1", "dots")))
            .await
            .unwrap();
        let card = wait_for_card(&h.inbox).await;

        h.inbox.answer(card.id, choice(card.id, 0, Via::Key)).await;
        assert_eq!(
            h.out.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "§33.4: the answer waits out the 2 s grace before it goes anywhere, including the cloud"
        );
        // Esc during the grace (§33.9 answering -> open).
        h.inbox.cancel(card.id).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(
            h.out.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "an answer the user took back never leaves the PC"
        );
        assert_eq!(h.inbox.state(card.id).await, Some(CardState::Open));

        // And the second answer, left alone, does go up.
        h.inbox
            .answer(card.id, choice(card.id, 1, Via::Click))
            .await;
        let sent = h.out.recv().await.unwrap();
        assert_eq!(
            sent.encode(),
            r#"{"type":"inbox.answer","card_id":"c1","choice":1,"via":"click"}"#
        );
    }

    #[tokio::test]
    async fn an_expired_card_sends_nothing() {
        let mut h = harness();
        h.wire
            .send(Wire::Text(card_push("c1", "muse")))
            .await
            .unwrap();
        let card = wait_for_card(&h.inbox).await;
        // The agent gave up, or the user answered in the agent's own window (§33.9 open -> expired).
        h.inbox.expire(card.id).await;
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(h.out.try_recv(), Err(mpsc::error::TryRecvError::Empty));
    }

    #[tokio::test]
    async fn nothing_but_a_card_answer_can_be_sent() {
        // P5.4: "File contents and names never leave the PC." The outbound channel is typed
        // `mpsc::Sender<Answered>`, so the compiler is the first half of this test: there is no other message
        // this module could put on it. The rest drives everything the hub can push -- a status, a replay, a
        // malformed frame, a release, a connect and a disconnect -- and a local card of the kind the rest of
        // the core makes, and checks the socket saw exactly one thing.
        let mut h = harness();
        h.wire.send(Wire::Up).await.unwrap();
        for raw in [
            r#"{"type":"agent.status","agent":"dots","status":"working","last_line":"opening C:\\secrets\\keys.txt"}"#,
            r#"{"type":"error","message":"no such card"}"#,
            r#"{"type":"skills.ok","slug":"invoice"}"#,
            "not json",
            &hub_open(&["c1"]),
            &card_push("c1", "dots"),
        ] {
            h.wire.send(Wire::Text(raw.to_string())).await.unwrap();
        }
        // A local card, made by some other part of the core. Its answer is nobody's business but the hook's.
        let local = Card::new(
            CardKind::Permission,
            "claude-code",
            "Run rm -rf build?",
            "shop",
        );
        let (local_id, _hook) = h.inbox.create(local).await;
        h.inbox
            .answer(local_id, choice(local_id, 0, Via::Key))
            .await;

        let cloud = wait_for_card(&h.inbox).await;
        let cloud = if cloud.id == local_id {
            h.inbox
                .stack(TOP)
                .await
                .cards
                .into_iter()
                .find(|c| c.id != local_id)
                .expect("the cloud card is on the bar too")
        } else {
            cloud
        };
        h.inbox
            .answer(cloud.id, choice(cloud.id, 0, Via::Key))
            .await;
        h.wire.send(Wire::Down).await.unwrap();

        let first = h.out.recv().await.expect("the cloud card's answer");
        assert_eq!(
            first.encode(),
            r#"{"type":"inbox.answer","card_id":"c1","choice":0,"via":"key"}"#
        );
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(
            h.out.try_recv(),
            Err(mpsc::error::TryRecvError::Empty),
            "one card answer and nothing else: no status, no skills.share, no local card's answer"
        );
    }

    #[tokio::test]
    async fn an_unreachable_cloud_breaks_nothing_local() {
        // §32.5 rule 7. The socket never comes up: `Wire::Up` never arrives, `Wire::Down` does, and the
        // channel closes when the socket half gives up.
        let h = harness();
        h.wire.send(Wire::Down).await.unwrap();
        drop(h.wire);

        // The Inbox the rest of the core shares is untouched: a local card still works end to end.
        let local = Card::new(CardKind::Permission, "claude-code", "Run npm test?", "shop");
        let (id, hook) = h.inbox.create(local).await;
        h.inbox.answer(id, choice(id, 0, Via::Key)).await;
        let answer = tokio::time::timeout(Duration::from_secs(2), hook)
            .await
            .expect("the hook is not left waiting on a dead cloud link")
            .expect("and it gets its answer");
        assert_eq!(answer.choice, Some(0));
    }

    #[tokio::test]
    async fn a_card_answered_while_the_link_is_down_goes_up_on_reconnect() {
        let mut h = harness();
        h.wire
            .send(Wire::Text(card_push("c1", "dots")))
            .await
            .unwrap();
        let card = wait_for_card(&h.inbox).await;
        h.wire.send(Wire::Down).await.unwrap();
        h.inbox.answer(card.id, choice(card.id, 0, Via::Key)).await;
        // The socket half drains the channel when it is next connected; nothing is lost in between.
        let sent = h.out.recv().await.unwrap();
        assert_eq!(sent.card_id(), "c1");
    }

    #[tokio::test]
    async fn the_driver_stops_when_the_socket_half_is_gone() {
        let (wire, wire_rx) = mpsc::channel(4);
        let (out_tx, _out) = mpsc::channel(4);
        let inbox = Inbox::start(InboxConfig::default(), InboxDeps::default());
        let driver = tokio::spawn(drive(wire_rx, out_tx, inbox, Arc::new(NoStatus)));
        drop(wire);
        tokio::time::timeout(Duration::from_secs(2), driver)
            .await
            .expect("the driver returns rather than spinning")
            .unwrap();
    }
}
