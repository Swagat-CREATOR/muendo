# mewndo-drive

Drive Rewind and Heal (spec §25.3, §6.3).

- **changes.watch** renewed daily by cron, before it expires, each renewal
  followed by **changes.list** (a push only says "something changed").
- **Journal:** trash state, parent folders and head revision per file, in a
  per-user Durable Object.
- **Heal:** untrash and restore the original parent folders; also puts back files
  that were *moved* out of scope.
- **Copies:** for folders you mark watched (`POST /drive/watched`), a copy goes to
  **Cloudflare R2 inside the free 10 GB**. Mewndo **warns from 8 GB and stops
  copying at 10 GB** rather than running up a bill (CLAUDE.md rule 6). Check with
  `GET /drive/budget?user=…`.

> **Honest limits (spec §28.10):** a permanently deleted file can only come back
> from a copy Mewndo made first, and it comes back as a **new file with a new
> Drive id — old share links stop working and must be redone**. Files outside
> watched folders have no copy, and `/drive/restore` says so instead of pretending.

## Deploy

```bash
cd cloud/drive
npm install
npx wrangler login
npx wrangler r2 bucket create mewndo-drive-copies
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

Then set `WORKER_ORIGIN` in `wrangler.toml` to the deployed URL and redeploy, so
the Drive watch callback points at the right host.

## Test (spec P6.3 "You should see")

With a test account connected: trash a file, and permanently delete another that
was in a watched folder, then

```bash
curl -s <worker-url>/drive/restore -H 'content-type: application/json' -d '{"user":"you@gmail.com"}'
```

Expect the trashed one under `restored` and the deleted one under `reuploaded`
with the new-id warning.

## Status

Written but **not deployed or tested against a live account** (needs your Google
project and a Drive test file). The Heal planner and the R2 budget are unit-tested
offline: `npm test`.
