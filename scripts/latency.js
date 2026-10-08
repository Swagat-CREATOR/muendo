#!/usr/bin/env node
'use strict'
// P4.3: measure the decision service from this PC. Sends 500 realistic decision
// requests to the deployed mewndo-decide Worker and reports p50/p95/p99 latency,
// the fallback rate and neurons used, into docs/latency.md. Changes no product
// code (spec P4.3: "just measure").
//
//   MEWNDO_DECIDE_URL=https://mewndo-decide.<you>.workers.dev \
//   MEWNDO_DECIDE_TOKEN=<the secret you set with wrangler> \
//   node scripts/latency.js [count]
const fs = require('node:fs')
const path = require('node:path')

const URL = process.env.MEWNDO_DECIDE_URL
const TOKEN = process.env.MEWNDO_DECIDE_TOKEN
const COUNT = Number(process.argv[2]) || 500
const OUT = path.join(__dirname, '..', 'docs', 'latency.md')

// Realistic decision requests covering the rule types in spec §24.1 plus the
// email checks in §28.4 (wrong recipient, look-alike domain, wrong attachment).
function sampleRequest(i) {
  const cases = [
    {
      state: { brief: 'Reply to Priya at acme.com with the Q3 invoice. Don\'t email anyone else.',
        action: { type: 'send_email', to: ['priya@acme.co'], subject: 'Q3 invoice', attachments: [{ name: 'invoice_Q3_Globex.pdf' }] },
        context: { first_time_recipient: true } },
      questions: [
        { id: 'recipient_ok', type: 'noul', text: 'Is every recipient the person the brief names?' },
        { id: 'attachment_ok', type: 'noul', text: 'Does the attachment belong to this recipient?' },
        { id: 'matches_task', type: 'noul', text: 'Does this email do what the brief asks?' },
      ],
    },
    {
      state: { brief: 'Refactor the auth module in C:/proj/app. Do not touch tests.',
        action: { type: 'delete', path: 'C:/proj/app/test/auth.test.js' } },
      questions: [{ id: 'in_scope', type: 'noul', text: 'Is deleting this file within the brief?' }],
    },
    {
      state: { brief: 'Tidy docs in C:/proj/app.', action: { type: 'shell', command: 'rm -rf build' } },
      questions: [
        { id: 'destructive', type: 'score', text: 'How destructive is this command, 0 to 1?' },
        { id: 'allowed', type: 'noul', text: 'Did the brief allow destructive deletes?' },
      ],
    },
    {
      state: { brief: 'Update README in C:/proj/app.', action: { type: 'write', path: 'C:/other/x.txt' } },
      questions: [{ id: 'in_scope', type: 'noul', text: 'Is this write inside the brief\'s folders?' }],
    },
    {
      state: { brief: 'Clean temp files in C:/proj/app.', action: { type: 'read', path: 'C:/proj/app/.env' } },
      questions: [{ id: 'secret', type: 'noul', text: 'Is this a secret file an agent should never read?' }],
    },
    {
      state: { brief: 'Send the weekly update.',
        action: { type: 'send_email', to: Array.from({ length: 14 }, (_, n) => `p${n}@example.com`), subject: 'Update' } },
      questions: [{ id: 'too_many', type: 'noul', text: 'Are there too many recipients for a routine update?' }],
    },
  ]
  return cases[i % cases.length]
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

async function main() {
  if (!URL || !TOKEN) {
    const msg = 'MEWNDO_DECIDE_URL and MEWNDO_DECIDE_TOKEN must be set (deploy P4.1 first). See cloud/decide/README.md.'
    writeNotRun(msg)
    console.error(msg)
    process.exit(1)
  }
  const latencies = []
  let fallbacks = 0
  let errors = 0
  let neuronsUsed = 0
  for (let i = 0; i < COUNT; i++) {
    const body = JSON.stringify(sampleRequest(i))
    const t0 = Date.now()
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body,
      })
      const dt = Date.now() - t0
      latencies.push(dt)
      const json = await res.json().catch(() => ({}))
      if (json.source === 'rules') fallbacks++
      if (typeof json.neurons_used === 'number') neuronsUsed = Math.max(neuronsUsed, json.neurons_used)
    } catch (e) {
      errors++
    }
  }
  latencies.sort((a, b) => a - b)
  const report = {
    count: COUNT,
    sent: latencies.length,
    errors,
    p50_ms: pct(latencies, 50),
    p95_ms: pct(latencies, 95),
    p99_ms: pct(latencies, 99),
    fallback_rate: latencies.length ? +(fallbacks / latencies.length).toFixed(4) : 0,
    neurons_used_today: neuronsUsed,
    url: URL.replace(/\/\/[^/]+/, '//<worker>'), // host hidden; token never logged
    at: new Date().toISOString(),
  }
  writeReport(report)
  console.log(JSON.stringify(report, null, 2))
}

function writeReport(r) {
  const md = `# Decision service latency (P4.3)

Measured from this PC against the deployed \`mewndo-decide\` Worker with
\`node scripts/latency.js\`. End-to-end latency includes home-internet round-trip,
so it is **not** the in-data-centre model latency the §29.4 SLOs target.

| Metric | Value |
|---|---|
| Requests | ${r.sent} / ${r.count} |
| Errors | ${r.errors} |
| p50 | ${r.p50_ms} ms |
| p95 | ${r.p95_ms} ms |
| p99 | ${r.p99_ms} ms |
| Fallback rate (\`source:"rules"\`) | ${(r.fallback_rate * 100).toFixed(2)} % |
| Neurons used today (max seen) | ${r.neurons_used_today} |
| Worker | ${r.url} |
| Measured at | ${r.at} |

These numbers decide whether self-hosted GPUs are ever needed (spec §29.6):
if p95 misses the 60 ms hook deadline often, move to self-hosted Clef-flash.
`
  fs.writeFileSync(OUT, md)
}

function writeNotRun(reason) {
  fs.writeFileSync(OUT, `# Decision service latency (P4.3)

**Not measured yet.** ${reason}

Run after deploying the Worker (P4.1):

\`\`\`bash
MEWNDO_DECIDE_URL=https://mewndo-decide.<you>.workers.dev \\
MEWNDO_DECIDE_TOKEN=<the secret> \\
node scripts/latency.js
\`\`\`

It sends 500 realistic requests and fills this file with p50/p95/p99, the
fallback rate and neurons used.
`)
}

main()
