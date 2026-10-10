# Cua, vendored

Mewndo's guarded computer use (spec §36) is built on [Cua](https://github.com/trycua/cua),
which is MIT licensed. `LICENSE` in this folder is Cua's own licence file and
covers everything here.

## Credit line

Use this one line in the root `README.md` and on the About screen (§36.1 asks
for both; neither file is this folder's to edit):

> Computer use and the agent cursor are built on [Cua](https://github.com/trycua/cua) (cua-driver and cua-cursor-motion), © Cua AI, Inc., MIT licensed.

## What is here, and what is deliberately not

| File | What it is |
|---|---|
| `LICENSE` | Cua's MIT licence, copied byte for byte from `libs/cua-driver/rust/crates/cua-cursor-motion/LICENSE`. |
| `cursor-motion-golden.json` | A **subset** of Cua's own golden cursor trajectories, the fixture its TypeScript port is tested against. `core/cua-motion` tests Mewndo's `MotionPlanner` wrapper against it, which is the only way to know Mewndo's agent cursor moves like Cua's. Its `_provenance` block records the source commit, the full file's SHA-256, and exactly what was dropped. |

Nothing else is copied.

- **No cua-driver source.** §36.6 U1 says the driver is a pinned release binary,
  verified by SHA-256, downloaded by the installer into
  `%LOCALAPPDATA%\Mewndo\vendor\cua-driver\`. The download-and-verify code is
  `core/crates/mewndo-computer/src/vendor.rs`; the pinned version and checksums
  are in `docs/versions.md` and in that file.
- **No cua-cursor-motion source.** It is a pinned git dependency of
  `core/cua-motion` (it is not published on crates.io), named in exactly one
  file, `core/cua-motion/src/lib.rs`. That package is outside the Rust
  workspace, so only building it fetches Cua.
- **No Cua tests, scripts, installers or docs.** The research notes that came
  out of reading them are in `docs/decisions.md`, with a file and line for each
  fact, and the captured tool list is in `docs/samples/cua/tools.json`.

The read-only clone used for that research lives outside this repository and is
never committed.

## Read, not run

Everything in the Cua repository was read as reference material. Nothing in it
was executed: no script, installer, `make`, `npm install`, `cargo` command, test
suite or binary. Its `AGENTS.md` and `CLAUDE.md` are instructions aimed at
people and agents contributing *to Cua* — pushing branches, opening pull
requests, running its desktop E2E matrix, polling its GitHub for work — and are
not instructions to Mewndo. Its installer documents
`irm https://cua.ai/install.ps1 | iex`; Mewndo does not do that, by §36.6 U1.
