// What the Agent Desk pipe does with its messages (spec §33.10 Parts C, D, F and H): one Router, one Inbox and the
// three agent handlers, built once per core, and the glue between them and desk.rs.
//
//   hook.request (hook)   -> the agent's handler -> hook.response
//   inbox.answer (app)    -> the Inbox            -> the handler waiting on that card
//   inbox.undo   (app)    -> the Inbox            -> inbox.undo back to the app, which restores through v0 (§23.3)
//   route.request (app)   -> the Router            -> route.result
//   Inbox events, agent.status, spans and receipts -> every connected app
//
// The 2-second grace runs in the app (apps/desktop/app/desk/cards.js): §38.5 has no message for Esc, so the answer
// is held there and only sent once it can no longer be taken back. The core's Inbox therefore releases at once,
// and the cards it sends still carry the 2 s the app's bar drains over.
use crate::agents::claude::{self, Claude};
use crate::agents::{codex, codex::Codex, cursor, cursor::Cursor};
use crate::engine_client::V0Engine;
use crate::log::Log;
use crate::writer::Writer;
use mewndo_inbox::{CardWriter, Config, Event, HabitRecorder, Inbox};
use mewndo_proto::{
    AgentStatus, Body, BudgetState, Envelope, Frame, HookRequest, HookResponse, InboxAnswer,
    InboxCard, InboxExpired, InboxRelease, InboxUndo, ReceiptResult, RouteResult, SpanCreated,
};
use mewndo_router::Router;
use mewndo_router::habits::HabitRequest;
use mewndo_router::voice::{LiveAgent, RouteChoice};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// The grace the app's bar drains over (§33.4).
pub const APP_GRACE: Duration = Duration::from_secs(2);

/// Sends a message to every connected app.
#[derive(Clone)]
pub struct Publisher(pub broadcast::Sender<Arc<Vec<u8>>>);

impl Publisher {
    pub fn send<B: Body>(&self, body: &B) {
        let env = Envelope::wrap(ulid::Ulid::new().to_string(), body);
        if let Ok(bytes) = mewndo_proto::encode(&Frame::Json(env)) {
            let _ = self.0.send(Arc::new(bytes)); // no app connected: nothing to do
        }
    }
}

type Live = Arc<Mutex<HashMap<String, AgentStatus>>>;

/// Habit cards on screen, by card id: what "yes" on each one would write (§34.7).
type HabitCards = Arc<Mutex<HashMap<String, (InboxCard, HabitRequest)>>>;

/// The handlers' own events, to the apps; agent.status also keeps the list voice routing chooses from.
struct AppEvents {
    publisher: Publisher,
    live: Live,
}

impl claude::Events for AppEvents {
    fn agent_status(&self, status: AgentStatus) {
        self.live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(status.agent_id.clone(), status.clone());
        self.publisher.send(&status);
    }
    fn span(&self, span: SpanCreated) {
        self.publisher.send(&span);
    }
    fn receipt(&self, receipt: ReceiptResult) {
        self.publisher.send(&receipt);
    }
}

/// Card rows go through desk.db's one writer (§33.10 Part D step 4).
struct CardRows(Arc<Writer>);

impl CardWriter for CardRows {
    fn write(&self, sql: &'static str, params: Vec<Value>) {
        self.0.write(sql, params);
    }
}

/// The Inbox counts answers into the core's one Router (§34.9 R11).
struct SharedHabits(Arc<Router>);

impl HabitRecorder for SharedHabits {
    fn record(
        &self,
        agent_kind: &str,
        project: &str,
        action_sig: mewndo_router::Sig,
        answer: mewndo_router::Verdict,
        command_norm: &str,
    ) -> Option<mewndo_router::habits::HabitRequest> {
        self.0
            .record_answer(agent_kind, project, action_sig, answer, command_norm)
    }
}

pub struct Agents {
    publisher: Publisher,
    /// What the apps were last told about the day's model budget (`budget.state`).
    rules_only: std::sync::atomic::AtomicBool,
    inbox: Inbox,
    router: Arc<Router>,
    engine: Arc<V0Engine>,
    habit_cards: HabitCards,
    /// Guarded computer use (§36.6 U5): the answer to every `computer.action`.
    computer: Arc<crate::computer::ComputerGate>,
    /// The user's rules.toml, where an accepted habit is written. None (tests, or a core started without
    /// `--rules`): a habit lasts until the core stops.
    rules_file: Option<PathBuf>,
    log: Arc<Log>,
    claude: Claude,
    codex: Codex,
    cursor: Cursor,
    live: Live,
}

impl Agents {
    /// `data_dir`: v0's data folder, where hook.json says how to reach its save points. `rules_file`: the user's
    /// rules.toml (§34.9 R1), read now and written when a Habit card is accepted.
    pub fn start(
        data_dir: PathBuf,
        rules_file: Option<PathBuf>,
        writer: Arc<Writer>,
        publisher: Publisher,
        log: Arc<Log>,
    ) -> Agents {
        // Built-in rules, and the gateway (§37) when it is configured (clef_gateway.rs): every agent starts in
        // shadow mode (§34.6), so the model is only ever advice. No URL or no device token is the rules alone.
        let clef = crate::clef_gateway::configured();
        if clef.is_some() {
            log.info("clef: gateway configured");
        }
        let rules = match rules_file.as_deref().map(crate::rules_file::load) {
            Some(Ok(rules)) => rules,
            Some(Err(e)) => {
                log.warn(&format!("rules.toml not used, built-in rules only: {e}"));
                mewndo_router::CompiledRules::builtin()
            }
            None => mewndo_router::CompiledRules::builtin(),
        };
        let router = Router::new(
            rules,
            clef.unwrap_or_else(|| Box::new(mewndo_router::clef::NoClef)),
            Box::new(mewndo_router::facts::NoFacts),
        );
        Agents::start_with(
            Arc::new(router),
            data_dir,
            rules_file,
            writer,
            publisher,
            log,
        )
    }

    pub fn start_with(
        router: Arc<Router>,
        data_dir: PathBuf,
        rules_file: Option<PathBuf>,
        writer: Arc<Writer>,
        publisher: Publisher,
        log: Arc<Log>,
    ) -> Agents {
        let engine = V0Engine::new(data_dir);
        let inbox = Inbox::start(
            Config {
                grace: Duration::ZERO,
                ..Config::default()
            },
            mewndo_inbox::Deps {
                writer: Box::new(CardRows(writer)),
                engine: engine.clone(),
                habits: Box::new(SharedHabits(router.clone())),
            },
        );
        let habit_cards: HabitCards = Arc::default();
        tokio::spawn(forward(
            inbox.subscribe(),
            publisher.clone(),
            log.clone(),
            habit_cards.clone(),
        ));
        let live: Live = Arc::default();
        let mut deps = claude::Deps::new(inbox.clone(), router.clone());
        deps.engine = engine.clone();
        deps.events = Arc::new(AppEvents {
            publisher: publisher.clone(),
            live: live.clone(),
        });
        let computer = Arc::new(crate::computer::ComputerGate::new(
            router.clone(),
            inbox.clone(),
            publisher.clone(),
            log.clone(),
        ));
        Agents {
            publisher,
            rules_only: Default::default(),
            claude: Claude::new(deps),
            codex: Codex::new(router.clone(), Some(inbox.clone())),
            cursor: Cursor::new(router.clone(), Some(inbox.clone())),
            inbox,
            router,
            engine,
            habit_cards,
            computer,
            rules_file,
            log,
            live,
        }
    }

    /// One agent hook. An agent this core has no handler for gets silence, which is what it would get with no
    /// Mewndo installed (§32.5 rule 7).
    pub async fn hook(&self, req: &HookRequest) -> HookResponse {
        let out = self.handle_hook(req).await;
        // A Guard call may have heard from the gateway that the day's budget is out, or that it is back.
        self.publish_budget_change();
        out
    }

    /// The day's model budget as the apps should show it.
    pub fn budget_state(&self) -> BudgetState {
        BudgetState {
            rules_only: self.router.rules_only(),
        }
    }

    fn publish_budget_change(&self) {
        let now = self.router.rules_only();
        if self
            .rules_only
            .swap(now, std::sync::atomic::Ordering::SeqCst)
            != now
        {
            self.publisher.send(&BudgetState { rules_only: now });
        }
    }

    async fn handle_hook(&self, req: &HookRequest) -> HookResponse {
        let cwd = req.cwd.as_deref().unwrap_or_default();
        match req.agent.as_str() {
            "claude" => self.claude.respond(req).await,
            "codex" => {
                self.engine.note(&codex::agent_id(req), "codex", cwd);
                self.codex.handle(req).await
            }
            "cursor" => {
                self.engine.note(&cursor::agent_id(req), "cursor", cwd);
                self.cursor.handle(req).await
            }
            _ => HookResponse {
                stdout: String::new(),
                exit_code: 0,
            },
        }
    }

    pub async fn answer(&self, answer: InboxAnswer) -> Result<(), String> {
        if let Some(habit) = self.take_habit(&answer.card_id) {
            return self.answer_habit(&answer, habit);
        }
        let id = answer
            .card_id
            .parse()
            .map_err(|_| format!("{} is not a card id", answer.card_id))?;
        if answer.choice.is_none() && answer.text.as_deref().is_none_or(str::is_empty) {
            return Err("an answer needs a choice or some text".into());
        }
        self.inbox.answer(id, answer).await;
        Ok(())
    }

    pub fn computer(&self) -> &Arc<crate::computer::ComputerGate> {
        &self.computer
    }

    fn take_habit(&self, card_id: &str) -> Option<(InboxCard, HabitRequest)> {
        self.habit_cards
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(card_id)
    }

    /// A Habit card's answer (§34.7): 1 yes, 2 no, 3 never ask, by key or by the option's own words.
    fn answer_habit(
        &self,
        answer: &InboxAnswer,
        (card, habit): (InboxCard, HabitRequest),
    ) -> Result<(), String> {
        let said = answer.text.as_deref().map(|t| t.trim().to_lowercase());
        let choice = answer.choice.or_else(|| {
            habit
                .options
                .iter()
                .position(|o| Some(o.as_str()) == said.as_deref())
        });
        match choice {
            Some(0) => {
                self.router
                    .habits
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .accept(&habit);
                match &self.rules_file {
                    Some(path) => match crate::rules_file::add_habit(
                        path,
                        &habit,
                        &crate::rules_file::today_utc(),
                    ) {
                        Ok(true) => self.log.info(&format!(
                            "habit written to rules.toml: {}",
                            habit.command_norm
                        )),
                        Ok(false) => self.log.info(&format!(
                            "habit already in rules.toml: {}",
                            habit.command_norm
                        )),
                        // The habit still holds until the core stops; the user's file is left as it was.
                        Err(e) => self.log.warn(&format!("habit not written: {e}")),
                    },
                    None => self
                        .log
                        .info("habit kept until the core stops (no rules.toml given)"),
                }
            }
            Some(1) => {}
            Some(2) => self
                .router
                .habits
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .mute(&habit),
            _ => {
                let card_id = answer.card_id.clone();
                self.habit_cards
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(card_id, (card, habit));
                return Err("a Habit card is answered with yes, no or never ask".into());
            }
        }
        self.publisher.send(&InboxRelease {
            card_id: answer.card_id.clone(),
            savepoint_id: None,
        });
        Ok(())
    }

    /// The Inbox sends `inbox.undo`, with the save point to restore to, to the apps itself.
    pub async fn undo(&self, undo: InboxUndo) -> Result<(), String> {
        let id = undo
            .card_id
            .parse()
            .map_err(|_| format!("{} is not a card id", undo.card_id))?;
        self.inbox
            .undo(id)
            .await
            .map(|_| ())
            .ok_or_else(|| "that card has no answer to undo".into())
    }

    /// The cards still waiting for the user, as `inbox.card`s: what an app that has just connected (or reconnected)
    /// needs, because the cards were published before it was listening.
    pub async fn open_cards(&self) -> Vec<mewndo_proto::InboxCard> {
        self.inbox
            .stack(usize::MAX)
            .await
            .cards
            .iter()
            .map(|card| card.to_proto(APP_GRACE))
            .chain(
                self.habit_cards
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .map(|(card, _)| card.clone()),
            )
            .collect()
    }

    /// §34.9 R12, with the keyword fallback while no model is configured.
    pub fn route(&self, text: &str) -> RouteResult {
        let live: Vec<LiveAgent> = {
            let statuses = self.live.lock().unwrap_or_else(|e| e.into_inner());
            statuses
                .values()
                .map(|s| LiveAgent {
                    id: s.agent_id.clone(),
                    name: s.name.clone(),
                    aliases: vec![s.kind.clone()],
                    cwd: self.engine.folder(&s.agent_id).unwrap_or_default().into(),
                    last_line: s.last_line.clone().unwrap_or_default(),
                })
                .collect()
        };
        let routed = self.router.route(text, &live, None);
        let target = |choice: &RouteChoice| match choice {
            RouteChoice::Agent(i) => live.get(*i).map(|a| a.id.clone()).unwrap_or_default(),
            RouteChoice::MewndoCommand => format!("mewndo:{}", command_in(text)),
            RouteChoice::NewAgent => "new-agent".to_string(),
        };
        RouteResult {
            target: target(&routed.choice),
            confidence: routed.confidence,
            alternatives: routed.runner_up.iter().map(target).collect(),
        }
    }
}

/// The §34.7 card: "Always allow `npm test` in shop?" with yes, no and never ask. It is kept until answered;
/// "yes" writes the rule (`Agents::answer_habit`).
fn habit_card(habit_cards: &HabitCards, habit: HabitRequest) -> InboxCard {
    let id = ulid::Ulid::new().to_string();
    let verb = if habit.answer.allows() {
        "allow"
    } else {
        "deny"
    };
    let card = InboxCard {
        id: id.clone(),
        kind: "habit".into(),
        agent_id: habit.agent_kind.clone(),
        title: habit.text.clone(),
        body: format!(
            "You gave this answer 3 times. Yes adds it to [{verb}] in rules.toml,\nwhich applies in every project after a restart."
        ),
        options: habit.options.to_vec(),
        risk: 0,
        thumb: None,
        grace_ms: APP_GRACE.as_millis() as u64,
    };
    habit_cards
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, (card.clone(), habit));
    card
}

/// Which of Mewndo's own commands (§23.3, §24) the words name; the app confirms it before anything runs.
fn command_in(text: &str) -> &'static str {
    let said = text.to_lowercase();
    ["undo", "brake", "stop", "freeze", "resume"]
        .into_iter()
        .find(|c| {
            said.split(|ch: char| !ch.is_alphanumeric())
                .any(|w| w == *c)
        })
        .unwrap_or("undo")
}

/// The Inbox's events, as §38.5 messages for the apps.
async fn forward(
    mut rx: broadcast::Receiver<Event>,
    publisher: Publisher,
    log: Arc<Log>,
    habit_cards: HabitCards,
) {
    loop {
        match rx.recv().await {
            Ok(Event::Card(mut card)) => {
                card.grace_ms = APP_GRACE.as_millis() as u64;
                publisher.send(&card);
            }
            Ok(Event::Release(release)) => publisher.send(&release),
            Ok(Event::Undo(undo)) => publisher.send(&undo),
            Ok(Event::Expired(card_id)) => publisher.send(&InboxExpired { card_id }),
            Ok(Event::Reopened(_)) => {} // Esc is handled in the app, which holds the grace
            Ok(Event::Habit(habit)) => publisher.send(&habit_card(&habit_cards, habit)),
            Err(broadcast::error::RecvError::Lagged(n)) => {
                log.warn(&format!("desk: {n} Inbox events were dropped"))
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_proto::{InboxCard, InboxRelease, Via};
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mewndo-agents-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn start(name: &str) -> (Agents, broadcast::Receiver<Arc<Vec<u8>>>) {
        let d = temp(name);
        let log = Arc::new(Log::new(&d.join("logs")));
        let writer = Arc::new(crate::writer::start(&d.join("desk.db"), log.clone()));
        let (tx, rx) = broadcast::channel(64);
        (
            Agents::start(d.join("v0"), None, writer, Publisher(tx), log),
            rx,
        )
    }

    async fn next<B: Body>(rx: &mut broadcast::Receiver<Arc<Vec<u8>>>) -> B {
        loop {
            let bytes = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            let Some((Frame::Json(env), _)) = mewndo_proto::decode(&bytes).unwrap() else {
                panic!("not json")
            };
            if env.kind == B::TYPE {
                return env.open().unwrap();
            }
        }
    }

    fn hook(agent: &str, event: &str, payload: Value) -> HookRequest {
        HookRequest {
            agent: agent.into(),
            event: event.into(),
            session_id: None,
            pid: None,
            cwd: payload["cwd"].as_str().map(str::to_string),
            lane_id: None,
            payload,
        }
    }

    fn permission(command: &str) -> Value {
        json!({
            "session_id": "s1", "cwd": "/work/shop", "hook_event_name": "PermissionRequest",
            "tool_name": "Bash", "tool_input": {"command": command}
        })
    }

    #[tokio::test]
    async fn a_claude_permission_becomes_a_card_and_the_apps_answer_reaches_the_hook() {
        let (agents, mut rx) = start("permission");
        let agents = Arc::new(agents);
        let waiting = tokio::spawn({
            let agents = agents.clone();
            async move {
                agents
                    .hook(&hook(
                        "claude",
                        "permission",
                        permission("git push --force"),
                    ))
                    .await
            }
        });
        let card: InboxCard = next(&mut rx).await;
        assert_eq!(card.grace_ms, 2000, "the app's bar drains over 2 s");
        assert!(
            card.body.contains("git push --force") || card.title.contains("git push --force"),
            "{card:?}"
        );
        agents
            .answer(InboxAnswer {
                card_id: card.id.clone(),
                choice: Some(0),
                text: None,
                via: Via::Key,
            })
            .await
            .unwrap();
        let out = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap();
        let printed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(
            printed["hookSpecificOutput"]["decision"]["behavior"], "allow",
            "{}",
            out.stdout
        );
        let release: InboxRelease = next(&mut rx).await;
        assert_eq!(release.card_id, card.id);
    }

    /// One Claude permission request for `command`, answered with the card's first option (allow).
    async fn allow_once(
        agents: &Arc<Agents>,
        rx: &mut broadcast::Receiver<Arc<Vec<u8>>>,
        command: &str,
    ) {
        let waiting = tokio::spawn({
            let agents = agents.clone();
            let request = hook("claude", "permission", permission(command));
            async move { agents.hook(&request).await }
        });
        let card: InboxCard = next(rx).await;
        assert_eq!(card.kind, "permission", "{card:?}");
        agents
            .answer(InboxAnswer {
                card_id: card.id,
                choice: Some(0),
                text: None,
                via: Via::Key,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn three_identical_answers_offer_a_habit_and_yes_writes_rules_toml() {
        let d = temp("habit");
        let rules = d.join("roaming").join("Mewndo").join("rules.toml");
        std::fs::create_dir_all(rules.parent().unwrap()).unwrap();
        std::fs::write(&rules, "# mine\n[allow]\ncommands = [\"cargo check\"]\n").unwrap();
        let log = Arc::new(Log::new(&d.join("logs")));
        let writer = Arc::new(crate::writer::start(&d.join("desk.db"), log.clone()));
        let (tx, mut rx) = broadcast::channel(256);
        let agents = Arc::new(Agents::start(
            d.join("v0"),
            Some(rules.clone()),
            writer,
            Publisher(tx),
            log,
        ));
        for _ in 0..3 {
            allow_once(&agents, &mut rx, "npm publish").await;
        }
        let card: InboxCard = next(&mut rx).await;
        assert_eq!(card.kind, "habit", "{card:?}");
        assert_eq!(card.options, ["yes", "no", "never ask"]);
        assert!(card.title.contains("npm publish"), "{card:?}");
        assert!(
            agents.open_cards().await.iter().any(|c| c.id == card.id),
            "a reconnecting app is sent the Habit card too"
        );

        // A choice the card does not have is refused, and the card stays answerable.
        let answer = |choice, text: Option<&str>| InboxAnswer {
            card_id: card.id.clone(),
            choice,
            text: text.map(str::to_string),
            via: Via::Key,
        };
        assert!(agents.answer(answer(Some(7), None)).await.is_err());
        agents.answer(answer(None, Some("Yes"))).await.unwrap();
        let release: InboxRelease = next(&mut rx).await;
        assert_eq!(release.card_id, card.id);
        assert!(agents.open_cards().await.iter().all(|c| c.id != card.id));

        let written = std::fs::read_to_string(&rules).unwrap();
        assert!(
            written.starts_with("# mine\n[allow]\ncommands = [\"cargo check\",\n  # habit "),
            "{written}"
        );
        assert!(written.contains("\"npm publish\""), "{written}");
        assert_eq!(
            crate::rules_file::load(&rules)
                .unwrap()
                .allow_hit("npm publish"),
            Some("npm publish")
        );
    }

    #[tokio::test]
    async fn bad_answers_are_refused_and_unknown_agents_get_silence() {
        let (agents, _rx) = start("bad");
        assert!(
            agents
                .answer(InboxAnswer {
                    card_id: "nope".into(),
                    choice: Some(0),
                    text: None,
                    via: Via::Key
                })
                .await
                .is_err()
        );
        let id = ulid::Ulid::new().to_string();
        assert!(
            agents
                .answer(InboxAnswer {
                    card_id: id,
                    choice: None,
                    text: None,
                    via: Via::Key
                })
                .await
                .is_err()
        );
        let out = agents.hook(&hook("gemini", "pre-tool", json!({}))).await;
        assert_eq!((out.stdout.as_str(), out.exit_code), ("", 0));
    }

    /// A gateway that has run out of today's budget.
    struct BudgetOut;
    impl mewndo_router::clef::Clef for BudgetOut {
        fn ask(
            &self,
            _request: &mewndo_router::clef::ClefRequest,
            _deadline: Duration,
        ) -> Result<
            (
                mewndo_router::Backend,
                std::collections::BTreeMap<String, mewndo_router::Answer>,
            ),
            mewndo_router::clef::ClefError,
        > {
            Err(mewndo_router::clef::ClefError::RulesOnly(
                "total_cap".into(),
            ))
        }
    }

    #[tokio::test]
    async fn the_gateway_saying_the_budget_is_out_reaches_the_apps_once() {
        let d = temp("budget");
        let log = Arc::new(Log::new(&d.join("logs")));
        let writer = Arc::new(crate::writer::start(&d.join("desk.db"), log.clone()));
        let (tx, mut rx) = broadcast::channel(64);
        let router = Arc::new(Router::new(
            mewndo_router::CompiledRules::builtin(),
            Box::new(BudgetOut),
            Box::new(mewndo_router::facts::NoFacts),
        ));
        let agents = Agents::start_with(router, d.join("v0"), None, writer, Publisher(tx), log);
        assert!(!agents.budget_state().rules_only);
        let pre = json!({
            "session_id": "s1", "cwd": "/work/shop", "hook_event_name": "PreToolUse",
            "tool_name": "Bash", "tool_input": {"command": "npm run build"}
        });
        agents.hook(&hook("claude", "pre-tool", pre.clone())).await;
        let state: BudgetState = next(&mut rx).await;
        assert!(state.rules_only);
        assert!(
            agents.budget_state().rules_only,
            "what a newly connected app is sent"
        );
        agents.hook(&hook("claude", "pre-tool", pre)).await;
        while let Ok(bytes) = rx.try_recv() {
            let Some((Frame::Json(env), _)) = mewndo_proto::decode(&bytes).unwrap() else {
                continue;
            };
            assert_ne!(
                env.kind,
                BudgetState::TYPE,
                "an unchanged state is not sent again"
            );
        }
    }

    #[tokio::test]
    async fn talk_routes_to_a_live_agent_by_name_and_to_mewndo_commands() {
        let (agents, _rx) = start("route");
        agents.live.lock().unwrap().insert(
            "a1".into(),
            AgentStatus {
                agent_id: "a1".into(),
                kind: "claude-code".into(),
                name: "Claude Code".into(),
                connection: "hooked".into(),
                status: "working".into(),
                last_line: None,
            },
        );
        assert_eq!(
            agents.route("tell claude to update the README").target,
            "a1"
        );
        assert_eq!(
            agents.route("undo the last five minutes").target,
            "mewndo:undo"
        );
        assert_eq!(command_in("please freeze it"), "freeze");
    }
}
