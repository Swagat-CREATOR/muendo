# Decision service latency (P4.3)

**Not measured yet.** `MEWNDO_DECIDE_URL` and `MEWNDO_DECIDE_TOKEN` must be set and
the Worker (P4.1) deployed. I can't deploy from the repo, so run this on your PC:

```bash
MEWNDO_DECIDE_URL=https://mewndo-decide.<you>.workers.dev \
MEWNDO_DECIDE_TOKEN=<the secret> \
node scripts/latency.js
```

It sends 500 realistic decision requests (the rule types in spec §24.1 plus the
email checks in §28.4) and overwrites this file with p50/p95/p99 latency, the
fallback rate and neurons used. Paste the numbers back — they decide whether
self-hosted GPUs are ever needed (spec §29.6).
