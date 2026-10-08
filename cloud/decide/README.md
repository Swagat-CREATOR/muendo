# mewndo-decide

Mewndo's decision service (spec §26, §29) on **Cloudflare Workers AI**, free plan.
It takes a `state` and up to 64 questions (`noul` / `choice` / `score`, spec §29.5)
and returns probabilities. The model is called through one interface (`scoreWithModel`
in `src/index.js`) so it can later be switched to Clef, Jev or a self-hosted
Clef-flash without touching callers.

- **Auth:** every request needs `Authorization: Bearer <MEWNDO_DECIDE_TOKEN>`.
- **Cache:** identical `(state, questions)` reuse the last model answer for ~3 min.
- **Neuron budget:** a Durable Object counts a flat estimate per model call and
  stops calling the model at **9,000 neurons/day**, returning a `source:"rules"`
  answer instead, to stay inside the free 10,000.
- **Latency:** every call logs `latency_ms` (see `wrangler tail`).

## Deploy (your Cloudflare account — I can't do this from the repo)

```bash
cd cloud/decide
npm install                      # installs wrangler locally
npx wrangler login               # browser sign-in to your Cloudflare account
npx wrangler secret put MEWNDO_DECIDE_TOKEN   # paste a long random token; never commit it
npx wrangler deploy              # prints the Worker URL
```

`wrangler deploy` prints a `https://mewndo-decide.<subdomain>.workers.dev` URL.
Give that URL and the token to P4.2 (the core reads them from config) and P4.3
(the latency script).

> Honest limits (spec §28.10): Workers AI does not publish GPU location or
> percentile guarantees, so measure real latency with P4.3 before any claim.
> The neuron count is a flat per-call estimate — re-measure the true cost on
> your account and set `DECIDE_NEURONS_PER_CALL` in `wrangler.toml`. If the model
> errors or the daily cap is hit, the service returns neutral `rules` answers so
> the core decides locally; it never guesses an approval.

## Test the deployed Worker

```bash
curl -s https://mewndo-decide.<subdomain>.workers.dev \
  -H "Authorization: Bearer $MEWNDO_DECIDE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"state":{"brief":"Reply to Priya at acme.com"},
       "questions":[{"id":"recipient_ok","type":"noul","text":"Is every recipient the person the brief names?"}]}'
```

Expected: a JSON body with `answers`, `source`, `latency_ms` and `neurons_used`.

## Local logic tests (no account needed)

```bash
cd cloud/decide && npm test
```

Covers request validation, the order-independent cache key, the daily neuron
cap, and model-output parsing with per-question rule fallback.
