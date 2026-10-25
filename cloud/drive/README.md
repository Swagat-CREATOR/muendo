# mewndo-drive

Drive Rewind and Heal (spec §25.3, §6.3).

- **changes.watch** renewed daily by cron, before it expires, each renewal
  followed by **changes.list** (a push only says "something changed").
- **Journal:** trash state, parent folders and head revision per file, in a
  per-user Durable Object.
- **Heal:** untrash and restore the original parent folders and names; also puts
  back files that were *moved* out of scope.
- **Copies (optional, off by default):** with an R2 bucket bound as `COPIES`, files in
  folders you mark watched (`POST /drive/watched`) are copied **inside R2's free 10 GB**.
  Mewndo **warns from 8 GB and stops copying at 10 GB** rather than running up a bill
  (CLAUDE.md rule 6). Cloudflare asks for a payment card before turning R2 on, so the
  binding is commented out in `wrangler.toml`. Check with `GET /drive/budget`. The app
  has no folder picker for watched folders yet.
- **App routes:** the same sign-in claim, app token and `/app/status|sync|changes|disconnect`
  routes as cloud/gmail (see its README); `/drive/restore {fileIds?, before?}`,
  `/drive/watched` and `/drive/budget` need the app token and take the account from it.

> **Honest limits (spec §28.10):** a permanently deleted file can only come back
> from a copy Mewndo made first, and it comes back as a **new file with a new
> Drive id — old share links stop working and must be redone**. Files outside
> watched folders have no copy, and `/drive/restore` says so instead of pretending.

## Deploy

```bash
cd cloud/drive
npx wrangler@3 login
npx wrangler@3 deploy                          # creates the Durable Object and the cron
npx wrangler@3 secret put GOOGLE_CLIENT_ID      # you type it
npx wrangler@3 secret put GOOGLE_CLIENT_SECRET
```

Add `<worker-url>/oauth/callback` to the OAuth client's redirect URIs. The Worker
learns its own address at sign-in for the Drive push callback. Optional R2:
`npx wrangler@3 r2 bucket create mewndo-drive-copies` (needs R2 enabled, which needs a
card), uncomment `[[r2_buckets]]` in `wrangler.toml`, deploy again.

## Test (spec P6.3 "You should see")

With a test account connected: trash a file and rename another, then press Undo in
Mewndo's Drive card. Expect both back; a permanently deleted file without a copy is
listed as "can't come back".

## Status

Written but **not deployed or tested against a live account** (needs your Google
project and a Drive test file). The Heal planner, the R2 budget, the journal helpers and
the app routes are unit-tested offline: `npm test`.
