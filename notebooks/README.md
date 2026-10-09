# notebooks

Kaggle notebooks for Mewndo.

## `clef-kaggle-server.ipynb` — the second decision backend (spec §37.4, §37.6 K10)

Serves `Cloudflare/clef-flash` on Kaggle's two free T4s and registers itself with the
`mewndo-cloud` gateway. The gateway then sends it the **loose-deadline** calls — `triage`,
`receipt`, `showme` — and keeps the free Workers AI neurons for the calls an agent is
blocked on (§37.3).

**Run it:** Accelerator **GPU T4 x2**, Internet **on**, then **Save Version → Save & Run
All** (a background run, up to 12 hours, with no 20-minute idle timeout). Add three Kaggle
Secrets first: `HF_TOKEN`, `GATEWAY_SECRET` (the same value as the gateway's
`wrangler secret put GATEWAY_SECRET`) and `GATEWAY_URL`.

Attach `evalset/guard20.json` as a dataset, or run with the repo attached.

**Contract with the gateway** (enforced in `cloud/gateway/src/gateway.js`):

| Direction | Call |
|---|---|
| notebook → gateway | `POST /internal/backend` `{url, p50_ms}`, `authorization: Bearer <GATEWAY_SECRET>`, url must be https |
| gateway → notebook | `POST <tunnel>/v1/systemone`, same bearer, a §34.3 `{state, questions}` body |
| answers | `{"answers": {"<id>": …}}` where noul is `{"p_yes": 0..1}`, score is `{"value": <inside that question's own scale>}`, choice is `{"probabilities": {option: 0..1}}` |

A score outside its scale and a choice without a distribution are both **rejected** by the
gateway, on purpose: a 0..1 answer to a 1..5 risk question must never read as "risk 1", and
§34.4 branches on a choice's confidence.

## `evalset/guard20.json` — the smoke test

20 Guard cases in the §34.3 shape with the answer each should agree with, drawn from the
§34.4 verdict table. **Fewer than 18 of 20 and the notebook must not register**: a backend
that disagrees with the rules is worse than no backend, because the gateway would route real
decisions to it.

§37.4 asks for "the answers recorded from Workers AI". Workers AI has never been called from
this repo, so these are hand-written from the verdict table instead. That is recorded inside
the file itself.

## Honest limits

- **Nothing here has been run.** No Kaggle session, no GPU, no tunnel, no registration.
- **The loading path is a guess.** Cell 4 prints the model card and `joint_schema_model.py`
  and tells you to read the loading class and scoring entry point out of them, because
  §32.5 rule 3 lists them as unverified. Plan B (the Clef vLLM plugin with
  `tensor_parallel_size=2`, or the W4A16 build on one T4) is written down, commented out.
- **The scoring call in cell 5 is the weakest part.** `_p_yes` calls `model.score(...)` and
  raises a clear error if no such entry point exists. clef-flash is a System One scorer, so
  the real path is its own joint-schema call, not generation — fix `_p_yes` once cell 4's
  output names it, and record which plan worked in `docs/decisions.md`.
- **Speed is unmeasured.** §37.4 estimates 0.5 to 1.5 s per decision, which is why Kaggle
  serves only loose-deadline calls. The notebook reports a real rolling median to the
  gateway, which refuses to use it for a tight deadline unless that median fits.
- **Quota:** about 30 GPU hours a week, at most 12 hours per run. Schedule runs around the
  demo windows.
- **The quick tunnel URL changes on every restart.** Cell 9 re-registers instead of
  hard-coding it, and testers never see it.
- **Standing down is passive.** The gateway validates that a backend URL is https, so there
  is no "I am going away" call: the notebook just stops, and three missed 60-second
  heartbeats mark it down within three minutes.
