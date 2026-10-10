// §36.6 U3: the proxy's other side, cua-driver's MCP server, started as a child process (`cua-driver mcp`).
//
// A trait, so the proxy's whole behaviour -- the renaming, the guard, the deny text, the cursor switch -- is
// tested against a fake driver on any machine. The real one needs the pinned Windows binary (vendor.rs), which
// is never run in this repository's tests.

use rmcp::model::{CallToolRequestParams, CallToolResult, JsonObject, Tool};
use std::future::Future;
use std::path::Path;

pub trait Driver: Send + Sync + 'static {
    /// The driver's own tool list, as it reports it.
    fn tools(&self) -> impl Future<Output = Result<Vec<Tool>, String>> + Send;
    /// One tool call, by the driver's own name. The result is passed back to the agent as the driver gave it:
    /// a driver result that says `effect: "unverifiable"` (decisions.md, "cua-driver" 1) is not turned into a
    /// success here.
    fn call(
        &self,
        name: &str,
        args: JsonObject,
    ) -> impl Future<Output = Result<CallToolResult, String>> + Send;
}

/// `cua-driver mcp` over stdio, through rmcp's client.
pub struct McpDriver {
    service: rmcp::service::RunningService<rmcp::RoleClient, ()>,
}

impl McpDriver {
    /// Starts `<exe> mcp`. The driver is the pinned, SHA-256-checked release (vendor.rs), never a script.
    pub async fn start(exe: &Path) -> Result<McpDriver, String> {
        use rmcp::ServiceExt;
        let mut command = tokio::process::Command::new(exe);
        command.arg("mcp");
        let transport = rmcp::transport::TokioChildProcess::new(command)
            .map_err(|e| format!("cua-driver could not start: {e}"))?;
        let service = ()
            .serve(transport)
            .await
            .map_err(|e| format!("cua-driver did not answer MCP initialize: {e}"))?;
        Ok(McpDriver { service })
    }
}

impl Driver for McpDriver {
    async fn tools(&self) -> Result<Vec<Tool>, String> {
        self.service
            .list_all_tools()
            .await
            .map_err(|e| e.to_string())
    }

    async fn call(&self, name: &str, args: JsonObject) -> Result<CallToolResult, String> {
        self.service
            .call_tool(CallToolRequestParams::new(name.to_string()).with_arguments(args))
            .await
            .map_err(|e| e.to_string())
    }
}
