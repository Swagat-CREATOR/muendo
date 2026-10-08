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
  Notion's `retry-after` on 429.

> **Honest limit (spec §28.10), shown in the app:** Notion tells Mewndo about
> changes a minute or more late, so **Notion undo takes about one to two
> minutes** — unless the change went through Mewndo's MCP, which is immediate.
> Also: Notion has no "replace children" call, so restored blocks are appended
> and get **new block ids**.

## Deploy

```bash
cd cloud/notion
npm install
npx wrangler login
npx wrangler deploy
```

Add the deployed `<url>/notion/webhook` as the webhook endpoint in your Notion
integration, and share with the integration only the pages Mewndo should protect.

## Tests

```bash
cd cloud/notion && npm test
```

Covers untrash, block restore, the rate limiter's spacing and the honest lag note.
**Not deployed or tested against a live workspace yet.**
