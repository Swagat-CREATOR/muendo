// Guarded computer use, the core's half (spec §36.4, §36.6 U5): the answer to every `computer.action` a
// mewndo-computer proxy sends before it lets cua-driver touch the desktop.
//
//   computer use off (the default)    -> deny "computer use is off"
//   the user took over (U6)           -> deny until they choose Resume
//   a read (classify.rs)              -> allow, no card
//   an act                            -> the Router's rules (a private window, a "Send" button), then a card,
//                                        and the user's answer is the verdict
//
// Every act asks the user. The Router alone never allows one: it sees the tool and its redacted arguments, not
// what is under the pointer, because the UI Automation lookup of §36.6 U5.3 is not built. A rule can still deny
// outright, and a habit (three identical "allow"s, §34.7) is offered like any other.
//
// An allowed act at a point also moves Mewndo's agent cursor there (U7, mewndo-overlay), labelled with who is acting
// and how ("Claude · clicking"). The overlay starts with computer use and only then.
//
// What it can't do (CLAUDE.md rule 5): no screenshot crop on the card (U5.5) and no element name, so the card
// says "click at 412, 230", not "click Send in Outlook"; and typed text is shown as its length only (redact.rs
// in mewndo-computer), because nothing here can tell a password field from any other.
use crate::desk_agents::Publisher;
use crate::log::Log;
use mewndo_computer::classify::{Class, classify};
use mewndo_computer::hooks::Takeover;
use mewndo_inbox::{Answer, Card, Inbox, Opt, PermissionFacts};
use mewndo_proto::{ComputerAction, ComputerPause, ComputerResume, ComputerVerdict, Verdict};
use mewndo_router::{GuardInput, Mode, Router};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// How long a computer-use card waits for the user. The proxy waits a little longer (link.rs, 290 s), so it is the
/// card that expires first and the user is never left answering a question nobody is waiting for.
pub const CARD_WAIT: Duration = Duration::from_secs(280);

pub const OFF: &str = "computer use is off. The user can switch it on in Mewndo's settings.";
pub const PAUSED: &str = "the user took over the mouse or keyboard. Wait until they choose Resume in Mewndo, then try again.";

pub struct ComputerGate {
    enabled: AtomicBool,
    router: Arc<Router>,
    inbox: Inbox,
    log: Arc<Log>,
    wait: Duration,
    takeover: Arc<Takeover>,
    publisher: Publisher,
    /// The agent cursor (U7). Set when computer use is switched on.
    overlay: OnceLock<mewndo_overlay::Overlay>,
}

fn allow() -> ComputerVerdict {
    ComputerVerdict {
        verdict: Verdict::Allow,
        reason: None,
    }
}

fn deny(reason: impl Into<String>) -> ComputerVerdict {
    ComputerVerdict {
        verdict: Verdict::Deny,
        reason: Some(reason.into()),
    }
}

impl ComputerGate {
    pub fn new(
        router: Arc<Router>,
        inbox: Inbox,
        publisher: Publisher,
        log: Arc<Log>,
    ) -> ComputerGate {
        ComputerGate {
            enabled: AtomicBool::new(false),
            router,
            inbox,
            log,
            wait: CARD_WAIT,
            takeover: Arc::default(),
            publisher,
            overlay: OnceLock::new(),
        }
    }

    /// The user's own input (U6): pauses every act if an agent was acting, and tells the apps once.
    pub fn human_input(&self) {
        if self.takeover.human_input(std::time::Instant::now()) {
            self.log
                .info("computer use paused: the user took over the mouse or keyboard");
            self.publisher.send(&ComputerPause {
                sessions: Vec::new(),
            });
        }
    }

    /// The user chose Resume (`computer.resume` from the app).
    pub fn resume(&self) {
        self.takeover.resume();
        self.log.info("computer use resumed");
        self.publisher.send(&ComputerResume {
            sessions: Vec::new(),
        });
    }

    #[cfg(test)]
    pub fn waiting(mut self, wait: Duration) -> ComputerGate {
        self.wait = wait;
        self
    }

    /// `--computer-use`: the app passes it only when the user has switched computer use on. Off by default.
    /// Also installs the takeover hooks (U6), `gate` being this gate shared with the hook thread, and starts the
    /// agent cursor (U7).
    pub fn enable(gate: &Arc<ComputerGate>) {
        gate.enabled.store(true, Ordering::SeqCst);
        gate.log.info("computer use is on");
        let weak = Arc::downgrade(gate);
        if let Err(e) = mewndo_computer::hooks::start(move |_input| {
            if let Some(gate) = weak.upgrade() {
                gate.human_input();
            }
        }) {
            // Without the hooks there is no takeover, so computer use stays off rather than run unwatched.
            gate.enabled.store(false, Ordering::SeqCst);
            gate.log.warn(&format!(
                "computer use stays off: the takeover hooks did not start: {e}"
            ));
            return;
        }
        match mewndo_overlay::Overlay::start() {
            Ok(overlay) => {
                let _ = gate.overlay.set(overlay);
            }
            // The driver's own cursor is switched off (U8), so without this one the user could not see where the
            // agent acts. Computer use stays off rather than run unseen.
            Err(e) => {
                gate.enabled.store(false, Ordering::SeqCst);
                gate.log.warn(&format!(
                    "computer use stays off: the agent cursor did not start: {e}"
                ));
            }
        }
    }

    #[cfg(test)]
    pub fn with_overlay(&self) -> std::sync::mpsc::Receiver<mewndo_overlay::Show> {
        let (overlay, shown) = mewndo_overlay::Overlay::channel();
        let _ = self.overlay.set(overlay);
        shown
    }

    #[cfg(test)]
    pub fn enable_without_hooks(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub async fn decide(&self, action: &ComputerAction) -> ComputerVerdict {
        if !self.enabled() {
            return deny(OFF);
        }
        if self.takeover.paused() {
            return deny(PAUSED);
        }
        let verdict = match classify(&action.tool) {
            Class::Read => allow(),
            Class::Hidden => deny(format!("{} is Mewndo's own setting", action.tool)),
            Class::Act => self.act(action).await,
        };
        if verdict.verdict == Verdict::Allow && classify(&action.tool) == Class::Act {
            self.show_cursor(action);
        }
        // What the agent did, never what it typed: args_redacted is already redacted by the proxy.
        self.log.info(&format!(
            "computer: {} {} -> {:?}{}",
            agent_name(action),
            what(action),
            verdict.verdict,
            verdict
                .reason
                .as_deref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        ));
        verdict
    }

    async fn act(&self, action: &ComputerAction) -> ComputerVerdict {
        let what = what(action);
        let agent = agent_name(action);
        let guarded = self.router.guard(&GuardInput {
            agent_kind: agent.clone(),
            tool: "computer".into(),
            input: json!({ "action": action.tool, "name": what }),
            cwd: PathBuf::new(),
            brief: String::new(),
            project: "desktop".into(),
            recent: Vec::new(),
            mode: Mode::Shadow,
        });
        if matches!(
            guarded.decision.verdict,
            mewndo_router::Verdict::Deny | mewndo_router::Verdict::Brake
        ) {
            return deny(guarded.decision.reason);
        }
        let mut card = Card::permission(
            format!("computer:{}", action.session),
            format!("{} wants to {what}", title_case(&agent)),
            "Computer use. Mewndo can't see what is under the pointer yet,\nso look at the app before you allow it.",
            crate::agents::risk_of(&guarded).max(3),
            PermissionFacts {
                agent_kind: agent,
                project: "desktop".into(),
                action_sig: guarded.sig,
                command_norm: guarded.action.command_norm.clone(),
            },
        );
        card.deadline = Some(self.wait);
        let options = card.options.clone();
        let (_, answer) = self.inbox.create(card).await;
        match tokio::time::timeout(self.wait, answer).await {
            Ok(Ok(answer)) => match verdict_of(&options, &answer) {
                // The user may have taken over while the card was up.
                Some(v) if v.allows() && self.takeover.paused() => deny(PAUSED),
                Some(v) if v.allows() => {
                    self.takeover.acting(std::time::Instant::now());
                    allow()
                }
                Some(_) => deny(said_no(&answer)),
                None => deny("the user did not allow it"),
            },
            Ok(Err(_)) | Err(_) => deny("nobody answered in time"),
        }
    }
}

impl ComputerGate {
    /// U7: an allowed act at a point moves the agent cursor there. An act with no point, or a target the overlay
    /// cannot place (mewndo-overlay coords.rs), moves nothing. When the proxy could not switch cua-driver's own
    /// cursor off (U8), only the label chip is drawn, beside it.
    fn show_cursor(&self, action: &ComputerAction) {
        let (Some(overlay), Some(p)) = (self.overlay.get(), action.point) else {
            return;
        };
        let Some(target) = mewndo_overlay::coords::Target::from_args(&action.args_redacted) else {
            return;
        };
        overlay.show(mewndo_overlay::Show {
            at: mewndo_overlay::coords::Px::new(p.x as f64, p.y as f64),
            target,
            label: doing(action),
            arrow: !action.driver_cursor,
        });
    }
}

/// The agent cursor's label: "Claude · clicking".
fn doing(action: &ComputerAction) -> String {
    let args = &action.args_redacted;
    let verb = match action.tool.as_str() {
        "click" => match (
            args.get("button").and_then(Value::as_str),
            args.get("count").and_then(Value::as_u64),
        ) {
            (Some("right"), _) => "right-clicking".to_string(),
            (_, Some(2)) => "double-clicking".to_string(),
            _ => "clicking".to_string(),
        },
        "scroll" => "scrolling".to_string(),
        "move_cursor" => "moving the pointer".to_string(),
        other => other.replace('_', " "),
    };
    format!("{} · {verb}", title_case(&agent_name(action)))
}

fn verdict_of(options: &[Opt], answer: &Answer) -> Option<mewndo_router::Verdict> {
    options.get(answer.choice?).and_then(|o| o.answer)
}

fn said_no(answer: &Answer) -> String {
    match answer
        .text
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        Some(reason) => format!("the user said no: {reason}"),
        None => "the user said no".into(),
    }
}

fn agent_name(action: &ComputerAction) -> String {
    if action.agent.trim().is_empty() {
        "an agent".into()
    } else {
        action.agent.trim().to_string()
    }
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The card's words for one act: "click at 412, 230", "type <12 characters>", "press Enter".
pub fn what(action: &ComputerAction) -> String {
    let args = &action.args_redacted;
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    let at = action
        .point
        .map(|p| format!(" at {}, {}", p.x, p.y))
        .unwrap_or_default();
    match action.tool.as_str() {
        "click" => {
            let how = match (s("button"), args.get("count").and_then(Value::as_u64)) {
                (Some("right"), _) => "right-click",
                (_, Some(2)) => "double-click",
                _ => "click",
            };
            match (at.is_empty(), s("element_token")) {
                (true, Some(_)) => format!("{how} an element it picked"),
                _ => format!("{how}{at}"),
            }
        }
        "type_text" => format!("type {}", s("text").unwrap_or("text")),
        "press_key" => format!("press {}", s("key").unwrap_or("a key")),
        "hotkey" => {
            let keys: Vec<&str> = args
                .get("keys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!(
                "press {}",
                if keys.is_empty() {
                    "a shortcut".into()
                } else {
                    keys.join("+")
                }
            )
        }
        "scroll" => format!("scroll{at}"),
        "drag" => "drag the pointer".into(),
        "move_cursor" => format!("move the pointer{at}"),
        "clipboard_read" => "read the clipboard".into(),
        "clipboard_write" => format!("put {} on the clipboard", s("text").unwrap_or("text")),
        "invoke_menu" => {
            let path: Vec<&str> = args
                .get("path")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!("choose {} from a menu", path.join(" > "))
        }
        "set_window_frame" => "move or resize a window".into(),
        other => other.replace('_', " "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_inbox::{Config, Deps, Event};
    use mewndo_proto::Point;

    fn gate(name: &str) -> (ComputerGate, Inbox) {
        let d = std::env::temp_dir().join(format!(
            "mewndo-computer-gate-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        let log = Arc::new(Log::new(&d.join("logs")));
        let router = Arc::new(Router::default());
        let inbox = Inbox::start(
            Config {
                grace: Duration::ZERO,
                ..Config::default()
            },
            Deps::default(),
        );
        let publisher = Publisher(tokio::sync::broadcast::channel(16).0);
        (
            ComputerGate::new(router, inbox.clone(), publisher, log),
            inbox,
        )
    }

    fn act(tool: &str, args: Value, point: Option<Point>) -> ComputerAction {
        ComputerAction {
            session: "mewndo-claude-1".into(),
            tool: tool.into(),
            args_redacted: args,
            point,
            agent: "claude".into(),
            driver_cursor: false,
        }
    }

    #[tokio::test]
    async fn off_by_default_and_reads_need_no_card() {
        let (gate, _) = gate("off");
        let read = act("get_desktop_state", json!({}), None);
        assert_eq!(gate.decide(&read).await, deny(OFF), "off: not even a look");
        gate.enable_without_hooks();
        assert_eq!(gate.decide(&read).await, allow());
        assert_eq!(
            gate.decide(&act("set_agent_cursor_enabled", json!({}), None))
                .await
                .verdict,
            Verdict::Deny
        );
    }

    #[tokio::test]
    async fn an_act_is_a_card_and_the_users_answer_is_the_verdict() {
        let (gate, inbox) = gate("card");
        gate.enable_without_hooks();
        let gate = Arc::new(gate);
        let mut events = inbox.subscribe();
        let ask = |g: Arc<ComputerGate>| {
            tokio::spawn(async move {
                g.decide(&act("type_text", json!({"text": "<12 characters>"}), None))
                    .await
            })
        };

        for (choice, text, want) in [
            (Some(0), None, allow()),
            (Some(2), None, deny("the user said no")),
            (
                Some(2),
                Some("wrong window"),
                deny("the user said no: wrong window"),
            ),
        ] {
            let waiting = ask(gate.clone());
            let card = loop {
                if let Event::Card(card) = events.recv().await.unwrap() {
                    break card;
                }
            };
            assert_eq!(card.title, "Claude wants to type <12 characters>");
            assert_eq!(
                card.options[..3],
                ["Allow once", "Always allow here", "Deny"]
            );
            inbox
                .answer(
                    card.id.parse().unwrap(),
                    Answer {
                        card_id: card.id.clone(),
                        choice,
                        text: text.map(str::to_string),
                        via: mewndo_proto::Via::Key,
                    },
                )
                .await;
            assert_eq!(waiting.await.unwrap(), want);
        }
    }

    #[tokio::test]
    async fn nobody_answering_is_a_refusal() {
        let (gate, _) = gate("timeout");
        let gate = gate.waiting(Duration::from_millis(50));
        gate.enable_without_hooks();
        assert_eq!(
            gate.decide(&act(
                "click",
                json!({"x": 1, "y": 2}),
                Some(Point { x: 1, y: 2 })
            ))
            .await,
            deny("nobody answered in time")
        );
    }

    #[tokio::test]
    async fn after_a_takeover_every_act_is_refused_until_resume() {
        let (gate, inbox) = gate("takeover");
        gate.enable_without_hooks();
        let gate = Arc::new(gate);
        let mut events = inbox.subscribe();
        // The user's input before any act: just using their computer.
        gate.human_input();
        let waiting = tokio::spawn({
            let g = gate.clone();
            async move {
                g.decide(&act("press_key", json!({"key": "Enter"}), None))
                    .await
            }
        });
        let card = loop {
            if let Event::Card(card) = events.recv().await.unwrap() {
                break card;
            }
        };
        inbox
            .answer(
                card.id.parse().unwrap(),
                Answer {
                    card_id: card.id.clone(),
                    choice: Some(0),
                    text: None,
                    via: mewndo_proto::Via::Key,
                },
            )
            .await;
        assert_eq!(waiting.await.unwrap(), allow());
        gate.human_input();
        let read = act("get_screen_size", json!({}), None);
        assert_eq!(
            gate.decide(&read).await,
            deny(PAUSED),
            "reads too: the user has the computer"
        );
        gate.resume();
        assert_eq!(gate.decide(&read).await, allow());
    }

    /// Puts `action` to the gate and answers its card with `choice`.
    async fn answered(
        gate: &Arc<ComputerGate>,
        inbox: &Inbox,
        action: ComputerAction,
        choice: usize,
    ) -> ComputerVerdict {
        let mut events = inbox.subscribe();
        let waiting = tokio::spawn({
            let g = gate.clone();
            async move { g.decide(&action).await }
        });
        let card = loop {
            if let Event::Card(card) = events.recv().await.unwrap() {
                break card;
            }
        };
        inbox
            .answer(
                card.id.parse().unwrap(),
                Answer {
                    card_id: card.id.clone(),
                    choice: Some(choice),
                    text: None,
                    via: mewndo_proto::Via::Key,
                },
            )
            .await;
        waiting.await.unwrap()
    }

    #[tokio::test]
    async fn an_allowed_act_at_a_point_moves_the_agent_cursor_and_nothing_else_does() {
        let (gate, inbox) = gate("cursor");
        gate.enable_without_hooks();
        let shown = gate.with_overlay();
        let gate = Arc::new(gate);
        let window = json!({"kind": "window", "pid": 6004, "window_id": 131_844});
        let at = Some(Point { x: 412, y: 230 });

        let click = act("click", json!({"x": 412, "y": 230, "target": window}), at);
        assert_eq!(answered(&gate, &inbox, click, 0).await, allow());
        assert_eq!(
            shown.try_recv().unwrap(),
            mewndo_overlay::Show {
                at: mewndo_overlay::coords::Px::new(412.0, 230.0),
                target: mewndo_overlay::coords::Target::Window {
                    pid: 6004,
                    window_id: 131_844
                },
                label: "Claude · clicking".into(),
                arrow: true,
            }
        );

        // The proxy could not switch cua-driver's cursor off (U8): the label chip only, beside the driver's.
        let mut beside = act(
            "scroll",
            json!({"x": 9, "y": 8, "target": window}),
            Some(Point { x: 9, y: 8 }),
        );
        beside.driver_cursor = true;
        assert_eq!(answered(&gate, &inbox, beside, 0).await, allow());
        let chip = shown.try_recv().unwrap();
        assert_eq!(
            (chip.label.as_str(), chip.arrow),
            ("Claude · scrolling", false)
        );

        // Denied: the cursor stays where it was.
        let right = act(
            "click",
            json!({"x": 1, "y": 2, "button": "right", "target": window}),
            Some(Point { x: 1, y: 2 }),
        );
        assert_eq!(
            answered(&gate, &inbox, right, 2).await.verdict,
            Verdict::Deny
        );
        // Allowed, but no point (typing), or no target to place the point by.
        let typing = act("type_text", json!({"text": "<5 characters>"}), None);
        assert_eq!(answered(&gate, &inbox, typing, 0).await, allow());
        let untargeted = act("click", json!({"x": 1, "y": 2}), Some(Point { x: 1, y: 2 }));
        assert_eq!(answered(&gate, &inbox, untargeted, 0).await, allow());
        // A read never moves it, even with a point.
        let read = act(
            "get_window_state",
            json!({"x": 1, "y": 2, "target": window}),
            Some(Point { x: 1, y: 2 }),
        );
        assert_eq!(gate.decide(&read).await, allow());
        assert!(
            shown.try_recv().is_err(),
            "only the allowed, placed act moved it"
        );
    }

    #[test]
    fn the_cursors_words() {
        let p = Some(Point { x: 1, y: 2 });
        assert_eq!(doing(&act("click", json!({}), p)), "Claude · clicking");
        assert_eq!(
            doing(&act("click", json!({"button": "right"}), p)),
            "Claude · right-clicking"
        );
        assert_eq!(
            doing(&act("click", json!({"count": 2}), p)),
            "Claude · double-clicking"
        );
        assert_eq!(doing(&act("scroll", json!({}), p)), "Claude · scrolling");
        let mut nameless = act("move_cursor", json!({}), p);
        nameless.agent = " ".into();
        assert_eq!(doing(&nameless), "An agent · moving the pointer");
    }

    #[test]
    fn the_cards_words() {
        let p = Some(Point { x: 412, y: 230 });
        assert_eq!(
            what(&act("click", json!({"x": 412, "y": 230}), p)),
            "click at 412, 230"
        );
        assert_eq!(
            what(&act("click", json!({"button": "right"}), p)),
            "right-click at 412, 230"
        );
        assert_eq!(
            what(&act("click", json!({"count": 2}), p)),
            "double-click at 412, 230"
        );
        assert_eq!(
            what(&act(
                "click",
                json!({"element_token": "s0000002a:22"}),
                None
            )),
            "click an element it picked"
        );
        assert_eq!(
            what(&act("press_key", json!({"key": "Enter"}), None)),
            "press Enter"
        );
        assert_eq!(
            what(&act(
                "hotkey",
                json!({"keys": ["ctrl", "<1 character>"]}),
                None
            )),
            "press ctrl+<1 character>"
        );
        assert_eq!(
            what(&act(
                "invoke_menu",
                json!({"path": ["File", "Save As"]}),
                None
            )),
            "choose File > Save As from a menu"
        );
        assert_eq!(
            what(&act("escalate_session", json!({}), None)),
            "escalate session"
        );
    }
}
