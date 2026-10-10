// §36.6 U3: the MCP server an agent talks to. It offers cua-driver's tools as `computer_<name>`, with the driver's
// own input schema and a description that starts "[Guarded by Mewndo] ", and nothing else: there is no unguarded
// name to call, so the guard cannot be routed around from inside the agent.
//
// Every call goes through a `Gate` before the driver sees it (U5 makes the gate the core: the Router, the Inbox,
// the human-takeover pause). A refused call is an answer, not a silence: an MCP tool result with `isError: true`
// and "Mewndo blocked: <reason>" (U5.8), so the agent reads why and stops instead of retrying blindly.

use crate::classify::{Class, classify};
use crate::driver::Driver;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::Value;
use std::future::Future;
use std::sync::Arc;
use tokio::sync::OnceCell;

/// What every offered tool is called: `computer_click`, `computer_type_text`, ...
pub const PREFIX: &str = "computer_";
/// What every offered tool's description starts with.
pub const GUARDED: &str = "[Guarded by Mewndo] ";
/// What every refused call's text starts with (U5.8).
pub const BLOCKED: &str = "Mewndo blocked: ";

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
}

impl<D: Driver, G: Gate> Proxy<D, G> {
    pub fn new(driver: D, gate: G, session: impl Into<String>) -> Self {
        Proxy {
            driver: Arc::new(driver),
            gate: Arc::new(gate),
            session: session.into(),
            driver_tools: OnceCell::new(),
        }
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

    /// The tools the agent sees: every driver tool that is not hidden, renamed and marked.
    pub async fn tools(&self) -> Result<Vec<Tool>, String> {
        Ok(self
            .driver_tools()
            .await?
            .iter()
            .filter_map(guarded)
            .collect())
    }

    /// One call from the agent, by the name it was offered. Always an answer: a refusal and a driver failure are
    /// tool results with `isError`, never a protocol error the agent might retry.
    pub async fn call(&self, name: &str, args: Option<JsonObject>) -> CallToolResult {
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
