# mewndo-gmail

Gmail Rewind and Heal (spec §25.3, §28.4). A Cloudflare Worker that journals every
message's labels and trash state and puts out-of-scope changes back.

- **Watch renewal:** a daily cron renews `users.watch` (Gmail watches expire in 7 days).
- **Push + reconcile:** `POST /gmail/push` receives Pub/Sub pushes but **always**
  reconciles with `history.list`, because Gmail drops notifications above 1/sec.
- **Journal:** per-user Durable Object stores each touched message's labels, trash
  and `gone` state over time.
- **Heal:** `POST /gmail/restore` restores with one `batchModify` to untrash and one
  per distinct label change (`src/heal.js`, unit-tested). It needs the app token.

> **Honest limit (spec §28.10):** permanently deleted mail can only come back from a
> copy Mewndo made *before* deletion — Gmail has no undelete. `/gmail/restore` returns
> such messages under `permanently_deleted`, not `restored`.

## Send Guard (spec §28.4 Flow D, §29.4, §29.5 — P5.5)

`POST /gmail/send` with `{ user, message, context }`. All the decision logic is in
`src/send-guard.js`, which is runtime-free and unit-tested; the route is plumbing.

1. **Rules, locally, no network** (`checkRules`, §28.4 step 2): first-time recipient,
   a recipient who is a known contact but is not part of *this* task, look-alike
   domain (homoglyph skeleton, or one edit away from a known domain), too many
   recipients, external recipient with attachments, secrets and personal data in
   the body or an attachment name, leftover placeholders.
2. **Context** (§28.4 step 3): each recipient is looked up in the brief, the
   thread's participants and the Continue card.
3. **One** decision-service call with all four questions batched (§28.4 step 4,
   §29.5 shape, `recipient_ok` / `attachment_ok` / `matches_task` / `no_secrets`).
4. **Release only if every rule passed and P(allow) ≥ 0.97** (§28.4 step 5).
   `allow` is the *lowest* of the four answers, so one confident "no" sinks the send.

**Never a send without a verdict** (§29.4): a deadline timeout (100 ms default), a
transport error, an answer in a shape we can't parse, and a rules-only fallback from
the decision service are all holds. There is no code path from "we don't know" to
"sent". Every decision is logged with the verdict, rule hits, `allow`, `rules_ms`
and `latency_ms` — and never the subject, the body or a recipient address (domains,
counts and 64-bit FNV-1a fingerprints only).

The Gmail call uses **only `gmail.send`**. `assertSendOnlyScope()` refuses a token
granted anything more, and Send Guard reads a separate `send_refresh_token` so a bug
here cannot read the mailbox and a bug in Heal cannot send.

### What Send Guard can't do

- **Not run against a real account.** `sendViaGmail()` is written from the
  `users.messages.send` reference, never from a successful call. Treat it as
  unverified until P6.1's test mailbox has sent one message through it.
- **No attachments are sent.** `buildRawMessage` writes one `text/plain` part. The
  rules check attachment *names*, which is all this Worker ever receives — it never
  sees attachment bytes, so it cannot scan their contents.
- **No hold queue, no countdown chip.** A hold is returned to the caller (HTTP 202)
  and nothing is stored. The queue, the chip on the bar and the phone approval are
  `cloud/mcp` and `apps/desktop`, not built here.
- **No second opinion.** §28.4 step 5 sends the 0.80–0.97 band to Clef 27B or Jev
  inside the hold window. Not built: P5.5 says one call, so that band simply holds.
- **Patterns, not understanding.** Secrets, personal data and placeholders are regex
  shapes. Both false positives and false negatives are possible; the bias is
  deliberate, because a false hold costs a click and a false send costs the secret.
  The look-alike table is a short confusables list, not the full Unicode set, and
  punycode is never decoded — an unknown `xn--` domain is held on sight.
- **Addresses only.** "Priya" in a brief does not make `priya@acme.com` known; the
  address has to appear literally. That holds some legitimate first sends.
- **`max recipients` is 10 by default and is not a spec figure** — the spec names the
  rule, not a number. Override with `context.maxRecipients`.
- **No measured latency.** The rule pass has a 5 ms budget (§28.4) and a test asserts
  it on whatever machine runs the tests. No end-to-end figure is claimed; §29.4's
  100 ms is a deadline the code enforces, not something measured here.
- **`§34.3` is not in this repo.** The build prompt cites it for the request shape;
  `docs/spec.md` stops at §31, so the shape follows §29.5 plus what
  `cloud/gateway/src/gateway.js` `validateDecideRequest`/`parseClefAnswers` accept.

## How the app talks to it (docs/connections-setup.md)

- **Sign-in:** the app opens `GET /oauth/start?claim=<sha256(secret)>`; after Google's callback the Worker parks an
  app token under that hash for 10 minutes and the app collects it once with `POST /oauth/claim {claim: secret}`.
  The token goes to Windows Credential Manager; the Worker keeps only its SHA-256 (`src/app-auth.js`).
- **App routes** (all need `Authorization: Bearer <app token>`; the account comes from the token, never the body):
  `GET /app/status`, `POST /app/sync` (reconcile now; the app calls it every 3 minutes, so Pub/Sub is optional),
  `GET /app/changes` (the journal as changes, with subjects for the newest 20), `POST /gmail/restore
  {messageIds?, before?}` (`before` = put each message back as it was just before that time), `POST /app/disconnect`
  (stop the watch, revoke Google's grant, forget the account).
- **Journal without a call per message:** `history.list` records carry labels and the labels added/removed, so the
  state *before* the first change Mewndo sees is walked back from them (`historyToEntries`). Mewndo's own restores
  are journaled as `by: "mewndo"` and not shown as an agent's change.

## Deploy

```bash
cd cloud/gmail
npx wrangler@3 login
npx wrangler@3 deploy                          # prints the Worker URL; creates the Durable Object and the cron
npx wrangler@3 secret put GOOGLE_CLIENT_ID      # you type it
npx wrangler@3 secret put GOOGLE_CLIENT_SECRET
```

Add `<worker-url>/oauth/callback` to the OAuth client's redirect URIs. Pub/Sub push (`<worker-url>/gmail/push`,
`GOOGLE_PUBSUB_TOPIC` in `wrangler.toml`) is optional and needs a Google billing account.

## Measure restore time (spec P6.2 "You should see")

With a test account connected, trash 1 message then 100, then press Undo on the burst in Mewndo (or call
`/gmail/restore` with the app token). The response includes `ms`. Target: 2–10 s for one message, under 15 s for 100.

## Status

Written here but **not deployed or tested against a live account** (needs your
Google Cloud project and a test mailbox). The Heal planner, the journal helpers and
the app routes (with a fake Durable Object) are unit-tested offline: `npm test`.
`/gmail/send` still takes `user` from the body; it can't send until a `send_refresh_token`
exists, which nothing grants yet.
