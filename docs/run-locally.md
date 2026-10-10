# Running Mewndo locally (no Cloudflare deploy needed)

Everything below runs on your own machine. With no gateway deployed, Mewndo works fully on its **rules**: Guard
decisions come from the core's built-in rules, and voice uses Windows' offline recognizer. Nothing needs a key.

## 1. Build and test (WSL / Linux)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd ~/"wishperflow task"                      # the repo root
npm ci
(cd core && cargo build --workspace)          # mewndo-core + mewndo-hook (no network: nothing from git)
npm test                                      # Rust workspace + desktop app + cloud Workers + tools
```

## 2. Run the desktop app on Windows (from WSL)

Check free space first (`df -h /mnt/c`); the C: drive is tight.

```bash
scripts/windows.sh cargo build --manifest-path core/Cargo.toml -p mewndo-core -p mewndo-hook
```

Then, in PowerShell, start the app from the repo with `%TEMP%\mewndo-dev-start.ps1` (it clears
ELECTRON_RUN_AS_NODE and sets MEWNDO_CORE_BIN). Quit the installed Mewndo first: both use port 47821 and one
single-instance lock. The app starts the core with `--desk %LOCALAPPDATA%\Mewndo --data ... --rules
%APPDATA%\Mewndo\rules.toml`. Logs: `%APPDATA%\mewndo\data\logs\`.

## 3. Run the gateway locally instead of deploying

The real Worker runs under `wrangler dev` with a **stubbed AI model** (`cloud/gateway/dev/stub-ai.js`): it answers
every Clef question and every transcription with fixed values, spends no neurons and needs no Cloudflare login.

```bash
cd ~/"wishperflow task"/cloud/gateway
npm ci
npx wrangler dev -c dev/wrangler.stub.toml --ip 127.0.0.1 --port 8787 --var ADMIN_SECRET:pick-any-local-secret
```

In a second terminal, make a device token:

```bash
CODE=$(curl -s -XPOST 127.0.0.1:8787/admin/invites -H 'x-admin-secret: pick-any-local-secret' -d '{"count":1}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).codes[0]')
curl -s -XPOST 127.0.0.1:8787/invite/redeem -d "{\"code\":\"$CODE\"}"     # prints {"token":...}
curl -s 127.0.0.1:8787/health
```

Try it: `POST /v1/decide` (Clef) and `POST /v1/transcribe` (a WAV body) with `authorization: Bearer <token>`.

The whole core-to-gateway test in one command (starts wrangler dev, runs the Rust client against it, stops it):

```bash
scripts/gateway-dev-test.sh
```

## 4. Point the app at a gateway (local or deployed)

- `MEWNDO_GATEWAY_URL` — the gateway URL (e.g. `http://127.0.0.1:8787` for wrangler dev on the same machine).
- The device token goes in **Windows Credential Manager**, never a file: a Generic credential named
  `Mewndo/gateway-device-token` whose password is the token
  (`cmdkey /generic:Mewndo/gateway-device-token /user:mewndo /pass:<token>`).
- The core's real HTTPS client is Windows-only; without URL and token, every decision is the rules'.

## 5. What is off by default

- **Computer use**: only when the core is started with `--computer-use` (no app setting yet), and it needs the
  pinned cua-driver release in `%LOCALAPPDATA%\Mewndo\vendor\cua-driver\`. Agents use it via
  `mewndo-core mcp-computer --agent <name>`.
- **Cua's own cursor motion**: the opt-in crate `core/optional/mewndo-cua-motion` (downloads Cua's ~367 MB repo):
  `cargo test --manifest-path core/optional/mewndo-cua-motion/Cargo.toml`.

## 6. Deploy later

From `cloud/gateway` (not the repo root): `npx wrangler login`, `npx wrangler deploy`,
`npx wrangler secret put ADMIN_SECRET`. No API key is needed anywhere.
