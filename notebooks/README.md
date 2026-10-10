# notebooks

Mewndo no longer uses Kaggle: the decision gateway answers from its cache, then Workers AI, then the device's
rules (`cloud/gateway`). The Kaggle server notebook was removed on 10 Oct 2026.

## `evalset/guard20.json` — 20 Guard cases

20 Guard cases in the §34.3 shape with the answer each should agree with, drawn from the §34.4 verdict table.
They are hand-written from the verdict table, not recorded model answers (the file says so itself). Once the
gateway is deployed, they are the first check of Workers AI's answers against the rules.
