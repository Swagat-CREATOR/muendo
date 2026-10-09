# mewndo-cloud (gateway)

Mewndo's decision gateway for the public demo (spec §37). Up to 7 testers send
one System One request per risky agent step; the gateway answers from cache,
Workers AI or the Kaggle backend, or says `{"fallback":true}` so the device's own
rules decide (§34.8). No tester's PC holds a Cloudflare key.

| Route | Auth | Does |
|---|---|---|
| `GET /health` | none | liveness; what the core pre-connects to (§34.9 R6) |
| `POST /v1/decide` | `Bearer <invite token>` | one decision (§34.3 in, §34.9 R6 out) |
| `POST /invite/redeem` | none | `{code}` → a bearer token (§37.5) |
| `POST /admin/invites` | `x-admin-secret` | mint up to 7 codes |
| `POST /admin/revoke` | `x-admin-secret` | revoke a token |
| `GET /admin/status` | `x-admin-secret` | usage per tester, Kaggle state, latency medians |
| `POST /internal/backend` | `Bearer <GATEWAY_SECRET>` | Kaggle register and heartbeat (§37.4) |
| `POST /mcp` | `Bearer <invite token>` or `?token=` | hosted MCP for cloud agents (§37.6 K6) |
| `GET /hub` | `Bearer <invite token>` or `?token=` | the desktop's WebSocket link (§37.6 K7) |

Request headers on `/v1/decide`: `x-mewndo-kind` (`guard`, `voice`, `triage`,
`receipt`, `showme`), `x-mewndo-sig` (the device's action signature, §34.9 R4)
and `x-mewndo-deadline-ms`. An unknown kind is treated as `guard`, and the
deadline header can only tighten the kind's own deadline, never extend it.

**Route order** (§37.3): `guard` and `voice` go cache → Workers AI → Kaggle (only
if its measured median fits the deadline) → fallback. `triage`, `receipt` and
`showme` go cache → Kaggle → Workers AI → fallback, which saves free neurons for
the calls an agent is actually waiting on.

**Budget** (§37.2): the free plan gives 10,000 neurons a day, reset 00:00 UTC.
The gateway stops using Workers AI at 9,000 and gives each tester 1,200. A call
is estimated at `ceil(bytes/4)` tokens × 8,182 per million, reserved before the
call and corrected after if the backend reports its real use.

## Hosted MCP and hub (K6, K7)

Cloud agents (ChatGPT dots, Grok Bot, Meta Muse, claude.ai) have no hooks, so they
ask Mewndo by calling a tool. `POST /mcp` speaks MCP's JSON-RPC: `initialize`,
`tools/list`, `tools/call`. Tools: `ask_user`, `get_answer`, `report_progress`,
`report_done`, `skills_list`, `skills_get`.

`ask_user` raises a card in one `HubDO` — one Durable Object per tester, so a card
can never reach another tester's desktop — pushes it over the desktop's WebSocket,
and waits up to 110 s. **Nobody answering is never an approval:** the tool returns
"No answer yet; call get_answer with card_id … later. Do not go ahead without one."
The card and its answer are written to storage before the waiter is woken, so an
eviction mid-wait still leaves the answer readable by `get_answer`. A second answer
to the same card is ignored.

The desktop sends `{"type":"inbox.answer","card_id":…,"choice":…|"text":…}` and
`{"type":"skills.share","slug":…,"text":…}` over the socket, and receives
`inbox.card`, `agent.status` and a `hub.open` catch-up list on connect.

Add it to a cloud agent with the Worker URL plus the tester's token:
`https://<worker>/mcp?token=<token>`. Some agent apps cannot set headers, which is
why the query string is accepted.

## Deploy (your Cloudflare account — I can't do this from the repo)

```bash
cd cloud/gateway
npm install
npx wrangler login
npx wrangler secret put ADMIN_SECRET        # long random; mints and revokes invites
npx wrangler secret put GATEWAY_SECRET      # long random; shared with the Kaggle notebook
npx wrangler deploy                         # prints the Worker URL
curl -s -X POST https://<worker>/admin/invites -H "x-admin-secret: $ADMIN_SECRET"
```

Give the Worker URL to the core's Router client (§34.9 R6) and a code to each
tester. `GET /admin/status` shows where the day's neurons went.

## Local tests (no account needed)

```bash
cd cloud/gateway && npm test      # or npm run test:cloud from the repo root
```

58 tests: the §34.3 request contract, the neuron estimate, every §37.3 route and
§37.2 cap, the 5-minute cache, the 180-second Kaggle staleness rule, invites and
revocation, and the whole Worker driven through `/v1/decide` with the runtime
faked (`test/fake-do.js`).

## Honest limits

- **Not deployed and not measured.** Every latency claim in §38.7 is still a
  target. Nothing here has run on Cloudflare.
- **The clef-flash call shape is a guess.** §32.5 rule 3 lists the exact input and
  output of `@cf/cloudflare/clef-flash` as unverified, so `askWorkersAi` in
  `src/index.js` asks a Workers AI model for strict JSON in the §34.9 R6 field
  names. An answer in any other shape is a `fallback`, never a guessed verdict,
  and one raw sample is kept (`/admin/status` → `unknown_answer_sample`) to fix
  the parser against something real. Correcting that one function is the whole
  change once the schema is known.
- **One backend attempt per request.** §37.6 K4.2 asks for one `StateDO` round
  trip, so the route is chosen once. If the chosen backend then fails, the answer
  is `fallback` rather than a second attempt that would blow the deadline. A
  backend that stays down is routed around on the next call: a stopped notebook
  drops out after 180 s without a heartbeat.
- **The deadline stops the waiting, not the call.** Whether `env.AI.run` accepts
  an `AbortSignal` is unverified, so a slow model call is abandoned by the Worker
  but may keep running. `fetch` to Kaggle is aborted properly.
- **No neuron count from Workers AI.** The reservation is an estimate; re-measure
  on a real account before trusting `/admin/status`.
- **The hub's WebSocket is untested over a real socket.** The tests drive `HubDO`
  through its `fetch` path and a fake Hibernation API; `WebSocketPair`,
  `acceptWebSocket` and `getWebSockets` only exist in workerd, so the 101 upgrade
  itself has never run here.
- **Not built yet:** the desktop side of the link (K8, Rust `tokio-tungstenite`).
  `skills_list` and `skills_get` return nothing until the desktop shares a Show Me
  workflow, which needs §36.6 U9.

## Deviations from §37.6, and why

- **Plain ESM JavaScript, not TypeScript with Hono.** The five existing workers in
  `cloud/` are plain ESM with no framework, and the repo has no TypeScript
  toolchain, so TypeScript here would add a build step and break
  `npm run test:cloud` (`node --test "cloud/*/test/**/*.test.js"`). Routing is a
  12-line `switch`; Hono would earn its place at many more routes.
- **`wrangler.toml`, not `wrangler.jsonc`.** Matches the other five workers.
- **`StateDO` uses Durable Object key-value storage, not its SQL API.** The
  constraint §37.6 names is "nothing in Workers KV", which this satisfies. The
  key-value API is faked in 25 lines, so every budget, cache and invite path is
  covered by `node --test` without a Workers runtime; the SQL API is not.
  §37.6 K2's five tables map to key prefixes `invite:`, `token:`, `usage:`,
  `cache:` and `backend:`.
- **The MCP is hand-rolled JSON-RPC, not the Agents SDK `McpAgent`.** `McpAgent`
  plus `@modelcontextprotocol/sdk` plus `zod` is three dependencies and cannot run
  under plain `node --test`; `src/mcp.js` is about 90 lines for the three methods a
  tool server needs, and its input schemas are the JSON Schema MCP puts on the wire
  anyway. If a client needs SSE or resources, swap this one file.
- **The DO is called over `fetch`, not RPC.** RPC needs `cloudflare:workers`,
  which plain `node --test` cannot import. The method names are the same, so a
  later switch is one function (`state()` in `src/index.js`).
