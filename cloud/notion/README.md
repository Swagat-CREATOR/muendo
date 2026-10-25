# mewndo-notion

Notion Rewind and Heal (spec §25.3, §6.4).

- **Webhooks + polling.** `POST /notion/webhook` handles Notion's verification
  handshake and treats an event as "look now"; a **one-minute cron polls**
  `search` sorted by `last_edited_time`, because webhooks alone miss changes.
- **Block snapshots** for pages shared with Mewndo, kept per-page over time in a
  Durable Object.
- **Restore:** `in_trash: false` on the current API version (`2022-06-28`), then
  the missing blocks appended back from the snapshot.
- **Rate limit:** about **3 requests per second** (`RateLimiter`), and it honours
  Notion's `retry-after` on 429 (three times at most).
- **Connect:** the app sends the user's internal integration secret once
  (`POST /notion/connect {token}`); the Worker checks it with `GET /v1/users/me`,
  keeps it in the account's Durable Object and returns an app token (src/app-auth.js).
  `MAX_ACCOUNTS` (default 3) caps how many workspaces one deploy polls. Notion OAuth
  is not built.
- **App routes** (app token): `/app/status`, `/app/sync`, `/app/changes`,
  `/app/disconnect`, `/notion/restore {pageIds?, before?}`.
- **Trash:** search leaves trashed pages out, so each poll also checks up to 10 known
  pages that dropped out of the results. Each poll snapshots at most 15 pages (the free
  plan's 50 subrequests per run).

> **Honest limit (spec §28.10), shown in the app:** Notion tells Mewndo about
> changes a minute or more late, so **Notion undo takes about one to two
> minutes** — unless the change went through Mewndo's MCP, which is immediate.
> Also: Notion has no "replace children" call, so restored blocks are appended
> and get **new block ids**.

## Deploy

```bash
cd cloud/notion
npx wrangler@3 login
npx wrangler@3 deploy      # creates the Durable Object and the one-minute cron; no secrets
```

Then in Mewndo → Connections → Notion → Connect, paste the integration's secret
(docs/connections-setup.md §4). Webhooks (`<url>/notion/webhook`) are optional.

## Tests

```bash
cd cloud/notion && npm test
```

Covers untrash, block restore, the rate limiter's spacing, the honest lag note, the
change list, connect and the app-token checks.
**Not deployed or tested against a live workspace yet.**
