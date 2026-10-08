// Mewndo's local MCP server (spec §22.3), over stdio, built with the official Rust MCP SDK (rmcp). An agent
// launches `mewndo-core mcp`; each tool call goes to the running Mewndo app through its localhost hook server
// (POST /mcp/<tool>, the token from <data>/hook.json), which has the journals, holds and briefs. The agent's
// working folder (this process's cwd) says which protected folder it means. Undo is never exposed to agents.
// What it can't do: with the Mewndo app closed every tool answers that Mewndo isn't running.
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DEADLINE: Duration = Duration::from_secs(30); // a save point in a big folder can take a while

#[derive(Clone)]
pub struct Mewndo {
    data_dir: PathBuf,
    agent: String,
    cwd: String,
    #[allow(dead_code)] // read by the tool_handler macro
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct Label {
    #[schemars(description = "What you're about to do, e.g. \"before refactoring auth\"")]
    label: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Since {
    #[schemars(
        description = "A save point id from mewndo_status or create_save_point; the newest one if left out"
    )]
    since: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Delete {
    #[schemars(description = "Files to delete, relative to the project folder")]
    paths: Vec<String>,
    #[schemars(description = "Why they should go")]
    reason: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Project {
    #[schemars(description = "The project folder; this folder if left out")]
    project: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
pub struct Note {
    #[schemars(description = "One line on what you've done or what's next")]
    note: String,
}

#[tool_router]
impl Mewndo {
    #[tool(
        description = "Is this project folder protected by Mewndo? Its newest save point and any actions waiting for the user's approval."
    )]
    async fn mewndo_status(&self) -> Result<String, String> {
        self.ask("mewndo_status", json!({})).await
    }

    #[tool(
        description = "Make a Mewndo save point of this project folder before risky work, so the user can undo back to it."
    )]
    async fn create_save_point(&self, Parameters(p): Parameters<Label>) -> Result<String, String> {
        self.ask("create_save_point", json!({ "label": p.label }))
            .await
    }

    #[tool(
        description = "What changed in this project folder since a save point (deleted, edited, moved, created), as Mewndo's journal saw it."
    )]
    async fn list_changes(&self, Parameters(p): Parameters<Since>) -> Result<String, String> {
        self.ask("list_changes", json!({ "since": p.since })).await
    }

    #[tool(
        description = "Ask to delete files. Nothing is deleted now: the user approves or cancels on the Mewndo bar, and approved files go to Mewndo's trash, never deleted for good. Returns pending_approval."
    )]
    async fn request_delete(&self, Parameters(p): Parameters<Delete>) -> Result<String, String> {
        self.ask(
            "request_delete",
            json!({ "paths": p.paths, "reason": p.reason }),
        )
        .await
    }

    #[tool(
        description = "The verified Continue card for this project: the task, what really changed, and the rules to keep. Read it when resuming work."
    )]
    async fn get_project_card(&self, Parameters(p): Parameters<Project>) -> Result<String, String> {
        self.ask("get_project_card", json!({ "project": p.project }))
            .await
    }

    #[tool(
        description = "Report progress. Stored as \"Agent says\" until Mewndo's journal confirms it, and shown on the next Continue card."
    )]
    async fn append_progress(&self, Parameters(p): Parameters<Note>) -> Result<String, String> {
        self.ask("append_progress", json!({ "note": p.note })).await
    }
}

#[tool_handler]
impl ServerHandler for Mewndo {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("mewndo", env!("CARGO_PKG_VERSION")))
            .with_instructions("Mewndo keeps every version of the user's files. Make a save point before risky work, use request_delete instead of deleting files yourself, and report progress with append_progress.")
    }
}

impl Mewndo {
    pub fn new(data_dir: PathBuf, agent: String) -> Self {
        let cwd = std::env::current_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_default();
        Mewndo {
            data_dir,
            agent,
            cwd,
            tool_router: Self::tool_router(),
        }
    }

    async fn ask(&self, tool: &str, args: Value) -> Result<String, String> {
        let not_running = |why: String| {
            format!(
                "Mewndo isn't running or can't be reached ({why}). Ask the user to open Mewndo."
            )
        };
        let config: Value = std::fs::read_to_string(self.data_dir.join("hook.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .ok_or_else(|| not_running("no hook.json".into()))?;
        let port = config["port"]
            .as_u64()
            .ok_or_else(|| not_running("no port".into()))?;
        let token = config["token"]
            .as_str()
            .ok_or_else(|| not_running("no token".into()))?;
        let body = json!({ "args": args, "cwd": self.cwd }).to_string();
        let agent = if ["claude", "codex", "cursor"].contains(&self.agent.as_str()) {
            &self.agent
        } else {
            "claude"
        };
        let request = format!(
            "POST /mcp/{tool}?agent={agent} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-mewndo-token: {token}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let exchange = async {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port as u16)).await?;
            stream.write_all(request.as_bytes()).await?;
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await?;
            Ok::<_, std::io::Error>(response)
        };
        let response = tokio::time::timeout(DEADLINE, exchange)
            .await
            .map_err(|_| "Mewndo took too long to answer.".to_string())?
            .map_err(|e| not_running(e.to_string()))?;
        let text = String::from_utf8_lossy(&response);
        let (head, body) = text
            .split_once("\r\n\r\n")
            .ok_or_else(|| not_running("bad answer".into()))?;
        let reply: Value =
            serde_json::from_str(body).map_err(|_| not_running("bad answer".into()))?;
        if head.starts_with("HTTP/1.1 200") {
            Ok(serde_json::to_string_pretty(&reply).unwrap_or_default())
        } else {
            Err(reply["error"]
                .as_str()
                .unwrap_or("Mewndo refused the request.")
                .to_string())
        }
    }
}

/// Serve MCP on stdin and stdout until the agent closes them.
pub async fn serve(data_dir: PathBuf, agent: String) -> Result<(), String> {
    let service = Mewndo::new(data_dir, agent)
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| e.to_string())?;
    service.waiting().await.map_err(|e| e.to_string())?;
    Ok(())
}
