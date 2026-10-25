#!/usr/bin/env bash
# Tests the core's Clef client (core/crates/mewndo-core/src/clef_gateway.rs) against the real gateway Worker
# under `wrangler dev`, with a stubbed AI binding (cloud/gateway/dev/stub-ai.js). Needs no Cloudflare account and
# spends no neurons. Everything lives in a temporary folder that is removed afterwards.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
port="${PORT:-8797}"
secret="local-$RANDOM$RANDOM"   # a throwaway admin secret for this local run only
cleanup() { [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; rm -rf "$tmp"; }
trap cleanup EXIT

[ -x "$root/cloud/gateway/node_modules/.bin/wrangler" ] || (cd "$root/cloud/gateway" && npm ci --no-audit --no-fund)
(cd "$root/cloud/gateway" && WRANGLER_SEND_METRICS=false exec npx wrangler dev -c dev/wrangler.stub.toml \
  --ip 127.0.0.1 --port "$port" --var "ADMIN_SECRET:$secret" --persist-to "$tmp/state") >"$tmp/wrangler.log" 2>&1 &
pid=$!
url="http://127.0.0.1:$port"
for _ in $(seq 1 60); do curl -sf "$url/health" >/dev/null && break; sleep 1; done
curl -sf "$url/health" >/dev/null || { cat "$tmp/wrangler.log"; exit 1; }

code="$(curl -sf -XPOST "$url/admin/invites" -H "x-admin-secret: $secret" -d '{"count":1}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).codes[0]))')"
token="$(curl -sf -XPOST "$url/invite/redeem" -d "{\"code\":\"$code\"}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')"

export PATH="$HOME/.cargo/bin:$PATH"
MEWNDO_GATEWAY_DEV_URL="$url" MEWNDO_GATEWAY_DEV_TOKEN="$token" \
  cargo test --manifest-path "$root/core/Cargo.toml" -p mewndo-core clef_gateway -- --nocapture
grep -E '"at":"decide"|/v1/decide' "$tmp/wrangler.log"
