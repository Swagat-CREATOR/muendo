//! Messages to an agent from outside its terminal (`agent.message`), the Done card's reply window and its hold
//! (`inbox.hold`), and the next steps a Done card offers. Shared by the three handlers, because the rules are the
//! same for every agent: only the words each one's `Stop` hook prints differ.
//!
//! An agent can be reached from outside its terminal in exactly two moments, and this file is the whole of both:
//!
//! 1. **Its `Stop` hook is waiting** (a Done card is open). The message resolves that wait, and the hook prints it
//!    as the reason to carry on (Claude and Codex: `{"decision":"block","reason":…}`; Cursor: `followup_message`).
//!    The app is told `now`.
//! 2. **It is mid-turn** (a hook has run since its last `Stop`). The message is queued, and its next `Stop` hook
//!    prints it at once, without waiting for the Done card. The app is told `queued`.
//!
//! Anything else - an agent idle at its prompt with no hook running, or one Mewndo has never heard from - cannot
//! be reached except through a lane, and the app is told `unsupported` with a sentence saying so (§28.10). The one
//! exception is on Windows, for an idle agent whose terminal its hook reported (`console_pid`, kept here): the core
//! offers to type the text there once the user confirms it (desk_agents.rs, typing.rs).
//!
//! The reply window: a Done card's hook waits a short window (15 s by default). While the user is in the card's
//! reply box or dictating, the app sends `inbox.hold` and the wait stretches to the most the hook's own timeout
//! allows, less a safety margin, so the hook always answers before the agent gives up on it.
use mewndo_inbox::{Answer, CardId};
use mewndo_proto::{AgentStatus, Delivery};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::claude::{Events, NoEvents};

/// The most text queued for one agent. A queue is for a few sentences typed while the agent works, not for
/// pasting a file into a hook's output; anything past this is cut, and the app is told it was.
pub const QUEUE_CAP: usize = 4000;
/// How many next-step options a Done card offers.
pub const MAX_NEXT_STEPS: usize = 3;

/// What each handler shares with the core: the mailbox and the place `agent.status` goes.
#[derive(Clone)]
pub struct Link {
    pub mailbox: Arc<Mailbox>,
    pub events: Arc<dyn Events>,
}

impl Default for Link {
    fn default() -> Link {
        Link {
            mailbox: Arc::new(Mailbox::default()),
            events: Arc::new(NoEvents),
        }
    }
}

impl Link {
    /// `agent.status`, in the shape Claude Code's handler has always sent.
    pub fn status(
        &self,
        agent_id: &str,
        kind: &str,
        name: &str,
        status: &str,
        line: Option<String>,
    ) {
        self.mailbox.shown(agent_id, status);
        self.events.agent_status(AgentStatus {
            agent_id: agent_id.to_string(),
            kind: kind.to_string(),
            name: name.to_string(),
            connection: "hooked".to_string(),
            status: status.to_string(),
            last_line: line.filter(|l| !l.is_empty()),
            lane_id: lane_of(agent_id),
        });
    }

    /// A hook that runs mid-turn: the agent is working (so `agent.message` queues), and the apps hear `status`
    /// only when it changed - not on every tool call.
    pub fn busy(&self, agent_id: &str, kind: &str, name: &str, status: &str) {
        self.mailbox.working(agent_id, name);
        if self.mailbox.shown(agent_id, status) {
            self.events.agent_status(AgentStatus {
                agent_id: agent_id.to_string(),
                kind: kind.to_string(),
                name: name.to_string(),
                connection: "hooked".to_string(),
                status: status.to_string(),
                last_line: None,
                lane_id: lane_of(agent_id),
            });
        }
    }
}

/// The lane an agent runs in: Codex and Cursor key an agent started in a lane as `lane:<lane id>`
/// (`codex::agent_id`, `cursor::agent_id`).
pub fn lane_of(agent_id: &str) -> Option<String> {
    agent_id
        .strip_prefix("lane:")
        .filter(|lane| !lane.is_empty())
        .map(str::to_string)
}

/// Every agent's queue and open reply window, by agent id.
#[derive(Default)]
pub struct Mailbox {
    agents: Mutex<HashMap<String, Slot>>,
}

#[derive(Default)]
struct Slot {
    /// What the dock calls it, for the `unsupported` sentence.
    name: String,
    /// A hook has run since the last `Stop`: the agent is mid-turn and a message can wait for its next `Stop`.
    working: bool,
    /// The status the apps were last sent, so a tool call that changes nothing sends nothing.
    shown: String,
    queue: Vec<String>,
    waiting: Option<Waiting>,
    /// The agent's own process, which owns its terminal: the latest `console_pid` its hooks reported.
    console: Option<u32>,
}

/// A `Stop` hook holding its Done card open.
struct Waiting {
    card: CardId,
    message: Option<oneshot::Sender<String>>,
    opened: Instant,
    short: Duration,
    max: Duration,
    deadline: watch::Sender<Instant>,
}

/// One wait, from [`Mailbox::open`].
pub struct Window {
    message: oneshot::Receiver<String>,
    deadline: watch::Receiver<Instant>,
}

/// How a wait ended. Both empty: the window closed (or the card went away) with nothing to send.
#[derive(Debug, Default)]
pub struct Ended {
    /// The card's own answer: a typed reply, or an option.
    pub answer: Option<Answer>,
    /// An `agent.message` that resolved the wait, or arrived in the same instant as the answer.
    pub message: Option<String>,
}

impl Mailbox {
    /// A hook ran mid-turn. True when the agent was not already marked working, so the caller knows to publish
    /// `agent.status`.
    pub fn working(&self, agent_id: &str, name: &str) -> bool {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.entry(agent_id.to_string()).or_default();
        slot.name = name.to_string();
        !std::mem::replace(&mut slot.working, true)
    }

    /// Record `status` as what the apps were sent. True when it differs from what they were sent before.
    pub fn shown(&self, agent_id: &str, status: &str) -> bool {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.entry(agent_id.to_string()).or_default();
        if slot.shown == status {
            return false;
        }
        slot.shown = status.to_string();
        true
    }

    /// The turn ended and nothing will carry it on. A queue survives this (it is only filled while working, so
    /// it can only be here if the last `Stop` never ran); the next `Stop` delivers it.
    pub fn idle(&self, agent_id: &str, name: &str) {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.entry(agent_id.to_string()).or_default();
        slot.name = name.to_string();
        slot.working = false;
    }

    /// The queued messages, joined by blank lines, and the queue emptied. Called first thing in every `Stop`:
    /// a Done card must not swallow a message the user sent while the agent worked.
    pub fn take_queued(&self, agent_id: &str) -> Option<String> {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.get_mut(agent_id)?;
        if slot.queue.is_empty() {
            return None;
        }
        // The agent carries on: it is working again until its next `Stop`.
        slot.working = true;
        Some(std::mem::take(&mut slot.queue).join("\n\n"))
    }

    /// A `Stop` hook is about to wait on `card`. The wait lasts `short` unless `inbox.hold` stretches it, never
    /// past `max`. A message queued since `take_queued` is handed over at once.
    pub fn open(
        &self,
        agent_id: &str,
        name: &str,
        card: CardId,
        short: Duration,
        max: Duration,
    ) -> Window {
        let (tx, rx) = oneshot::channel();
        let opened = Instant::now();
        let (deadline, deadline_rx) = watch::channel(opened + short);
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.entry(agent_id.to_string()).or_default();
        slot.name = name.to_string();
        slot.working = false;
        let mut message = Some(tx);
        if !slot.queue.is_empty() {
            let text = std::mem::take(&mut slot.queue).join("\n\n");
            if let Some(tx) = message.take() {
                let _ = tx.send(text);
            }
        }
        slot.waiting = Some(Waiting {
            card,
            message,
            opened,
            short,
            max: max.max(short),
            deadline,
        });
        Window {
            message: rx,
            deadline: deadline_rx,
        }
    }

    /// The wait on `card` is over. A later wait for the same agent is left alone.
    pub fn close(&self, agent_id: &str, card: CardId) {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = agents.get_mut(agent_id)
            && slot.waiting.as_ref().is_some_and(|w| w.card == card)
        {
            slot.waiting = None;
        }
    }

    /// The agent is carrying on after its `Stop` (a reply or a queued message was delivered).
    pub fn resumed(&self, agent_id: &str) {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = agents.get_mut(agent_id) {
            slot.working = true;
        }
    }

    /// `agent.message`: deliver now, queue, or say why neither is possible.
    pub fn offer(&self, agent_id: &str, text: &str) -> (Delivery, String) {
        let text = text.trim();
        if text.is_empty() {
            return (Delivery::Unsupported, "There is nothing to send.".into());
        }
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let Some(slot) = agents.get_mut(agent_id) else {
            return (
                Delivery::Unsupported,
                "Mewndo has not heard from that agent through its hooks, so it can't reach it. Use a lane."
                    .into(),
            );
        };
        let name = if slot.name.is_empty() {
            "That agent".to_string()
        } else {
            slot.name.clone()
        };
        if let Some(waiting) = slot.waiting.as_mut()
            && let Some(tx) = waiting.message.take()
        {
            match tx.send(text.to_string()) {
                Ok(()) => {
                    // It carries on, so anything sent after this waits for its next `Stop`.
                    slot.working = true;
                    return (Delivery::Now, format!("Sent to {name}; it carries on now."));
                }
                // The wait ended in this same instant: fall through and queue it for the next `Stop`.
                Err(_) => slot.working = true,
            }
        }
        if slot.working {
            let used: usize = slot.queue.iter().map(|q| q.chars().count() + 2).sum();
            let room = QUEUE_CAP.saturating_sub(used);
            if room == 0 {
                return (
                    Delivery::Unsupported,
                    format!(
                        "{name} already has {QUEUE_CAP} characters waiting; send this after it stops."
                    ),
                );
            }
            let kept: String = text.chars().take(room).collect();
            let cut = kept.chars().count() < text.chars().count();
            slot.queue.push(kept);
            let mut reason = format!("{name} is working; it gets this when it next stops.");
            if cut {
                reason.push_str(&format!(" Cut to fit the {QUEUE_CAP}-character limit."));
            }
            return (Delivery::Queued, reason);
        }
        (
            Delivery::Unsupported,
            format!(
                "{name} is idle at its prompt with no hook running, so Mewndo can't reach it. Type in its window, or start it in a lane."
            ),
        )
    }

    /// A hook reported the agent's own process (`hook.request`'s `console_pid`). The latest wins: an agent that
    /// restarted in another terminal is typed into there.
    pub fn console(&self, agent_id: &str, pid: u32) {
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        agents.entry(agent_id.to_string()).or_default().console = Some(pid);
    }

    /// The agent's name and terminal when it is idle at its prompt - no hook waiting, not mid-turn - and a hook
    /// reported its process: the one case where the core may offer to type into its terminal.
    pub fn idle_console(&self, agent_id: &str) -> Option<(String, u32)> {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let slot = agents.get(agent_id)?;
        if slot.working || slot.waiting.is_some() {
            return None;
        }
        let name = if slot.name.is_empty() {
            "That agent".to_string()
        } else {
            slot.name.clone()
        };
        Some((name, slot.console?))
    }

    /// `inbox.hold`: the user is in the card's reply box (`held`), or has left it. True when a waiting hook
    /// belongs to the card.
    pub fn hold(&self, card: &str, held: bool) -> bool {
        let agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let Some(waiting) = agents
            .values()
            .filter_map(|s| s.waiting.as_ref())
            .find(|w| w.card.to_string() == card)
        else {
            return false;
        };
        let until = if held {
            waiting.opened + waiting.max
        } else {
            // Back to the short window; if that has already passed, the wait ends now.
            (waiting.opened + waiting.short).max(Instant::now())
        };
        waiting.deadline.send_replace(until);
        true
    }
}

impl Window {
    /// Wait for the card's answer, a message, or the end of the window, whichever is first. A message that lands
    /// in the same instant as the answer is kept, not dropped.
    pub async fn wait(self, mut answer: oneshot::Receiver<Answer>) -> Ended {
        let Window {
            mut message,
            mut deadline,
        } = self;
        let mut ended = Ended::default();
        let mut deadline_live = true;
        loop {
            let until = *deadline.borrow_and_update();
            tokio::select! {
                biased;
                got = &mut message => {
                    ended.message = got.ok();
                    ended.answer = answer.try_recv().ok();
                    break;
                }
                got = &mut answer => {
                    ended.answer = got.ok();
                    ended.message = message.try_recv().ok();
                    break;
                }
                changed = deadline.changed(), if deadline_live => deadline_live = changed.is_ok(),
                _ = tokio::time::sleep_until(until) => {
                    if *deadline.borrow() <= Instant::now() {
                        ended.message = message.try_recv().ok();
                        break;
                    }
                }
            }
        }
        ended
    }
}

/// Two texts meant for the agent, in the order they were written.
pub fn join(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
        (a, b) => a.or(b),
    }
}

/// One option under "Next steps" on a Done card: the label the card shows and the text the agent is sent.
#[derive(Debug, Clone, PartialEq)]
pub struct NextStep {
    pub label: String,
    pub text: String,
}

/// Up to three next steps, from what the core really knows about the turn. A mismatch the Receipt found comes
/// first and a failing test run next; "Looks good" is never offered when either was found.
pub fn next_steps(send_back: Option<(&str, String)>, failing_test: Option<&str>) -> Vec<NextStep> {
    let mut steps = Vec::new();
    let troubled = send_back.is_some() || failing_test.is_some();
    if let Some((first, text)) = send_back {
        steps.push(NextStep {
            label: format!("Send back: {}", short(first, 48)),
            text,
        });
    }
    if let Some(command) = failing_test {
        steps.push(NextStep {
            label: "Fix the failing tests".into(),
            text: format!(
                "Fix the failing tests. The last run of `{}` did not pass.",
                short(command, 80)
            ),
        });
    }
    let defaults = [
        ("Looks good, carry on", !troubled),
        ("Run the tests", failing_test.is_none()),
        ("Summarize what you changed", true),
    ];
    for (label, offered) in defaults {
        if offered && steps.len() < MAX_NEXT_STEPS {
            steps.push(NextStep {
                label: label.into(),
                text: label.into(),
            });
        }
    }
    steps.truncate(MAX_NEXT_STEPS);
    steps
}

fn short(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let kept: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::Via;

    fn card() -> CardId {
        ulid::Ulid::new()
    }

    #[tokio::test]
    async fn a_message_resolves_a_waiting_stop_now() {
        let mailbox = Mailbox::default();
        let id = card();
        let window = mailbox.open(
            "a1",
            "Claude Code",
            id,
            Duration::from_secs(5),
            Duration::from_secs(9),
        );
        let (_answer_tx, answer) = oneshot::channel::<Answer>();
        let (delivered, reason) = mailbox.offer("a1", "  also fix the pricing test ");
        assert_eq!(delivered, Delivery::Now, "{reason}");
        let ended = window.wait(answer).await;
        assert_eq!(ended.message.as_deref(), Some("also fix the pricing test"));
        assert!(ended.answer.is_none());
    }

    #[tokio::test]
    async fn a_message_to_a_working_agent_queues_and_the_next_stop_takes_all_of_it() {
        let mailbox = Mailbox::default();
        assert!(
            mailbox.working("a1", "Codex"),
            "the first hook makes it working"
        );
        assert!(
            !mailbox.working("a1", "Codex"),
            "and the second changes nothing"
        );
        assert_eq!(mailbox.offer("a1", "one").0, Delivery::Queued);
        assert_eq!(mailbox.offer("a1", "two").0, Delivery::Queued);
        assert_eq!(mailbox.take_queued("a1").as_deref(), Some("one\n\ntwo"));
        assert_eq!(mailbox.take_queued("a1"), None, "delivered once, then gone");
    }

    #[tokio::test]
    async fn a_queue_that_fills_while_the_done_card_is_made_is_handed_over_at_once() {
        let mailbox = Mailbox::default();
        mailbox.working("a1", "Cursor");
        mailbox.offer("a1", "use the new API");
        // The `Stop` hook missed `take_queued` (the message arrived while Receipts ran), then opens its window.
        let window = mailbox.open(
            "a1",
            "Cursor",
            card(),
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        let (_tx, answer) = oneshot::channel::<Answer>();
        let started = std::time::Instant::now();
        let ended = window.wait(answer).await;
        assert_eq!(ended.message.as_deref(), Some("use the new API"));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "no waiting for the card"
        );
    }

    #[test]
    fn an_idle_or_unknown_agent_is_unsupported_with_a_reason() {
        let mailbox = Mailbox::default();
        let (delivered, reason) = mailbox.offer("nobody", "hi");
        assert_eq!(delivered, Delivery::Unsupported);
        assert!(reason.contains("lane"), "{reason}");
        mailbox.working("a1", "Claude Code");
        mailbox.idle("a1", "Claude Code");
        let (delivered, reason) = mailbox.offer("a1", "hi");
        assert_eq!(delivered, Delivery::Unsupported);
        assert!(reason.starts_with("Claude Code is idle"), "{reason}");
        assert_eq!(mailbox.offer("a1", "   ").0, Delivery::Unsupported);
    }

    #[tokio::test]
    async fn only_an_idle_agent_with_a_reported_terminal_has_a_console_to_type_into() {
        let mailbox = Mailbox::default();
        assert_eq!(mailbox.idle_console("a1"), None, "never heard of");
        mailbox.working("a1", "Claude Code");
        mailbox.console("a1", 40);
        assert_eq!(
            mailbox.idle_console("a1"),
            None,
            "mid-turn: a message queues"
        );
        mailbox.idle("a1", "Claude Code");
        assert_eq!(mailbox.idle_console("a1"), Some(("Claude Code".into(), 40)));
        mailbox.console("a1", 41);
        assert_eq!(
            mailbox.idle_console("a1"),
            Some(("Claude Code".into(), 41)),
            "the latest wins"
        );
        let id = card();
        let _window = mailbox.open(
            "a1",
            "Claude Code",
            id,
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        assert_eq!(mailbox.idle_console("a1"), None, "a hook is waiting: now");
        mailbox.close("a1", id);
        assert!(mailbox.idle_console("a1").is_some());
        mailbox.idle("a2", "Codex");
        assert_eq!(mailbox.idle_console("a2"), None, "no terminal reported");
    }

    #[test]
    fn the_queue_is_capped_and_says_so() {
        let mailbox = Mailbox::default();
        mailbox.working("a1", "Codex");
        let (delivered, reason) = mailbox.offer("a1", &"x".repeat(QUEUE_CAP + 50));
        assert_eq!(delivered, Delivery::Queued);
        assert!(reason.contains("Cut"), "{reason}");
        assert_eq!(mailbox.offer("a1", "more").0, Delivery::Unsupported, "full");
        assert_eq!(
            mailbox.take_queued("a1").unwrap().chars().count(),
            QUEUE_CAP
        );
    }

    #[tokio::test]
    async fn a_hold_stretches_the_window_to_its_most_and_releasing_it_ends_it() {
        let mailbox = Mailbox::default();
        let id = card();
        let window = mailbox.open(
            "a1",
            "Claude Code",
            id,
            Duration::from_millis(50),
            Duration::from_millis(400),
        );
        assert!(mailbox.hold(&id.to_string(), true));
        assert!(
            !mailbox.hold(&card().to_string(), true),
            "no hook waits on that card"
        );
        let (_tx, answer) = oneshot::channel::<Answer>();
        let started = std::time::Instant::now();
        let ended = window.wait(answer).await;
        let waited = started.elapsed();
        assert!(ended.answer.is_none() && ended.message.is_none());
        assert!(
            waited >= Duration::from_millis(350),
            "the hold kept it open: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(3),
            "and never past its most: {waited:?}"
        );

        // Released: back to the short window, which here has already passed, so the wait ends.
        let id = card();
        let window = mailbox.open(
            "a2",
            "Cursor",
            id,
            Duration::from_millis(50),
            Duration::from_secs(30),
        );
        mailbox.hold(&id.to_string(), true);
        let (_tx, answer) = oneshot::channel::<Answer>();
        let waiting = tokio::spawn(window.wait(answer));
        tokio::time::sleep(Duration::from_millis(150)).await;
        let started = std::time::Instant::now();
        mailbox.hold(&id.to_string(), false);
        waiting.await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn the_cards_own_answer_ends_the_wait_and_keeps_a_message_from_the_same_instant() {
        let mailbox = Mailbox::default();
        let id = card();
        let window = mailbox.open(
            "a1",
            "Claude Code",
            id,
            Duration::from_secs(5),
            Duration::from_secs(5),
        );
        let (answer_tx, answer) = oneshot::channel::<Answer>();
        answer_tx
            .send(mewndo_inbox::text(id, "ship it", Via::Key))
            .unwrap();
        assert_eq!(mailbox.offer("a1", "and tag it").0, Delivery::Now);
        let ended = window.wait(answer).await;
        // Both arrived: neither is dropped.
        assert_eq!(ended.message.as_deref(), Some("and tag it"));
        assert_eq!(
            ended.answer.and_then(|a| a.text).as_deref(),
            Some("ship it")
        );
        mailbox.close("a1", id);
        assert_eq!(
            join(Some("ship it".into()), Some("and tag it".into())).as_deref(),
            Some("ship it\n\nand tag it")
        );
    }

    #[test]
    fn next_steps_say_only_what_the_core_knows() {
        let labels = |steps: Vec<NextStep>| steps.into_iter().map(|s| s.label).collect::<Vec<_>>();
        assert_eq!(
            labels(next_steps(None, None)),
            [
                "Looks good, carry on",
                "Run the tests",
                "Summarize what you changed"
            ]
        );
        let steps = next_steps(None, Some("npm test"));
        assert_eq!(
            labels(steps.clone()),
            ["Fix the failing tests", "Summarize what you changed"]
        );
        assert!(steps[0].text.contains("`npm test`"));
        let steps = next_steps(
            Some((
                "Says it edited src/date.ts · no tool call this turn changed that file",
                "full send-back".into(),
            )),
            Some("npm test"),
        );
        assert_eq!(steps.len(), 3);
        assert!(
            steps[0]
                .label
                .starts_with("Send back: Says it edited src/date.ts"),
            "{}",
            steps[0].label
        );
        assert!(steps[0].label.chars().count() <= "Send back: ".len() + 48);
        assert_eq!(steps[0].text, "full send-back");
        assert_eq!(steps[1].label, "Fix the failing tests");
        assert!(
            steps.iter().all(|s| s.label != "Looks good, carry on"),
            "never with a problem found"
        );
    }
}
