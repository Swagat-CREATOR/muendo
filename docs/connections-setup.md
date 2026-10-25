# Switching on Connections: Gmail, Google Drive, Notion and GitHub

The Connections screen in Mewndo shows four cards. **GitHub** needs nothing deployed: Mewndo talks to
api.github.com from your PC. **Gmail, Google Drive and Notion** each go through a small Cloudflare Worker that
you deploy to **your own free Cloudflare account**, because Google and Notion only tell a public web address
about changes, and something has to keep watching while your PC is off. Until a Worker is deployed and its
address is in Mewndo, its card says **Not set up** and exactly what to deploy; it never pretends to be connected.

Everything below is free. Two optional extras are not, and are marked **(needs a payment card)**; Mewndo works
without them (CLAUDE.md rule 6).

## What is stored where

| What | Where | Never |
|---|---|---|
| GitHub token you paste | Windows Credential Manager, `Mewndo/github-token` | in a file, the log, or a Worker |
| Each Worker's app token (issued at sign-in) | Credential Manager, `Mewndo/gmail-app-token`, `Mewndo/drive-app-token`, `Mewndo/notion-app-token` | in a file or the log |
| Google sign-in (refresh token) | your Gmail/Drive Worker's Durable Object | on your PC |
| Notion integration secret | your Notion Worker's Durable Object (Mewndo hands it over once) | on your PC |
| Google client id and secret | Worker secrets (`wrangler secret put`), typed by you | in the repo |
| Worker addresses, account names, chosen repos, GitHub journal | `%APPDATA%\Mewndo\data\connections\` | secrets of any kind |

## 0. Once: tools and a Cloudflare account

1. Install Node.js 22 or newer.
2. Make a free account at <https://dash.cloudflare.com/sign-up> (no card needed for Workers and Durable Objects).
3. In a terminal: `npx wrangler@3 login` and allow it in the browser.

None of the Workers needs a KV namespace, a queue or a D1 database. Each one's Durable Object (SQLite, available
on the free plan) is created by its first `deploy` from the `[[migrations]]` block in its `wrangler.toml`; there is
no separate command. Cron triggers are created by `deploy` too.

## 1. Google Cloud (for Gmail and Drive)

Follow **docs/google-setup.md** (the clicks). In short: a project in **Testing** mode with you as a test user,
the Gmail and Drive APIs, and an OAuth client of type **Web application**. You add the Workers' callback addresses
to that client in step 2.4 and 3.4 below, once you know them.

> **Testing mode:** Google ends the sign-in after **7 days**. Mewndo's card warns before then and turns to
> **Connect again** when it happens; press it and sign in again. Publishing the app (Google verification for the
> restricted Gmail and Drive scopes) removes this, and takes weeks.

## 2. Gmail Worker (`cloud/gmail`)

1. `cd cloud/gmail`
2. `npx wrangler@3 deploy` — it prints the address, e.g. `https://mewndo-gmail.<you>.workers.dev`.
3. Type the secrets when asked (from Google Cloud → Credentials → your OAuth client):
   - `npx wrangler@3 secret put GOOGLE_CLIENT_ID`
   - `npx wrangler@3 secret put GOOGLE_CLIENT_SECRET`
4. In Google Cloud → Credentials → your OAuth client → **Authorized redirect URIs**, add
   `https://mewndo-gmail.<you>.workers.dev/oauth/callback`. Save.
5. Optional, **push** (changes noticed in seconds instead of every 3 minutes): Pub/Sub. Google asks for a
   billing account before it turns Pub/Sub on **(needs a payment card**; the first 10 GB a month are free).
   Follow docs/google-setup.md §5 with the push endpoint `https://mewndo-gmail.<you>.workers.dev/gmail/push`, then
   put your project id into `GOOGLE_PUBSUB_TOPIC` in `cloud/gmail/wrangler.toml` and run `npx wrangler@3 deploy`
   again. Without it, the card says "Push is off" and Mewndo asks the Worker to check every 3 minutes.

(`MEWNDO_DECIDE_URL` and `MEWNDO_DECIDE_TOKEN` are for Send Guard, not Connections; leave them unset.)

## 3. Drive Worker (`cloud/drive`)

1. `cd cloud/drive`
2. `npx wrangler@3 deploy` — note the address, e.g. `https://mewndo-drive.<you>.workers.dev`.
3. `npx wrangler@3 secret put GOOGLE_CLIENT_ID` and `npx wrangler@3 secret put GOOGLE_CLIENT_SECRET` (the same
   client as Gmail).
4. Add `https://mewndo-drive.<you>.workers.dev/oauth/callback` to the same OAuth client's redirect URIs.
   The Worker learns its own address when you connect, for Drive's push; you don't edit `WORKER_ORIGIN`.
5. Optional, **copies of deleted files** **(needs a payment card)**: Cloudflare asks for a card before it turns R2
   on, even for the free 10 GB. Only if you want it: enable R2 in the Cloudflare dashboard, run
   `npx wrangler@3 r2 bucket create mewndo-drive-copies`, remove the `#` from the three `[[r2_buckets]]` lines in
   `cloud/drive/wrangler.toml`, and deploy again. The Worker warns from 8 GB and stops copying at 10 GB rather
   than bill you. **Not built yet:** choosing the watched folders from the app; until then no copies are made,
   and the Drive card says files deleted forever can't come back.

## 4. Notion Worker (`cloud/notion`)

1. `cd cloud/notion`
2. `npx wrangler@3 deploy` — note the address, e.g. `https://mewndo-notion.<you>.workers.dev`. No secrets to set:
   it polls Notion every minute with the integration secret you give it from the app.
3. In Notion: <https://www.notion.so/profile/integrations> → **New integration** → type **Internal**, your
   workspace → Capabilities: Read content, Update content, Insert content → Save → copy the **Internal
   Integration Secret** (starts with `ntn_`).
4. On each page Mewndo should protect: **•••** → **Connections** → add your integration. Pages inside it are
   included.
5. `MAX_ACCOUNTS` in `wrangler.toml` (default 3) caps how many workspaces the Worker polls, because the connect
   route has no other sign-in: someone who finds the address can't make it poll theirs once you're connected.
6. Webhooks are optional and not needed: the minute poll is what Mewndo relies on.

Notion OAuth (a public integration) is **not built**; the internal-integration secret is the only way in.

## 5. Point Mewndo at the Workers

Either:

- **Settings → Connections**: paste each address (`https://mewndo-gmail.<you>.workers.dev`) and press Save, or
- environment variables, then restart Mewndo: `setx MEWNDO_GMAIL_URL https://mewndo-gmail.<you>.workers.dev`,
  `setx MEWNDO_DRIVE_URL …`, `setx MEWNDO_NOTION_URL …`. The Settings field wins when both are set.

Only `https://` addresses are accepted (and `http://localhost` for `npx wrangler@3 dev`).

Then, in the main window → **Connections**:

- **Gmail / Google Drive → Connect**: your browser opens Google's sign-in through your Worker. Allow it. Mewndo
  waits up to 5 minutes and picks up the sign-in by itself; the browser page never shows a token.
- **Notion → Connect**: paste the integration secret. Mewndo sends it to your Worker once, keeps only the app
  token the Worker returns, and clears the box.

## 6. GitHub (no Worker)

1. github.com → Settings → Developer settings → **Fine-grained tokens** → Generate new token.
2. Repository access: **Only select repositories** (the ones to protect).
3. Permissions → Repository: **Contents: Read and write**, **Issues: Read and write**, **Pull requests: Read and
   write** (Metadata: Read is added automatically). Pull requests is needed to reopen a closed pull request.
4. Copy the token (`github_pat_…`). In Mewndo → Connections → GitHub → **Add token…**, paste it. Mewndo checks it
   with GitHub, saves it to Credential Manager, then asks which repos to journal (up to 10).

Mewndo then polls every 5 minutes with ETags (unchanged answers don't count against GitHub's 5,000 requests an
hour) and journals each branch's head, the default branch's protection, and open/closed issues and pull requests.
Undo recreates a deleted branch at its journaled commit, moves a force-pushed branch back (always after a dialog
naming the branch and both commits, and a second one for the default branch), and reopens closed issues and pull
requests. It refuses when the branch has moved again since, rather than guess.

## 7. What each card can't do (also on the card)

- **Gmail:** no undelete; mail deleted forever can't come back (the Worker keeps no copy of mail). Sent mail can't
  be unsent. Only changes after connecting. 7-day re-sign-in in Testing mode.
- **Drive:** a file deleted forever comes back only from an R2 copy, as a new file with a new id (old share links
  break). Older content isn't put back (use Version history). 7-day re-sign-in in Testing mode.
- **Notion:** undo takes about one to two minutes (Notion reports changes late). Put-back blocks get new ids and
  go at the end of the page; only the top level (first 100 blocks) of pages shared with the integration.
- **GitHub:** only changes after journaling started; a deleted repository can't come back; moving a branch back
  rewrites history again; merged pull requests can't be reopened; branch protection can't be turned back on with
  this token.
- **Who did it:** consumer Gmail, Drive, Notion and GitHub don't say which app made a change, so Mewndo matches by
  time to the local agents it saw working ("likely") or shows "?" — never a certainty it doesn't have.

## 8. Not verified yet

Written and tested offline only (`node --test`, fake Workers and a fake api.github.com): no Worker has been
deployed, and nothing has run against a real Google, Notion or GitHub account. Writing to Windows Credential
Manager (`CredWriteW` through koffi) has not run on Windows. Expect the first real run to need small fixes.

## 9. Turning it off

- In Mewndo: **Disconnect** on a card removes its token from Credential Manager and asks the Worker to forget the
  account and its journal (Gmail and Drive also revoke Google's grant). For Notion, also remove the integration
  in Notion; for GitHub, delete the token on github.com.
- To remove a Worker: `npx wrangler@3 delete` in its folder. An R2 bucket stays until you delete it in the
  Cloudflare dashboard (Mewndo never deletes your copies on its own).
