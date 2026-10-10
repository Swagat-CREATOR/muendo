# Pinned versions

Every version this repository actually names, and whether it is pinned exactly or only to a compatible range
(spec §32.5 rule 4). Read on 9 October 2026; nothing was changed to write this page.

- **Exact** means the file names one version and a build gets that version.
- **Caret** means a range: `^4.0.3` in npm, and a bare `1.0.228` in Cargo, both mean "this or any later
  compatible version". A caret range is only reproducible because a lock file records what was resolved.

## Rust

| What | Where | Value | Pinned |
|---|---|---|---|
| Toolchain | nowhere in the repo | no `rust-toolchain.toml`, no `.cargo/config.toml` | **not pinned** |
| Toolchain, as asked for | spec §32.5 rule 4 | stable through rustup, with Visual Studio 2022 Build Tools | prose, not a file |
| Target, CI | `.github/workflows/ci.yml` | the `windows-latest` runner's preinstalled MSVC toolchain, so `x86_64-pc-windows-msvc`; the workflow adds clippy and pins no Rust version | not pinned |
| Target, dev box | `core/README.md` | `x86_64-pc-windows-gnu`, no Visual Studio needed | not pinned |
| Edition | `core/Cargo.toml` `[workspace.package]` | `2024` | exact |
| Resolver | `core/Cargo.toml` `[workspace]` | `3` | exact |
| Crate version | `core/Cargo.toml` `[workspace.package]` | `0.1.0`, for both crates | exact |
| Transitive versions | `core/Cargo.lock` | present, and not in `.gitignore` (which ignores `target/`) | exact, via the lock |


Workspace dependencies, all from `core/Cargo.toml` `[workspace.dependencies]`. A crate asks for these with
`name.workspace = true` and never names a version of its own. Every one is a bare version, which Cargo reads as a
caret range, so the exact build comes from `core/Cargo.lock`:

| Crate | Declared | Range |
|---|---|---|
| `serde` (features: `derive`) | `1.0.228` | caret |
| `serde_json` (features: `float_roundtrip`) | `1.0.145` | caret |
| `tokio` (`default-features = false`) | `1.48.0` | caret |
| `sha2` | `0.10.9` | caret |
| `flate2` | `1.1.5` | caret |
| `rmcp` (features: `server`, `transport-io`, `macros`) | `3.5.0` | caret |
| `schemars` | `1.0.4` | caret |
| `ulid` | `1.2.1` | caret |
| `rusqlite` (features: `bundled`) | `0.37.0` | caret |
| `libc` | `0.2.177` | caret |
| `windows-sys` | `0.61.2` | caret |
| `windows-link` | `0.2.1` | caret |
| `ureq` (`default-features = false`, features: `native-tls`) | `2.12.1` | caret |
| `native-tls` | `0.2.14` | caret |
| `toml_edit` (`default-features = false`, features: `parse`, `display`) | `0.25.17` | caret |
| `mewndo-proto` | `{ path = "crates/mewndo-proto" }` | local path, no version |

Note on a caret in Cargo: `0.10.9` and `0.37.0` are pre-1.0, where a caret allows only patch updates
(`0.10.x`, `0.37.x`), while `1.0.228` allows any `1.x`.

## Node and Electron

| What | Where | Value | Pinned |
|---|---|---|---|
| Node, app requirement | `apps/desktop/package.json` `engines.node` | `>=22` | **a floor, not a pin** |
| Node, CI | `.github/workflows/ci.yml` | `node-version: 24`, so the latest 24.x at the time of the run | major only |
| Node, repository root | `package.json` | no `engines` field | not pinned |
| Electron | `apps/desktop/package.json` `devDependencies` | `44.5.1`, no caret | **exact** |
| electron-builder | `apps/desktop/package.json` `devDependencies` | `^26.15.3` (resolved `26.15.3`) | caret |
| chokidar | `apps/desktop/package.json` `dependencies` | `^4.0.3` (resolved `4.0.3`) | caret |
| npm tree | `package-lock.json`, lockfileVersion 3 | the whole tree, root plus the `apps/desktop` workspace | exact, via the lock |

Only one direct runtime dependency: `chokidar`. Everything else in the app is Node's own standard library, as
`plot.md` requires.

## Cloudflare Workers

All six Workers (`cloud/decide`, `cloud/drive`, `cloud/gateway`, `cloud/gmail`, `cloud/mcp`, `cloud/notion`) are
`"version": "0.1.0"`, `"private": true`, `"type": "module"`, and declare one dev dependency each:

| What | Where | Value | Pinned |
|---|---|---|---|
| wrangler | every `cloud/*/package.json` | `^3`, so any 3.x | **caret, and only to a major** |
| wrangler, resolved | `cloud/gateway/package-lock.json` (lockfileVersion 3) | `3.114.17`, with `miniflare` `3.20250718.3` | exact, via that one lock |
| wrangler, the other five | `cloud/decide`, `cloud/drive`, `cloud/gmail`, `cloud/mcp`, `cloud/notion` | **no `package-lock.json`** | not pinned |
| Worker `compatibility_date` | every `cloud/*/wrangler.toml` | `2026-10-01`, the same in all six | exact |
| Runtime flags | every `cloud/*/wrangler.toml` | no `compatibility_flags` set | n/a |

Each Worker's tests run on plain `node --test` and import only Node builtins and their own `src/`, so they need no
install and no wrangler; `wrangler` is only for `dev`, `deploy` and `tail`. Nothing in `cloud/` has been deployed,
so no resolved wrangler version has ever actually run against Cloudflare.

## Python

Nothing is pinned, because there is no notebook. `notebooks/` holds `README.md` and `evalset/guard20.json`, a
hand-written set of 20 Guard cases; the file itself records that its expected answers are human expectations, not
recorded model answers. The Kaggle server notebook was removed on 10 Oct 2026 (the gateway uses Workers AI only).
There is no `.ipynb` and no `.py` in the repository's own files (outside installed `node_modules/`), and no
`requirements.txt`, `pyproject.toml` or `environment.yml`. The Python that checks `.github/workflows/ci.yml` parses
(`python3 -c "import yaml, ..."`) is whatever the machine running it has, and is not pinned either.

## GitHub Actions

| What | Where | Value | Pinned |
|---|---|---|---|
| Runner | `.github/workflows/ci.yml` | `windows-latest`, a moving label | not pinned |
| `actions/checkout` | same | `v5` | major only, not a commit SHA |
| `actions/setup-node` | same | `v5` | major only, not a commit SHA |

## What is not pinned, in one list

The Rust toolchain and target, the runner image, the two actions, Node (a floor in the app, a major in CI), and
wrangler in five of the six Workers. The lock files (`core/Cargo.lock`, `package-lock.json`,
`cloud/gateway/package-lock.json`) make the dependency trees they cover reproducible; the toolchains around them
are not reproducible today.
