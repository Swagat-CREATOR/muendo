# mewndo-mcp — hosted MCP server

Mewndo's MCP server for **cloud** agents that can only reach public URLs
(spec §22.2, §22.3, §31.5). Streamable HTTP, OAuth 2.1 with Dynamic Client
Registration and refresh tokens, per-tool scopes, per-user Durable Object state.

Tools: `mewndo_status`, `create_save_point`, `list_changes`, `get_project_card`,
`append_progress` (same as the local server) plus `request_delete` and
`send_email`, **which go through holds**. `undo` is *not* exposed to cloud agents.

Scopes: `mewndo.read` (status, changes, card), `mewndo.write` (save point,
progress), `mewndo.hold` (request_delete, send_email), `offline_access` (refresh
token). A client granted only read tools cannot call a held one — `tools/list`
hides them and `tools/call` refuses them.

## Deploy (your Cloudflare account)

```bash
cd cloud/mcp
npm install
npx wrangler login
npx wrangler deploy      # prints https://mewndo-mcp.<subdomain>.workers.dev
```

The MCP endpoint is `<url>/mcp`. Discovery is at
`<url>/.well-known/oauth-protected-resource`.

## Connect cards (what the Connect page shows, spec §22.2)

### claude.ai / Claude Desktop / Cowork
- **Settings → Connectors → Add custom connector**, URL: `<url>/mcp`
- Sign in through the Mewndo consent page; Claude registers itself via DCR.
- **Honest limits:** the Free plan allows **one** custom connector; paid plans more.
  Connector requests come from Anthropic's cloud, so Mewndo cannot block what a
  Claude cloud session does *outside* these tools — no hooks exist there. Guard
  applies only to actions that go through Mewndo's tools.

### ChatGPT
- **Settings → Connectors → Developer mode → Add app**, URL: `<url>/mcp`
- **Honest limits:** write tools need **Business, Enterprise or Edu**; Pro is
  read/fetch only, so `create_save_point`, `request_delete` and `send_email` will
  not work on Pro. **Agent mode does not use custom apps at all**, so holds do
  **not** apply to ChatGPT agent mode. OpenAI "dots" MCP support is unconfirmed —
  treat it as data-side only (Heal).

### Grok / Grok Bot
- **Settings → Connectors → Add custom connector**, URL: `<url>/mcp`
- **Honest limits:** Business/Enterprise workspaces need an admin to provision the
  connector. **Grok Bot runs on xAI's own cloud computer: there is no external
  stop**, so Mewndo can only Heal afterwards, not Brake.

### Gemini
- Add `<url>/mcp` in the client's MCP settings.
- **Honest limits:** no user hooks exist, so Gemini is **Watched**, not Guarded —
  Mewndo sees only what comes through its own tools and connected accounts.

Across all four: **file contents and names never leave the PC.** Tools that need
the PC answer from what the desktop app pushed up (P5.4) and say
`desktop_online: false` when it is offline, rather than guessing.

## Tests

```bash
cd cloud/mcp && npm test
```

Covers the scope map, that read-only clients can't reach held tools, and that
`undo` is absent. **Not deployed or tested against a live client yet** — that
needs your Cloudflare account.
