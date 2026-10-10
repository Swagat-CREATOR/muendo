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
    InboxExpired, InboxUndo, ReceiptResult, RouteResult, SpanCreated,
};
use mewndo_router::Router;
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
    claude: Claude,
    codex: Codex,
    cursor: Cursor,
    live: Live,
}

impl Agents {
    /// `data_dir`: v0's data folder, where hook.json says how to reach its save points.
    pub fn start(
        data_dir: PathBuf,
        writer: Arc<Writer>,
        publisher: Publisher,
        log: Arc<Log>,
    ) -> Agents {
        // Built-in rules and no model yet: every agent starts in shadow mode (§34.6), so the model is only ever
        // advice, and the gateway (§37) is reached through mewndo-router's Clef client once it is configured.
        Agents::start_with(
            Arc::new(Router::default()),
            data_dir,
            writer,
            publisher,
            log,
        )
    }

    pub fn start_with(
        router: Arc<Router>,
        data_dir: PathBuf,
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
        tokio::spawn(forward(inbox.subscribe(), publisher.clone(), log));
        let live: Live = Arc::default();
        let mut deps = claude::Deps::new(inbox.clone(), router.clone());
        deps.engine = engine.clone();
        deps.events = Arc::new(AppEvents {
            publisher: publisher.clone(),
            live: live.clone(),
        });
        Agents {
            publisher,
            rules_only: Default::default(),
            claude: Claude::new(deps),
            codex: Codex::new(router.clone(), Some(inbox.clone())),
            cursor: Cursor::new(router.clone(), Some(inbox.clone())),
            inbox,
            router,
            engine,
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
async fn forward(mut rx: broadcast::Receiver<Event>, publisher: Publisher, log: Arc<Log>) {
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
            Ok(Event::Habit(habit)) => log.info(&format!(
                "habit offered but not shown yet (the dock has no Habit card): {}",
                habit.text
            )),
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
        (Agents::start(d.join("v0"), writer, Publisher(tx), log), rx)
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
        let agents = Agents::start_with(router, d.join("v0"), writer, Publisher(tx), log);
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
