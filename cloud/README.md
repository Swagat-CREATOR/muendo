# cloud

Cloudflare Workers code for Mewndo v1, each deployed on its own with `npx wrangler@3 deploy`
from its folder: `gateway` (Clef, speech), `decide`, `mcp` (hosted MCP server), and the
Connections Workers `gmail`, `drive`, `notion`. How to switch Connections on:
docs/connections-setup.md. Tests: `node --test "cloud/*/test/**/*.test.js"` from the root.
