# mewndo-gmail

Gmail Rewind and Heal (spec §25.3, §28.4). A Cloudflare Worker that journals every
message's labels and trash state and puts out-of-scope changes back.

- **Watch renewal:** a daily cron renews `users.watch` (Gmail watches expire in 7 days).
- **Push + reconcile:** `POST /gmail/push` receives Pub/Sub pushes but **always**
  reconciles with `history.list`, because Gmail drops notifications above 1/sec.
- **Journal:** per-user Durable Object stores each touched message's labels, trash
  and `gone` state over time.
- **Heal:** `POST /gmail/restore` restores with one `batchModify` to untrash and one
  per distinct label change (`src/heal.js`, unit-tested).

> **Honest limit (spec §28.10):** permanently deleted mail can only come back from a
> copy Mewndo made *before* deletion — Gmail has no undelete. `/gmail/restore` returns
> such messages under `permanently_deleted`, not `restored`.

## Deploy (needs your Google project from P6.1 — I can't deploy from the repo)

```bash
cd cloud/gmail
npm install
npx wrangler login
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy          # prints the Worker URL
```

Set the Pub/Sub push subscription endpoint (P6.1) to `<worker-url>/gmail/push` and
the OAuth redirect URI to `<worker-url>/oauth/callback`.

## Measure restore time (spec P6.2 "You should see")

With a test account connected, trash 1 message then 100, then:

```bash
curl -s <worker-url>/gmail/restore -H 'content-type: application/json' \
  -d '{"user":"you@gmail.com"}'
```

The response includes `ms`. Target: 2–10 s for one message, under 15 s for 100.

## Status

Written here but **not deployed or tested against a live account** (needs your
Google Cloud project and a test mailbox). The Heal planner (`src/heal.js`) is
unit-tested offline: `npm test`.
