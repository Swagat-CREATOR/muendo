// The one door from the core to the v0 engine (spec §32.5 rule 6): the app's localhost hook server, whose port and
// token are in <data>/hook.json (apps/desktop/engine/hook-server.js). Save points come from v0's MCP tool
// `create_save_point`, which always makes one: `/savepoint` skips it when nothing changed, and an Inbox answer needs
// a save point for its Undo either way.
//
// Every call has a deadline (CLAUDE.md rule 3). Restores are not here: `inbox.undo` goes to the app, which runs the
// restore through its own engine with the confirmation of §23.3.
use mewndo_inbox::{EngineClient, EngineError, SavepointRequest, engine::Pending};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SAVEPOINT_DEADLINE: Duration = Duration::from_secs(10);

/// POST /mcp/<tool>?agent=<agent> with {args, cwd}; the tool's JSON answer, or why there isn't one.
pub async fn post_mcp(
    data_dir: &std::path::Path,
    tool: &str,
    agent: &str,
    cwd: &str,
    args: Value,
    deadline: Duration,
) -> Result<Value, String> {
    let config: Value = std::fs::read_to_string(data_dir.join("hook.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("Mewndo isn't running (no hook.json)")?;
    let port = config["port"].as_u64().ok_or("no port in hook.json")?;
    let token = config["token"].as_str().ok_or("no token in hook.json")?;
    let agent = if ["claude", "codex", "cursor"].contains(&agent) {
        agent
    } else {
        "claude"
    };
    let body = json!({ "args": args, "cwd": cwd }).to_string();
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
    let response = tokio::time::timeout(deadline, exchange)
        .await
        .map_err(|_| "Mewndo took too long to answer".to_string())?
        .map_err(|e| format!("Mewndo can't be reached ({e})"))?;
    let text = String::from_utf8_lossy(&response);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("a bad answer from Mewndo")?;
    let reply: Value =
        serde_json::from_str(body).map_err(|_| "a bad answer from Mewndo".to_string())?;
    if head.starts_with("HTTP/1.1 200") {
        Ok(reply)
    } else {
        Err(reply["error"]
            .as_str()
            .unwrap_or("Mewndo refused the request")
            .to_string())
    }
}

/// Save points for the Inbox and the agent handlers. Remembers each agent's kind and folder, because the Inbox's
/// release only knows the agent id, and v0 finds the protected folder from the folder.
pub struct V0Engine {
    data_dir: PathBuf,
    agents: Mutex<HashMap<String, (String, String)>>,
}

impl V0Engine {
    pub fn new(data_dir: PathBuf) -> Arc<V0Engine> {
        Arc::new(V0Engine {
            data_dir,
            agents: Mutex::new(HashMap::new()),
        })
    }

    /// The agent `id` is a `kind` (claude, codex, cursor) working in `cwd`.
    pub fn note(&self, id: &str, kind: &str, cwd: &str) {
        if id.is_empty() || cwd.is_empty() {
            return;
        }
        let mut agents = self.agents.lock().unwrap_or_else(|e| e.into_inner());
        let kind = agents
            .get(id)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| kind.to_string());
        agents.insert(id.to_string(), (kind, cwd.to_string()));
    }

    /// The folder agent `id` was last seen working in.
    pub fn folder(&self, id: &str) -> Option<String> {
        self.agent(id).map(|(_, cwd)| cwd)
    }

    fn agent(&self, id: &str) -> Option<(String, String)> {
        self.agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }
}

impl EngineClient for V0Engine {
    fn savepoint(&self, request: SavepointRequest) -> Pending {
        if let Some(cwd) = request.cwd.as_deref() {
            self.note(&request.agent_id, "claude", cwd);
        }
        let known = self.agent(&request.agent_id);
        let data_dir = self.data_dir.clone();
        Box::pin(async move {
            let (kind, cwd) = known.ok_or_else(|| {
                EngineError::Unavailable("the agent's folder isn't known yet".into())
            })?;
            let label = match request.trigger {
                mewndo_inbox::TRIGGER => format!("Inbox answer ({})", request.note),
                _ => "Before the agent's turn".to_string(),
            };
            let reply = post_mcp(
                &data_dir,
                "create_save_point",
                &kind,
                &cwd,
                json!({ "label": label }),
                SAVEPOINT_DEADLINE,
            )
            .await
            .map_err(EngineError::Unavailable)?;
            reply["savePoint"]["id"]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| EngineError::Refused(reply.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    // A stand-in for the v0 hook server: answers one request with `status` and `body`, and hands back what it got.
    async fn fake_v0(
        dir: &std::path::Path,
        status: &str,
        body: &str,
    ) -> tokio::task::JoinHandle<String> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        std::fs::write(
            dir.join("hook.json"),
            json!({"port": port, "token": "t0k"}).to_string(),
        )
        .unwrap();
        let reply = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\n\r\n{body}");
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 8192];
            let n = s.read(&mut buf).await.unwrap();
            s.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        })
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mewndo-engine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn request(trigger: &'static str, agent: &str, cwd: Option<&str>) -> SavepointRequest {
        SavepointRequest {
            trigger,
            note: "card-1".into(),
            agent_id: agent.into(),
            cwd: cwd.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn a_release_save_point_uses_the_folder_the_agent_was_seen_in() {
        let d = temp("release");
        let engine = V0Engine::new(d.clone());
        engine.note("a1", "codex", r"C:\work\shop");
        let got = fake_v0(&d, "200 OK", r#"{"savePoint":{"id":"sp-9","label":"x"}}"#).await;
        let id = engine
            .savepoint(request(mewndo_inbox::TRIGGER, "a1", None))
            .await
            .unwrap();
        assert_eq!(id, "sp-9");
        let sent = got.await.unwrap();
        assert!(
            sent.starts_with("POST /mcp/create_save_point?agent=codex HTTP/1.1"),
            "{sent}"
        );
        assert!(sent.contains("x-mewndo-token: t0k"));
        assert!(sent.contains(r#""cwd":"C:\\work\\shop""#), "{sent}");
        assert!(sent.contains("Inbox answer (card-1)"));
    }

    #[tokio::test]
    async fn an_unknown_agent_or_a_refusal_is_an_error_not_an_id() {
        let d = temp("refused");
        let engine = V0Engine::new(d.clone());
        assert!(matches!(
            engine
                .savepoint(request(mewndo_inbox::TRIGGER, "nobody", None))
                .await,
            Err(EngineError::Unavailable(_))
        ));
        let _got = fake_v0(
            &d,
            "400 Bad Request",
            r#"{"error":"That folder is not protected."}"#,
        )
        .await;
        let err = engine
            .savepoint(request("agent", "a2", Some("/tmp/x")))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            EngineError::Unavailable("That folder is not protected.".into())
        );
    }

    #[tokio::test]
    async fn no_hook_json_means_mewndo_is_not_running() {
        let d = temp("nohook");
        let err = post_mcp(
            &d,
            "create_save_point",
            "claude",
            "/x",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap_err();
        assert!(err.contains("isn't running"), "{err}");
    }
}
