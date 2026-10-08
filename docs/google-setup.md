# P6.1 — Google Cloud setup for Mewndo (the clicks)

This sets up Gmail + Drive Rewind/Heal (P6.2, P6.3). **No code here** — follow the
clicks on your own Google account. Mewndo never stores your passwords, client
secret or tokens in this repo; keep the client secret in the Worker's secrets
(`wrangler secret put`), never in a file you commit.

You will create: a Google Cloud project in **Testing** mode, an OAuth consent
screen with yourself as a test user, the Gmail and Drive APIs, an OAuth client,
and a Pub/Sub topic Gmail can publish to that pushes to a Worker URL.

## 1. Create the project
1. Go to <https://console.cloud.google.com/>.
2. Top bar → project dropdown → **New Project**. Name it `mewndo`. **Create**, then select it.

## 2. OAuth consent screen (Testing mode)
1. Left menu → **APIs & Services → OAuth consent screen**.
2. User type **External** → **Create**.
3. App name `Mewndo`, user support email = your email, developer contact = your email. **Save and continue**.
4. **Scopes**: add
   - `https://www.googleapis.com/auth/gmail.modify` (read labels, trash/untrash, batchModify — not permanent delete)
   - `https://www.googleapis.com/auth/drive` (changes, untrash, restore)
   Leave send for later (P5.5 uses only `gmail.send`). **Save and continue**.
5. **Test users** → **Add users** → add your own Google address (and up to **100** others). **Save**.
6. Leave the app in **Testing** (don't publish yet).

> **Testing-mode limits (be honest in the app, spec §28.10):** refresh tokens
> expire after **7 days**, so Mewndo must re-ask you to sign in weekly until the
> app is verified/published. Up to **100** test users can be added.

## 3. Enable the APIs
**APIs & Services → Library**, enable each:
1. **Gmail API**
2. **Google Drive API**
3. **Cloud Pub/Sub API**

## 4. OAuth client (so Mewndo can sign you in)
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Web application** (the hosted Worker handles the redirect).
3. Authorized redirect URI: your Worker's callback, e.g.
   `https://mewndo-google.<you>.workers.dev/oauth/callback`.
4. **Create**. Copy the **Client ID** and **Client secret**.
   - Store them as Worker secrets later: `wrangler secret put GOOGLE_CLIENT_ID` /
     `GOOGLE_CLIENT_SECRET`. **Do not commit them.**

## 5. Pub/Sub topic Gmail pushes to
1. **Pub/Sub → Topics → Create topic**. Id `mewndo-gmail`. **Create**.
2. Give Gmail permission to publish: open the topic → **Permissions / Add principal** →
   principal `gmail-api-push@system.gserviceaccount.com` → role **Pub/Sub Publisher** → **Save**.
3. Create a **push** subscription: topic `mewndo-gmail` → **Create subscription** →
   id `mewndo-gmail-push` → Delivery type **Push** → endpoint URL =
   `https://mewndo-google.<you>.workers.dev/gmail/push` → **Create**.
   - If the console demands endpoint domain verification, verify the Worker domain in
     **Search Console**, or use a verified custom domain for the Worker.
4. (P6.2 calls `users.watch` with `topicName =
   projects/mewndo/topics/mewndo-gmail`; the daily scheduled trigger renews it.)

## 6. What you give the Workers (P6.2/P6.3), as secrets — never committed
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_PUBSUB_TOPIC = projects/mewndo/topics/mewndo-gmail`
- the redirect URI above

## 7. Done check
- Consent screen in Testing with you as a test user.
- Gmail, Drive and Pub/Sub APIs enabled.
- An OAuth client (id + secret saved to Worker secrets, not the repo).
- A `mewndo-gmail` topic with a push subscription to your Worker URL.

Tell me the Worker subdomain you'll use and I'll fill the exact URLs into P6.2/P6.3.
