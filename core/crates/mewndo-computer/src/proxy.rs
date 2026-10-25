// §36.6 U3: the MCP server an agent talks to. It offers cua-driver's tools as `computer_<name>`, with the driver's
// own input schema and a description that starts "[Guarded by Mewndo] ", and nothing else: there is no unguarded
// name to call, so the guard cannot be routed around from inside the agent.
//
// Every call goes through a `Gate` before the driver sees it (U5 makes the gate the core: the Router, the Inbox,
// the human-takeover pause). A refused call is an answer, not a silence: an MCP tool result with `isError: true`
// and "Mewndo blocked: <reason>" (U5.8), so the agent reads why and stops instead of retrying blindly.
//
// One tool is Mewndo's own: `run_skill {name}` replays a skill the user recorded with Show Me (skill.rs, U9). It
// is not a way around the guard: each step becomes the same driver call an agent could make, and goes through the
// same gate one at a time, so every act is classified, asks the user, and stops when the user takes over. The
// first refusal or failure ends the run and the agent is told exactly how far it got.

use crate::classify::{Class, classify};
use crate::driver::Driver;
use crate::skill;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::Value;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::OnceCell;

/// What every offered tool is called: `computer_click`, `computer_type_text`, ...
pub const PREFIX: &str = "computer_";
/// What every offered tool's description starts with.
pub const GUARDED: &str = "[Guarded by Mewndo] ";
/// What every refused call's text starts with (U5.8).
pub const BLOCKED: &str = "Mewndo blocked: ";
/// Mewndo's own tool: replay a Show Me skill.
pub const RUN_SKILL: &str = "run_skill";
/// The key under which a skill step's words travel to the gate, for the card. Only the copy of the arguments the
/// gate sees carries it; an agent's own value is taken out, so a card can never claim a skill the user did not
/// record.
pub const SKILL_NOTE: &str = "mewndo_skill_step";
/// The pause between two replayed steps, so the app can react to the last one.
pub const STEP_PAUSE: Duration = Duration::from_millis(400);

/// Decides whether one call may reach the driver. `Err(reason)` refuses it, and the reason is what the agent reads.
pub trait Gate: Send + Sync + 'static {
    /// `tool` is the driver's own name; `args` are the arguments as the agent sent them, before redaction (the gate
    /// redacts what it passes on, see redact.rs).
    fn check(
        &self,
        tool: &str,
        class: Class,
        args: &JsonObject,
    ) -> impl Future<Output = Result<(), String>> + Send;
}

/// A gate that refuses everything, with one reason. What the proxy runs when it cannot reach the core: an agent's
/// hands with no guard attached do nothing at all (computer use fails closed, unlike the hooks, because a click
/// has no undo).
pub struct Closed(pub String);

impl Gate for Closed {
    async fn check(&self, _tool: &str, _class: Class, _args: &JsonObject) -> Result<(), String> {
        Err(self.0.clone())
    }
}

pub struct Proxy<D: Driver, G: Gate> {
    driver: Arc<D>,
    gate: Arc<G>,
    /// cua-driver's session label for this agent: added to every call whose schema takes one, so the driver's
    /// per-session state (its cursor, U8) is this proxy's.
    session: String,
    driver_tools: OnceCell<Vec<Tool>>,
    /// Where Show Me skills are (`<desk folder>/skills`). None: no `run_skill`.
    skills: Option<PathBuf>,
    step_pause: Duration,
}

impl<D: Driver, G: Gate> Proxy<D, G> {
    pub fn new(driver: D, gate: G, session: impl Into<String>) -> Self {
        Proxy {
            driver: Arc::new(driver),
            gate: Arc::new(gate),
            session: session.into(),
            driver_tools: OnceCell::new(),
            skills: None,
            step_pause: STEP_PAUSE,
        }
    }

    /// Offers `run_skill`, reading skills from `dir`.
    pub fn with_skills(mut self, dir: PathBuf) -> Self {
        self.skills = Some(dir);
        self
    }

    #[cfg(test)]
    pub fn pausing(mut self, pause: Duration) -> Self {
        self.step_pause = pause;
        self
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn driver(&self) -> &D {
        &self.driver
    }

    async fn driver_tools(&self) -> Result<&Vec<Tool>, String> {
        self.driver_tools
            .get_or_try_init(|| self.driver.tools())
            .await
    }

    /// The tools the agent sees: every driver tool that is not hidden, renamed and marked, and `run_skill` when
    /// skills are on.
    pub async fn tools(&self) -> Result<Vec<Tool>, String> {
        let mut tools: Vec<Tool> = self
            .driver_tools()
            .await?
            .iter()
            .filter_map(guarded)
            .collect();
        if let Some(dir) = &self.skills {
            tools.push(run_skill_tool(&skill::list(dir)));
        }
        Ok(tools)
    }

    /// One call from the agent, by the name it was offered. Always an answer: a refusal and a driver failure are
    /// tool results with `isError`, never a protocol error the agent might retry.
    pub async fn call(&self, name: &str, args: Option<JsonObject>) -> CallToolResult {
        if name == RUN_SKILL && self.skills.is_some() {
            return self.run_skill(args.unwrap_or_default()).await;
        }
        let Some(tool) = name.strip_prefix(PREFIX) else {
            return refused(format!("{name} is not a Mewndo computer tool"));
        };
        let class = classify(tool);
        let known = match self.driver_tools().await {
            Ok(tools) => tools.iter().find(|t| t.name == tool).cloned(),
            Err(e) => return failed(format!("cua-driver is not answering: {e}")),
        };
        let Some(known) = known.filter(|_| class != Class::Hidden) else {
            return refused(format!("{name} is not a Mewndo computer tool"));
        };
        let mut args = args.unwrap_or_default();
        args.remove(SKILL_NOTE);
        if takes_session(&known) && !args.contains_key("session") {
            args.insert("session".into(), Value::String(self.session.clone()));
        }
        if let Err(reason) = self.gate.check(tool, class, &args).await {
            return refused(reason);
        }
        match self.driver.call(tool, args).await {
            Ok(result) => result,
            Err(e) => failed(format!("cua-driver failed: {e}")),
        }
    }

    /// `run_skill {name}`: the skill's steps, one guarded driver call at a time, until the end or the first step
    /// that is refused, fails, or cannot be replayed. The answer lists what ran.
    async fn run_skill(&self, args: JsonObject) -> CallToolResult {
        let Some(dir) = &self.skills else {
            return refused("Show Me skills are not available".into());
        };
        let Some(name) = args.get("name").and_then(Value::as_str) else {
            return failed(format!(
                "{RUN_SKILL} needs the skill's name: {{\"name\": \"...\"}}"
            ));
        };
        let skill = match skill::find(dir, name) {
            Ok(s) => s,
            Err(e) => return failed(e),
        };
        let tools = match self.driver_tools().await {
            Ok(t) => t,
            Err(e) => return failed(format!("cua-driver is not answering: {e}")),
        };
        let total = skill.steps.len();
        let (calls, stop) = skill::plan(&skill);
        let mut report = vec![format!(
            "Skill \"{}\" ({total} steps). Replay clicks the screen points where the user clicked, so the same \
             windows must be where they were.",
            skill.name
        )];
        if let Some(skill::Step::Focus { app, .. }) = skill.steps.first() {
            report.push(format!(
                "It starts in {app}: Mewndo does not switch windows for you."
            ));
        }
        let mut first = true;
        for planned in calls {
            if !first {
                tokio::time::sleep(self.step_pause).await;
            }
            first = false;
            let n = planned.step;
            let Some(known) = tools.iter().find(|t| t.name == planned.tool) else {
                report.push(format!(
                    "Step {n} ({}) was not run: cua-driver has no {} tool.",
                    planned.says, planned.tool
                ));
                return failed(report.join("\n"));
            };
            let mut args = planned.args;
            if takes_session(known) {
                args.insert("session".into(), Value::String(self.session.clone()));
            }
            let mut for_gate = args.clone();
            let note = format!(
                "step {n} of {total} of the skill \"{}\": {}",
                skill.name,
                skill.steps[n - 1].card_words()
            );
            for_gate.insert(SKILL_NOTE.into(), Value::String(note));
            if let Err(reason) = self
                .gate
                .check(planned.tool, classify(planned.tool), &for_gate)
                .await
            {
                report.push(format!(
                    "{BLOCKED}step {n} ({}) was refused: {reason}",
                    planned.says
                ));
                return refused_text(report.join("\n"));
            }
            match self.driver.call(planned.tool, args).await {
                Ok(result) if result.is_error != Some(true) => {
                    report.push(format!("Step {n}: {} - done.", planned.says));
                }
                Ok(result) => {
                    let why: String = result
                        .content
                        .iter()
                        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
                        .collect();
                    report.push(format!(
                        "Step {n} ({}) failed in cua-driver: {why}",
                        planned.says
                    ));
                    return failed(report.join("\n"));
                }
                Err(e) => {
                    report.push(format!(
                        "Step {n} ({}) failed: cua-driver: {e}",
                        planned.says
                    ));
                    return failed(report.join("\n"));
                }
            }
        }
        if let Some(stop) = stop {
            report.push(format!("Stopped before step {}: {}.", stop.step, stop.why));
            return failed(report.join("\n"));
        }
        report.push("Every step ran.".into());
        CallToolResult::success(vec![ContentBlock::text(report.join("\n"))])
    }
}

/// `run_skill`'s definition, listing the skills there are now.
pub fn run_skill_tool(skills: &[skill::Skill]) -> Tool {
    let names: Vec<String> = skills.iter().map(|s| format!("\"{}\"", s.name)).collect();
    let listed = if names.is_empty() {
        "The user has not recorded any skills yet.".to_string()
    } else {
        format!("Skills: {}.", names.join(", "))
    };
    let schema = serde_json::json!({
        "type": "object",
        "properties": {"name": {"type": "string", "description": "The skill's name, as the user saved it."}},
        "required": ["name"],
        "additionalProperties": false
    });
    let Value::Object(schema) = schema else {
        unreachable!("json! of an object")
    };
    Tool::new(
        RUN_SKILL,
        format!(
            "{GUARDED}Runs a workflow the user showed Mewndo (Show Me). Each step is checked like any other \
             action: the user is asked, and a refusal or the user touching the mouse or keyboard stops the run. \
             {listed}"
        ),
        Arc::new(schema),
    )
}

/// cua-driver's tool that shows or hides its own agent cursor for one session (docs/decisions.md, "cua-driver" 4).
pub const CURSOR_TOOL: &str = "set_agent_cursor_enabled";

/// How long the driver has to answer the cursor switch before Mewndo gives up and leaves its cursor on.
pub const CURSOR_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// §36.6 U8: switches cua-driver's own cursor off for `session`, so the only agent cursor on screen is Mewndo's
/// (mewndo-overlay). This is Mewndo's own call, straight to the driver: it does not go through the gate, and the
/// agent cannot make it, because the tool is hidden from the agent (classify.rs). `Err` says why the driver's
/// cursor is still on: no such tool, a refusal, or no answer within `CURSOR_WAIT`.
pub async fn hide_driver_cursor<D: Driver>(driver: &D, session: &str) -> Result<(), String> {
    let mut args = JsonObject::new();
    args.insert("session".into(), Value::String(session.to_string()));
    args.insert("enabled".into(), Value::Bool(false));
    match tokio::time::timeout(CURSOR_WAIT, driver.call(CURSOR_TOOL, args)).await {
        Err(_) => Err(format!(
            "{CURSOR_TOOL} did not answer in {} s",
            CURSOR_WAIT.as_secs()
        )),
        Ok(Err(e)) => Err(format!("{CURSOR_TOOL} failed: {e}")),
        Ok(Ok(result)) if result.is_error == Some(true) => {
            let why: String = result
                .content
                .iter()
                .filter_map(|c| c.as_text().map(|t| t.text.clone()))
                .collect();
            Err(format!("{CURSOR_TOOL} was refused: {why}"))
        }
        Ok(Ok(_)) => Ok(()),
    }
}

/// The guarded copy of one driver tool, or None for a hidden one.
pub fn guarded(tool: &Tool) -> Option<Tool> {
    if classify(&tool.name) == Class::Hidden {
        return None;
    }
    let mut out = tool.clone();
    out.name = format!("{PREFIX}{}", tool.name).into();
    let description = tool.description.as_deref().unwrap_or_default();
    out.description = Some(format!("{GUARDED}{description}").into());
    Some(out)
}

fn takes_session(tool: &Tool) -> bool {
    tool.input_schema
        .get("properties")
        .and_then(Value::as_object)
        .is_some_and(|p| p.contains_key("session"))
}

fn refused(reason: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!("{BLOCKED}{reason}"))])
}

/// A refusal whose text already says "Mewndo blocked:" where it should.
fn refused_text(text: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text)])
}

fn failed(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

impl<D: Driver, G: Gate> ServerHandler for Proxy<D, G> {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("mewndo-computer", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Computer use, guarded by Mewndo. Every action that changes the desktop is shown to the user \
                 first and may be refused; a refusal starts with \"Mewndo blocked:\" and says why. If the user \
                 touches the mouse or keyboard, every action is paused until they choose Resume in Mewndo.",
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        self.tools()
            .await
            .map(ListToolsResult::with_all_items)
            .map_err(|e| {
                McpError::internal_error(format!("cua-driver is not answering: {e}"), None)
            })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        Ok(self.call(&request.name, request.arguments).await.into())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A driver with the 29 tools of cua-driver 0.34.0's portable surface, which records what it was asked.
    #[derive(Default)]
    pub struct FakeDriver {
        pub calls: Mutex<Vec<(String, JsonObject)>>,
        /// Tools this driver does not have: left out of its list, and a call to one fails as unknown.
        pub without: Vec<&'static str>,
        /// Tools that answer with an error result.
        pub refusing: Vec<&'static str>,
    }

    impl Driver for FakeDriver {
        async fn tools(&self) -> Result<Vec<Tool>, String> {
            let sample: Value =
                serde_json::from_str(include_str!("../../../../docs/samples/cua/tools.json"))
                    .unwrap();
            Ok(sample["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| !self.without.contains(&t["name"].as_str().unwrap()))
                .map(|t| {
                    Tool::new(
                        t["name"].as_str().unwrap().to_string(),
                        t["description"].as_str().unwrap_or_default().to_string(),
                        Arc::new(t["inputSchema"].as_object().cloned().unwrap_or_default()),
                    )
                })
                .collect())
        }

        async fn call(&self, name: &str, args: JsonObject) -> Result<CallToolResult, String> {
            self.calls.lock().unwrap().push((name.to_string(), args));
            if self.without.contains(&name) {
                return Err(format!("unknown tool: {name}"));
            }
            if self.refusing.contains(&name) {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    "no overlay in this session",
                )]));
            }
            Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                "did {name}"
            ))]))
        }
    }

    /// A gate that lets everything through and remembers what it was asked.
    #[derive(Default)]
    pub struct Open {
        pub asked: Mutex<Vec<(String, Class)>>,
    }

    impl Gate for Open {
        async fn check(&self, tool: &str, class: Class, _args: &JsonObject) -> Result<(), String> {
            self.asked.lock().unwrap().push((tool.to_string(), class));
            Ok(())
        }
    }

    pub fn text(result: &CallToolResult) -> String {
        result
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.clone()))
            .collect()
    }

    #[tokio::test]
    async fn the_agent_sees_only_guarded_names_with_the_drivers_schema() {
        let proxy = Proxy::new(FakeDriver::default(), Open::default(), "mewndo-test");
        let tools = proxy.tools().await.unwrap();
        assert_eq!(
            tools.len(),
            26,
            "29 driver tools less the three cursor settings"
        );
        assert!(tools.iter().all(|t| t.name.starts_with(PREFIX)));
        assert!(
            tools
                .iter()
                .all(|t| t.description.as_deref().unwrap().starts_with(GUARDED))
        );
        assert!(!tools.iter().any(|t| t.name.contains("set_agent_cursor")));
        let click = tools.iter().find(|t| t.name == "computer_click").unwrap();
        let original = &proxy.driver().tools().await.unwrap()[0];
        assert_eq!(original.name, "click");
        assert_eq!(
            click.input_schema, original.input_schema,
            "the driver's own schema, unchanged"
        );
    }

    #[tokio::test]
    async fn a_call_passes_the_gate_then_reaches_the_driver_with_the_session() {
        let proxy = Proxy::new(FakeDriver::default(), Open::default(), "mewndo-test");
        let args: JsonObject =
            serde_json::from_value(serde_json::json!({"x": 10, "y": 20})).unwrap();
        let result = proxy.call("computer_click", Some(args)).await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert_eq!(text(&result), "did click");
        assert_eq!(
            proxy.gate.asked.lock().unwrap().as_slice(),
            [("click".to_string(), Class::Act)]
        );
        let first = proxy.driver().calls.lock().unwrap()[0].clone();
        assert_eq!(first.0, "click");
        assert_eq!(
            first.1["session"], "mewndo-test",
            "the proxy's session label is added"
        );

        // A session the agent named itself is left alone.
        let own: JsonObject =
            serde_json::from_value(serde_json::json!({"session": "mine"})).unwrap();
        proxy.call("computer_get_screen_size", Some(own)).await;
        assert_eq!(proxy.driver().calls.lock().unwrap()[1].1["session"], "mine");
    }

    #[tokio::test]
    async fn refusals_and_unknown_names_are_answers_with_is_error() {
        let proxy = Proxy::new(
            FakeDriver::default(),
            Closed("Mewndo is not running".into()),
            "s",
        );
        let blocked = proxy.call("computer_type_text", None).await;
        assert_eq!(blocked.is_error, Some(true));
        assert_eq!(text(&blocked), "Mewndo blocked: Mewndo is not running");
        // Reads go through the gate too: with no core, the agent cannot even look.
        assert_eq!(
            text(&proxy.call("computer_get_desktop_state", None).await),
            "Mewndo blocked: Mewndo is not running"
        );

        for name in [
            "click",
            "computer_set_agent_cursor_enabled",
            "computer_launch_rockets",
        ] {
            let result = proxy.call(name, None).await;
            assert_eq!(result.is_error, Some(true), "{name}");
            assert!(
                text(&result).ends_with("is not a Mewndo computer tool"),
                "{name}"
            );
        }
        assert!(
            proxy.driver().calls.lock().unwrap().is_empty(),
            "the driver saw nothing"
        );
    }

    #[tokio::test]
    async fn mewndo_switches_the_drivers_cursor_off_for_its_session_itself() {
        let driver = FakeDriver::default();
        assert_eq!(
            hide_driver_cursor(&driver, "mewndo-claude-1a2b").await,
            Ok(())
        );
        let calls = driver.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "one call, straight to the driver");
        assert_eq!(calls[0].0, CURSOR_TOOL);
        assert_eq!(
            Value::Object(calls[0].1.clone()),
            serde_json::json!({"session": "mewndo-claude-1a2b", "enabled": false})
        );

        // The agent still cannot reach the switch, to turn the driver's cursor back on or anything else.
        let proxy = Proxy::new(driver, Closed("not asked".into()), "mewndo-claude-1a2b");
        let result = proxy.call("computer_set_agent_cursor_enabled", None).await;
        assert!(text(&result).ends_with("is not a Mewndo computer tool"));
        assert_eq!(proxy.driver().calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_missing_or_refusing_cursor_switch_leaves_the_drivers_cursor_on_and_says_why() {
        let missing = FakeDriver {
            without: vec![CURSOR_TOOL],
            ..FakeDriver::default()
        };
        let why = hide_driver_cursor(&missing, "s").await.unwrap_err();
        assert_eq!(
            why,
            "set_agent_cursor_enabled failed: unknown tool: set_agent_cursor_enabled"
        );
        // A driver without the tool is still a driver: the agent gets every other tool.
        let proxy = Proxy::new(missing, Open::default(), "s");
        assert_eq!(proxy.tools().await.unwrap().len(), 26);

        let refusing = FakeDriver {
            refusing: vec![CURSOR_TOOL],
            ..FakeDriver::default()
        };
        assert_eq!(
            hide_driver_cursor(&refusing, "s").await,
            Err("set_agent_cursor_enabled was refused: no overlay in this session".into())
        );
    }

    /// A gate that remembers the arguments it was shown, and refuses the `refuse`-th call (from 1).
    #[derive(Default)]
    pub struct Noting {
        pub seen: Mutex<Vec<(String, JsonObject)>>,
        pub refuse: usize,
    }

    impl Gate for Noting {
        async fn check(&self, tool: &str, _class: Class, args: &JsonObject) -> Result<(), String> {
            let mut seen = self.seen.lock().unwrap();
            seen.push((tool.to_string(), args.clone()));
            if seen.len() == self.refuse {
                return Err("the user said no".into());
            }
            Ok(())
        }
    }

    fn skills_dir(name: &str, files: &[(&str, String)]) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("mewndo-proxy-skills-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for (file, text) in files {
            std::fs::write(d.join(file), text).unwrap();
        }
        d
    }

    const SAMPLE: &str = include_str!("../../../../docs/samples/showme/skill.json");

    fn args(v: Value) -> Option<JsonObject> {
        v.as_object().cloned()
    }

    #[tokio::test]
    async fn run_skill_is_offered_only_with_skills_and_lists_them() {
        let plain = Proxy::new(FakeDriver::default(), Open::default(), "s");
        assert!(
            !plain
                .tools()
                .await
                .unwrap()
                .iter()
                .any(|t| t.name == RUN_SKILL)
        );
        assert!(
            text(&plain.call(RUN_SKILL, None).await).ends_with("is not a Mewndo computer tool"),
            "no skills folder: no such tool"
        );
        let dir = skills_dir("list", &[("a.json", SAMPLE.to_string())]);
        let proxy =
            Proxy::new(FakeDriver::default(), Open::default(), "s").with_skills(dir.clone());
        let tools = proxy.tools().await.unwrap();
        assert_eq!(tools.len(), 27);
        let run = tools.iter().find(|t| t.name == RUN_SKILL).unwrap();
        let about = run.description.as_deref().unwrap();
        assert!(
            about.starts_with(GUARDED) && about.contains("\"Send the weekly report\""),
            "{about}"
        );
        let unknown = proxy
            .call(RUN_SKILL, args(serde_json::json!({"name": "nope"})))
            .await;
        assert_eq!(unknown.is_error, Some(true));
        assert!(text(&unknown).contains("Send the weekly report"));
        assert!(proxy.driver().calls.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn every_replayed_step_passes_the_gate_with_its_note_and_a_private_step_stops_the_run() {
        let dir = skills_dir("run", &[("a.json", SAMPLE.to_string())]);
        let proxy = Proxy::new(FakeDriver::default(), Noting::default(), "mewndo-claude-1")
            .with_skills(dir.clone())
            .pausing(Duration::ZERO);
        let result = proxy
            .call(
                RUN_SKILL,
                args(serde_json::json!({"name": "send the weekly report"})),
            )
            .await;
        let said = text(&result);
        assert_eq!(result.is_error, Some(true), "it stopped early: {said}");
        assert!(
            said.contains("Step 2: click \"New mail\" at 412, 230 - done."),
            "{said}"
        );
        assert!(said.contains("Stopped before step 4"), "{said}");
        assert!(said.contains("It starts in OUTLOOK.EXE"), "{said}");

        let seen = proxy.gate.seen.lock().unwrap().clone();
        assert_eq!(
            seen.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(),
            ["click", "type_text"]
        );
        assert_eq!(
            seen[0].1[SKILL_NOTE],
            "step 2 of 6 of the skill \"Send the weekly report\": click \"New mail\" at 412, 230"
        );
        assert_eq!(
            seen[1].1[SKILL_NOTE], "step 3 of 6 of the skill \"Send the weekly report\": type text",
            "the card's note never carries the typed text"
        );
        let calls = proxy.driver().calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert!(
            calls.iter().all(|c| !c.1.contains_key(SKILL_NOTE)),
            "the note never reaches the driver"
        );
        assert_eq!(calls[0].1["session"], "mewndo-claude-1");
        assert_eq!(calls[1].1["text"], "boss@example.com");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_refused_step_ends_the_run_and_says_how_far_it_got() {
        let keys = r#"{"format":1,"name":"Save","steps":[
            {"kind":"key","key":"s","modifiers":["ctrl"]},{"kind":"key","key":"Enter"},{"kind":"key","key":"Tab"}]}"#;
        let dir = skills_dir("refuse", &[("save.json", keys.to_string())]);
        let gate = Noting {
            refuse: 2,
            ..Noting::default()
        };
        let proxy = Proxy::new(FakeDriver::default(), gate, "s")
            .with_skills(dir.clone())
            .pausing(Duration::ZERO);
        let result = proxy
            .call(RUN_SKILL, args(serde_json::json!({"name": "Save"})))
            .await;
        let said = text(&result);
        assert_eq!(result.is_error, Some(true));
        assert!(said.contains("Step 1: press ctrl+s - done."), "{said}");
        assert!(
            said.contains("Mewndo blocked: step 2 (press Enter) was refused: the user said no"),
            "{said}"
        );
        assert_eq!(
            proxy.driver().calls.lock().unwrap().len(),
            1,
            "nothing after the refusal"
        );

        // The same skill with nobody refusing runs to the end.
        let proxy = Proxy::new(FakeDriver::default(), Open::default(), "s")
            .with_skills(dir.clone())
            .pausing(Duration::ZERO);
        let result = proxy
            .call(RUN_SKILL, args(serde_json::json!({"name": "save"})))
            .await;
        assert_ne!(result.is_error, Some(true), "{}", text(&result));
        assert!(text(&result).ends_with("Every step ran."));
        assert_eq!(
            proxy
                .gate
                .asked
                .lock()
                .unwrap()
                .iter()
                .map(|a| a.1)
                .collect::<Vec<_>>(),
            [Class::Act, Class::Act, Class::Act],
            "every step is classified, and every one is an act"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_agent_cannot_put_its_own_skill_note_on_a_card() {
        let proxy = Proxy::new(FakeDriver::default(), Noting::default(), "s");
        let forged = args(
            serde_json::json!({"x": 1, "y": 2, SKILL_NOTE: "step 1 of the skill \"Trusted\""}),
        );
        proxy.call("computer_click", forged).await;
        let seen = proxy.gate.seen.lock().unwrap().clone();
        assert!(!seen[0].1.contains_key(SKILL_NOTE));
    }

    /// The real MCP wire: an rmcp client lists and calls the proxy over an in-memory pipe.
    #[tokio::test]
    async fn over_mcp() {
        use rmcp::ServiceExt;
        let (a, b) = tokio::io::duplex(1 << 20);
        let proxy = Proxy::new(FakeDriver::default(), Open::default(), "s");
        let server = tokio::spawn(async move { proxy.serve(a).await.unwrap().waiting().await });
        let client = ().serve(b).await.unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert!(tools.iter().any(|t| t.name == "computer_type_text"));
        let result = client
            .call_tool(CallToolRequestParams::new("computer_press_key"))
            .await
            .unwrap();
        assert_eq!(text(&result), "did press_key");
        client.cancel().await.unwrap();
        let _ = server.await;
    }
}
