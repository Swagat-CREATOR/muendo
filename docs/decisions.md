# Decisions

Choices the spec left open or contradicted, and the verify-first items of §32.5 rule 3 once checked. Newest last.

## Pipe protocol v2: frame format (9 Oct 2026)

§33.10 Part A step 2 says a frame is a 1-byte frame type, a 4-byte little-endian length, then the payload. §38.5
says a 4-byte length followed by JSON. **Chosen: §33.10's format**: lanes (§33.10 Part G) send raw terminal bytes
as frame type 1, which a JSON-only frame can't carry. Maximum payload 8 MB. A lane payload is a 1-byte lane id
length, the lane id, then the bytes. Code: `core/crates/mewndo-proto`.

## Pipe protocol v2: pipe name (9 Oct 2026)

§33.10 Part A step 4 says `\\.\pipe\mewndo-core-<8 random hex>`; §38.2 says `\\.\pipe\mewndo-core-<user SID>`.
**Chosen: random**, published in `core.json`. A name anyone can work out lets another process create the pipe
first and receive the hooks' traffic; `first_pipe_instance` and the current-user-only DACL
(`D:P(A;;GA;;;<SID>)`, checked on Windows: one ACE, this user, full control) close the rest.

## Pipe protocol v2 runs alongside v1 (9 Oct 2026)

The app and the v0 engine speak protocol v1 (JSON lines, `core/crates/mewndo-core/src/protocol.rs`) to the core
today, and §32.5 rule 6 keeps the v0 engine as is. So v2 is a second pipe in the same core, started only with
`mewndo-core --desk <folder>`; v1 is unchanged. Without `--desk` (every existing test, and the app until §33.10
Part E connects to v2) nothing changes and no single-instance lock is taken.

## desk.db location (9 Oct 2026)

§38.6 puts `desk.db` in `%APPDATA%\Mewndo` (Roaming); §33.10 A5 puts `core.json` in `%LOCALAPPDATA%\Mewndo`.
**Chosen: both in the `--desk` folder, normally `%LOCALAPPDATA%\Mewndo`.** A roaming profile copies Roaming at
sign-out, which is the wrong place for a live SQLite WAL database, and one folder keeps one core per folder simple.

## desk.db on the windows-gnu dev box (8 Oct 2026)

Real SQLite (`rusqlite`, bundled) is a C build. Linux and Windows-MSVC (CI) build it; the windows-gnu dev box has
no C compiler, so there `writer.rs` is a sink that stores nothing and says so in the log. Every desk.db test runs
on Linux and in CI.

## Single instance (9 Oct 2026)

One core per desk folder: the named mutex `Local\MewndoCore` for `%LOCALAPPDATA%\Mewndo` (§33.10 A3), and
`Local\MewndoCore-<hash of the folder>` for any other folder, so tests and a second desk folder don't collide.
`flock` on `core.lock` elsewhere. A second core exits with code 3 before it prints `ready`.

## cua-driver: read from the source, not run (10 Oct 2026)

§36.6 U2 and §32.5 rule 3 ask for four cua-driver facts and the `cua-cursor-motion` API before anything is built
on them. All five entries below were read from a **read-only clone of `trycua/cua` at commit
`5a364bbe60e1f8a901ceacd889606b6367dc96ab`** (driver source version `0.34.0`, `libs/cua-driver/rust/Cargo.toml:23`),
which sits outside this repository and is never committed. **Nothing in that repository was run** — no script,
installer, `make`, `cargo`, test suite or binary — so every fact here comes from source, docs or Cua's own
generated contract, with the file and line given. Paths below are relative to `libs/cua-driver/` in that clone.

The pinned binary is release **`cua-driver-rs-v0.34.0`**, the release of the source that was read. Its asset name
and SHA-256 are in `docs/versions.md` and in `core/crates/mewndo-computer/src/vendor.rs`.

**Still unconfirmed, and marked as such wherever it is used:** no live `cua-driver mcp` `list_tools` capture
exists (that needs the Windows binary). `docs/samples/cua/tools.json` is converted field for field from Cua's
generated contract manifest (`contract/manifest.json`, SHA-256
`c1aaae03fb093806fe35b13bc174682168f4d77806c4465bf055b5cde07e9913`), which is what the portable tool surface is
generated from — but §32.5 rule 2 says never guess a field name, so a real capture must replace it before
anything depends on a field the manifest does not carry.

### 1. Which actions work on Windows

**Every one of the 29 portable tools declares `windows`** in `contract/manifest.json` (each tool's `platforms`
array), and the Windows runtime registers all of them plus 19 non-portable extras
(`rust/crates/platform-windows/src/tools/impl_.rs:10355-10500`, listed in `docs/samples/cua/tools.json` under
`windows_only_extra_tools`). Declaring a tool is not the same as the action landing, and Cua is explicit about
the difference: `docs/action-support.md:1-12` says a row is **Delivered** only when "a fixture-owned state change
was observed", **Refused** only when the exact structured refusal code passed, and that "a missing row is never
evidence that an action is impossible".

The accepted Windows baseline is `docs/action-support.md:21` — "Run `29257963004`: 122/122 rows, 99 delivered and
23 exact refusals", at Cua's commit `64e82449`. What that run proves, by harness:

- **Background left click** (`delivery_mode:"background"`, the default) delivers on Electron, Tauri, WPF, WinUI3
  and WebView2, through a UIA hit-test at the point (`docs/action-support.md:32-33`, `:54-56`;
  `rust/Skills/cua-driver/WINDOWS.md:35`). It never fronts or restacks the target, ever
  (`WINDOWS.md:35`).
- **Background `type_text`, `press_key`, child-window actions and AX-addressed value/selection changes** deliver
  on Tauri and on native WPF/WinUI3 (`docs/action-support.md:33`, `:54-55`).
- **Refused, with an exact code, not a silent no-op:** on Electron, background right click, double click,
  `type_text`, `press_key`, `hotkey` and `scroll` return `background_unavailable`, and background PX `drag`
  returns `background_occluded` (`docs/action-support.md:32`). On Tauri, `hotkey` and PX `scroll` return
  `background_unavailable` and PX `drag` `background_occluded` (`:33`). Background `F5` and PX `drag` on WPF are
  `background_unavailable` (`:54`).
- **Unproven (not refused — simply no evidence):** WinUI3 background right/double-click refusal behaviour and
  broader PX coverage; WebView2 native keyboard and wider pointer cells; additional WPF PX gestures
  (`docs/action-support.md:54-56`).
- **`background_uipi_blocked` is a production refusal code with no test behind it** and "must not be counted as
  covered" (`docs/action-support.md:58-60`).
- Two Windows failure modes that matter to a guard: a driver in **Session 0** returns empty UIA and blank
  screenshots (`WINDOWS.md:731-734`), and a background pixel click that misses the UIA hit-test falls through to
  `PostMessage`, which is a **silent no-op on UWP** — the result reports `route:"synthetic_events"` and
  `effect:"unverifiable"`, i.e. the action result reports the route, not the outcome
  (`WINDOWS.md:738-742`, `:529-537`).

**For Mewndo:** a tool existing on Windows is not a promise the click landed. `mewndo-computer` records what the
driver returned and does not turn an `unverifiable` into a success.

### 2. Coordinate space: physical pixels

**Physical pixels, on Windows, for screenshots and for pixel clicks alike** — the driver is per-monitor-DPI-aware
v2, so there is no logical-pixel layer to convert through.

- `rust/crates/platform-windows/src/tools/impl_.rs:7972-7978`: "Read the primary display size in PHYSICAL pixels.
  With permonitorv2 DPI awareness (set in cua-driver.manifest), `SM_CXSCREEN` / `SM_CYSCREEN` already return
  physical pixels — the same coordinate space screenshots and pixel clicks use on Windows."
- `impl_.rs:7991-7993`, the live `get_screen_size` description: "Return the size of the main display in physical
  pixels plus its display scale factor. On Windows, screenshots and pixel clicks use this same physical-pixel
  coordinate space."
- `impl_.rs:8067`: the `get_desktop_state` capture is "True screen geometry in physical pixels (same space as the
  capture)."
- `rust/crates/platform-windows/src/uia/windows_enum.rs:1034`: window bounds come from
  `DWMWA_EXTENDED_FRAME_BOUNDS` with a `GetWindowRect` fallback and "The driver is Per-Monitor V2 aware, so both
  sources use physical pixels."

**Origin depends on the target, and this is the part that is easy to get wrong:**

- `target.kind = "window"` → **window-client** coordinates, origin at the top-left of the screenshot the agent
  saw; the driver calls `ClientToScreen(hwnd, …)` itself (`WINDOWS.md:585-594`).
- `target.kind = "desktop"`, `display_id:"primary"` → native `get_desktop_state` screenshot pixels
  (`contract/manifest.json`, `move_cursor.x`: "window-local screenshot pixels for a window target, native
  `get_desktop_state` screenshot pixels for the desktop").
- `get_desktop_state`'s `max_image_dimension` downsizes the returned PNG, and "desktop-scope x/y taken from it
  are mapped back automatically" (`contract/manifest.json`, `get_desktop_state.max_image_dimension`). So a point
  from a capped capture is in *capped-image* pixels, not screen pixels.
- `display_id:"primary"` is the only portable desktop target in this release; a platform that cannot address
  another display "reject[s] it explicitly rather than silently changing coordinate spaces"
  (`contract/manifest.json`, the shared `target` description).

**For Mewndo:** `mewndo-overlay`'s `coords.rs` treats driver points as physical pixels and converts
window-client → virtual-screen itself, because the overlay is per-monitor-v2 aware too (§36.6 U7) and the virtual
screen has negative coordinates on a left-hand or above monitor. **Unconfirmed:** the multi-monitor case — only
`display_id:"primary"` is portable, and no captured sample shows a second-display point.

### 3. How element targets are expressed

Three ways, and a `click` must use exactly one of the first two (`contract/manifest.json`, `click.input_schema`
is a `oneOf`: either `x`+`y`, or `element_token` with no `x`, `y` or `capture_id`):

1. **`element_token`** — the preferred route. A string matching `^s[0-9a-f]{8}:[0-9]+$`, i.e. `s<snapshot id, 8
   hex>:<row>` (`rust/crates/cua-driver-contract/src/inputs.rs:68`;
   `rust/crates/cua-driver-core/src/element_token.rs:14-15` formats the id as `s{snapshot_id:08x}`;
   `rust/crates/cua-driver-core/src/batch_tools.rs:1405` splits it on `:`). Example from the skill:
   `{ "pid": 6004, "element_token": "s0000002a:22" }` (`WINDOWS.md:546`). It resolves a cached UIA element and
   calls `Invoke()` on it: no cursor moves, no window activates, z-order is irrelevant, and it marshals across
   the `ApplicationFrameHost.exe` → UWP process boundary (`WINDOWS.md:549-564`).
   **Tokens are snapshot-scoped and short-lived**: every `get_window_state` read replaces the snapshot for that
   `(pid, window_id)` and lists the replaced ids in `invalidated_snapshot_ids`; a token from turn N does not
   resolve in turn N+1, and a token from window A does not resolve against window B of the same app — the error
   is `stale_element_token` (`WINDOWS.md:517-528`). Cua's own invariant is "snapshot before **and** after every
   action" (`WINDOWS.md:519`).
2. **A point**, `x` + `y` (plus `pid`), in the space of §2 above. The driver UIA-hit-tests inside the target
   HWND's subtree and picks the smallest-area element bearing `InvokePattern` whose bounding rectangle contains
   the point, then falls back to `PostMessage` to the deepest child HWND (`WINDOWS.md:585-605`).
3. **A menu path** for application menus: `{ "pid": …, "window_id": …, "path": ["Window","Arrange","Left"] }`
   via `invoke_menu`, using `ExpandCollapsePattern` then `InvokePattern`/`SelectionItemPattern`, refusing
   ambiguous, missing or disabled segments and never falling back to pixels (`WINDOWS.md:576-583`).

Every tool that acts also takes `target` — `{kind:"window", pid, window_id}` or
`{kind:"desktop", display_id:"primary"}` — chosen per call, plus an optional `session` label and
`delivery_mode: "background" | "foreground"` (`contract/manifest.json`, `click.input_schema`). A pixel click may
also carry a one-use `capture_id` binding it to the observation it came from (`README.md:12-14`).

**For Mewndo:** the guard reads the element name from `element_token`-resolved UIA on the core's own UIA thread
(§36.6 U5.3), not from the driver, because a token tells us nothing about *what* is being clicked. §36.5's
`steps.json` already targets elements by name and control type, which is the right level for a Show Me skill.

### 4. How to turn the driver's own cursor off

Three routes, and the one Mewndo uses is the MCP tool, because Mewndo starts the driver but does not own a
pre-existing daemon:

- **`set_agent_cursor_enabled { session, enabled: false }`** — an MCP tool, both arguments required: "`true`
  shows the session's agent cursor overlay; `false` hides it" (`contract/manifest.json`,
  `set_agent_cursor_enabled`; registered on Windows as `SetAgentCursorEnabledV2Tool`,
  `rust/crates/platform-windows/src/tools/impl_.rs:10450`; risk class R1,
  `rust/crates/cua-driver-core/src/authorization.rs:903`). Per session, so it works whatever launch mode the
  driver is in. **This is what §36.6 U8 uses.**
- **`--no-overlay`** at launch: "Disable the cursor overlay entirely for this daemon"
  (`rust/crates/cua-driver/src/cli.rs:685`, and the `serve` flag table at `cli.rs:4264`). It is parsed by
  `CursorConfig::parse` (`rust/crates/cursor-overlay/src/lib.rs:150`) from
  `CursorConfig::from_args` (`lib.rs:115-121`), which `run_mcp_direct` also calls
  (`rust/crates/cua-driver/src/main.rs:361`) — so `cua-driver mcp --no-overlay` turns it off for a direct MCP
  process too. Cua's own test matrix uses it so cursor pixels cannot contaminate capture evidence
  (`docs/test-harnesses-guide.md:517`).
- **`cua-driver config set agent_cursor.enabled false`** — persistent. `agent_cursor.enabled` is listed as a
  config key by `config get`'s own help (`rust/crates/cua-driver/src/cli.rs:5167`) and dotted keys are forwarded
  to the `set_config` tool as `{key, value}` (`cli.rs:5196-5199`). **Unconfirmed:** that `set_config` accepts
  `agent_cursor.enabled` as a write — the key appears in the `get` help text, and the `set` path is generic, but
  no source line and no captured sample proves the write is accepted. Mewndo does not rely on it.

Also found, and used for §36.1's "one motion style per agent":
`set_agent_cursor_motion { session, style?, timing?, … }` with `style` one of `signature_arc` (default),
`spring_settle`, `magnetic`, `comet_swoop`, `adaptive`, `classic` and `timing` one of `native`, `fitts`, `fixed`
(`contract/manifest.json`, `set_agent_cursor_motion`), plus the saved default
`cua-driver config set cursor.motion.style <style>` (`rust/crates/cua-driver/src/cli.rs:4417`, `:4654`) — which a
`start_session` `cursor_motion` or a `set_agent_cursor_motion` call overrides (`cli.rs:4417`).

**Fallback, per §36.6 U8:** if the tool is absent or returns an error, Mewndo keeps the driver's cursor and draws
the label chip only, next to it.

**One finding that changes §36.6 U4:** there is **no `screenshot` tool** in this version. It was removed in
favour of `get_window_state` (which now always returns a screenshot) and `get_desktop_state`
(`rust/crates/platform-windows/src/tools/impl_.rs:10423-10439`). U4's keyword list still classifies both as reads
through `get`, so the classifier is correct as written — but the word `screenshot` matches nothing today, and a
later driver that brings the name back must still be classified as a read. Mewndo keeps the keyword for that
reason and says so in the test.

### 5. The exact API of `cua-cursor-motion`

Read from `rust/crates/cua-cursor-motion/` at the same commit. It is **not on crates.io** and must be a git
dependency (`README.md:14-16`, `Cargo.toml:11` `publish = false`). No runtime dependencies; the optional `serde`
feature adds `Serialize`/`Deserialize` to the public types (`Cargo.toml:17-26`).

```rust
// src/plan.rs:552, :602
pub fn plan_move(params: &MotionParams, req: &MoveRequest) -> Trajectory;
pub fn plan_spec(spec: &MotionSpec,     req: &MoveRequest) -> Trajectory;

// src/plan.rs:483-497
pub struct MoveRequest { pub from: Pt, pub from_heading: f64, pub to: Pt, pub end_heading: f64,
                         pub target: Option<[f64; 4]>,   // the element rect [x, y, w, h], when known
                         pub seed: String,               // "<cursor id>|<move counter>": same seed, same motion
                         pub reduced_motion: bool }
impl MoveRequest { pub fn new(from: Pt, to: Pt) -> Self }   // :502, headings default to REST_HEADING = pi/4

// src/plan.rs:420-431
pub struct Trajectory { pub samples: Vec<Sample>, pub arrival_t: f64, pub snap_t: Option<f64>,
                        pub target: [f64; 4], pub target_known: bool,
                        pub effects: ResolvedEffects, pub trail: TrailSpec, pub style: Option<MotionStyle> }
impl Trajectory { pub fn duration(&self) -> f64;            // :439, seconds
                  pub fn end(&self) -> Sample;              // :443
                  pub fn sample_at(&self, t: f64) -> Sample;// :448, interpolated, clamped to the ends
                  pub fn velocity_at(&self, t: f64) -> (f64, f64) } // :468, pt/s

// src/plan.rs:411-415
pub struct Sample { pub t: f64, pub x: f64, pub y: f64, pub heading: f64 } // t in SECONDS, heading in radians

// src/params.rs:10-39, defaults at :41-59 match Cua Driver
pub struct MotionParams { pub style: MotionStyle, pub timing: MotionTiming, pub effects: MotionEffects,
                          pub start_handle: f64 /*0.3*/, pub end_handle: f64 /*0.3*/,
                          pub arc_size: f64 /*0.25*/, pub arc_flow: f64 /*0.0*/, pub spring: f64 /*0.72*/,
                          pub glide_duration_ms: f64 /*0.0*/, pub peak_speed: f64 /*900*/,
                          pub min_start_speed: f64 /*300*/, pub min_end_speed: f64 /*200*/,
                          pub turn_radius: f64 /*80*/ }

// src/plan.rs:27, :30
pub const DT_MS: f64 = 1000.0 / 120.0;   // every trajectory is sampled at 120 Hz
pub const DEFAULT_TARGET_PT: f64 = 24.0; // the box assumed when a move has no element rect
```

`MotionStyle` is the six of §36.1 — `SignatureArc` (default), `SpringSettle`, `Magnetic`, `CometSwoop`,
`Adaptive`, `Classic` — with `MotionStyle::ALL` and `as_str()`; `MotionTiming` is `Native`, `Fitts`, `Fixed` with
`MotionTiming::ALL` (`src/style.rs`, re-exported at `src/lib.rs:24`). Fitts timing is
`150 + 120 * log2(D / W + 1)` ms, clamped to 300..1000 ms, where `W` is the target's smaller side
(`README.md:64-66`). `arrival_t` is when the tip first reaches the target, within 1 pt
(`src/plan.rs:422-424`, `ARRIVAL_TOLERANCE_PT` at `:33`); Cua clicks then and lets the follow-through or settle
play during the click (`README.md:52-53`). Units are **points in hotspot coordinates**, millisecond-based inside
the generators (`src/plan.rs:1-13`); `Sample.t` is seconds.

Effects are a separate, optional surface Mewndo does not use yet:
`effects::motion_frame(&trajectory, t, body, bool) -> EffectFrame` with `anchor_for_pointer(x, y, heading)`
putting the trail anchor 16 pt behind the tip (`README.md:74-89`, `src/geom.rs`, `src/effects.rs`).

**Its tests do expose golden paths, and that is the prize.** `tests/golden.rs:36` checks
`fixtures/golden.json` — "the trajectories that the TypeScript port must reproduce" (`README.md:136-137`) — to
within `1e-9` (`tests/golden.rs:17`). `tests/common/golden_cases.rs:248-331` builds it from every
`MotionStyle::ALL` x `MotionTiming::ALL` x two parameter sets x four canonical moves, writing a 25-point grid of
`[t, x, y, heading]` evenly spaced in time (`:17`, `:63-73`). A **subset** of that fixture — the six styles at
default parameters, `native` and `fitts` timing, 48 cases — is vendored at
`third_party/cua/cursor-motion-golden.json` with Cua's LICENSE beside it, and
`mewndo-overlay`'s `golden_paths.rs` tests Mewndo's `MotionPlanner` wrapper against it. `tests/motion_parity.rs`
additionally checks the crate against Cua's own motion lab to within 0.5 pt (`README.md:133-135`); that lab is
JavaScript and is not vendored.

**Unconfirmed:** the git dependency is pinned to `rev = 5a364bbe60e1f8a901ceacd889606b6367dc96ab`, the commit
that was read, while the driver binary is pinned to release `cua-driver-rs-v0.34.0`
(tag commit `b0968e1b12834e485dda68789541a3cc57664a9f`). Those are not the same commit, and
`raw.githubusercontent.com` would not serve the tag's tree, so **whether `golden.json` is byte-identical at the
release tag is unverified**. The motion the overlay draws and the motion the driver would have drawn could differ
by whatever changed in between; §36.6 U8 switches the driver's cursor off, so only one of them is ever on screen.
Also unconfirmed: the golden test is behind the non-default `cua-motion` feature, because the git fetch needs
network and CI must stay hermetic — see `core/crates/mewndo-overlay/Cargo.toml`.

## Codex hook output schema (10 Oct 2026)

§32.5 rule 3 asked for the Codex hook output schema and whether Codex's `Stop` can continue a turn. **Read from
Codex itself**: codex-cli 0.156.1 embeds the JSON schemas of every hook's input and output, now saved in
`docs/samples/codex/schema/hook-schemas.json`.

- `PreToolUse` and `PermissionRequest` answer in Claude Code's shapes, nested in `hookSpecificOutput`
  (`permissionDecision` allow / deny / ask with a reason; `decision: {behavior: allow | deny, message}`).
- Every output object has `additionalProperties: false`: a field outside the schema makes the answer invalid.
  `updatedInput`, `updatedPermissions` or `interrupt: true` in a PermissionRequest answer make it fail closed.
- `Stop` takes `{"decision": "block", "reason": …}`, so Codex's Stop **can** continue a turn.

The guessed, un-nested deny in `agents/codex.rs` and `mewndo-hook/src/failopen.rs` would have been an invalid
answer; both now print the schema's shape.

**Still open:** where 0.156.1 loads hooks from. A project's `.codex/hooks.json` did not run, not with the project
trusted for the run (`-c projects.'<path>'.trust_level="trusted"`), `--dangerously-bypass-hook-trust`, or
`commandWindows` set. The user-level `~/.codex/hooks.json` is the next thing to try; it changes the user's own Codex
setup, so it waits for the user's go-ahead.

## The Agent Desk's grace runs in the app (10 Oct 2026)

§33.10 Part D puts the 2-second grace in the core's Inbox, with Esc cancelling it; §38.5 has no message for Esc. The
app (`app/desk/cards.js`) holds the answer for the grace and sends `inbox.answer` only when it can no longer be
taken back. So the core's Inbox runs with a zero grace and its cards still carry `grace_ms: 2000` for the app's bar
(`desk_agents.rs`). One grace, in the place the key is pressed.

## `inbox.expired` (10 Oct 2026)

§38.5 has no message for a card nobody can answer any more (its hook timed out, or the user answered in the
terminal), so the app kept showing it. Added `inbox.expired {card_id}` to `mewndo-proto`: additive, so `v` stays 2.
An app that connects or reconnects is also sent every card still waiting, because those were published before it
was listening.

## Undo from a card runs in the app (10 Oct 2026)

The core answers `inbox.undo` with the release save point; the app finds the folder holding it and restores through
the v0 engine after the same confirmation as every other undo (§23.3, `main.js` `undoToSavePoint`). The core never
restores files on its own.

## The core's save points go through v0's MCP route (10 Oct 2026)

`engine_client.rs` (§32.5 rule 6) asks v0's hook server for save points with `POST /mcp/create_save_point`, not
`POST /savepoint`: the latter makes none when nothing changed since the last one, and an Inbox answer needs one for
its Undo either way. v0 finds the protected folder from the agent's working folder, which the wrapper remembers
per agent because the Inbox's release only knows the agent id (`SavepointRequest.cwd`).

## Workers AI only, with a day-budget priority order (10 Oct 2026)

The user dropped Kaggle. The gateway's route for every kind of call is now the answer cache, then Workers AI, then
`{"fallback": true}` for the device's rules; the backend record, `POST /internal/backend`, the Kaggle route, its
tests and `notebooks/clef-kaggle-server.ipynb` are gone, and `Backend::Kaggle` left `mewndo-router`.

When the day's free neurons run low (under `low_budget_share` = 20% of `total_cap` left), `receipt`, `triage` and
`showme` answer with rules only (`reason: budget_low_rules`) and `voice` falls back to the device's keyword matching
(`budget_low_keywords`); Guard keeps the model until `guard_until_used` = 95% of `total_cap` is used. Every decide
answer carries `rules_only`, true from 95% on; the Router keeps it (`Router::rules_only`), the core sends
`budget.state` to the apps when it changes, and the dock shows "Rules only mode".

**Judge codes.** An invite code is a judge code and can be redeemed on up to `devices_per_code` devices, each with
its own token. Usage is counted per device (`device_cap`) and per code (`code_cap`). Every number lives in one
settings table, `DEFAULT_SETTINGS` in `cloud/gateway/src/gateway.js`, with overrides stored in `StateDO` through
`POST /admin/settings`; `GET /admin/status` shows used and remaining budget, the reset time (next 00:00 UTC), the
table, and usage per code and device.

**What does not reach the dock yet:** the core has no HTTP client for the gateway (the Router's `Clef` is still
`NoClef`), so `rules_only` is only set by tests until the Clef transport is wired, which needs the deployed Worker.

## The dock sits on any edge, and the drag lives in the main process (design D3a, 10 Oct 2026)

Why the old bar jittered, found in `app/bar.js` and `renderer/bar.js` before the change:

1. The renderer sent every `pointermove` over IPC and the main process moved the window by the deltas. IPC
   messages arrive late and in bursts, and adding rounded deltas drifts, so the window lagged and shook.
2. A drop was one `setBounds` jump to the new place, with no glide.
3. `bar.js` had no orientation logic: `dock-layout.js` existed but nothing used it, so the bar kept its bottom
   shape on every edge.
4. Always-on-top was set once at creation; Windows can drop it after another topmost window takes focus.

(`hasShadow` was already false and the window size never changed on hover, so neither caused it.)

Now (`app/dock-place.js`, `app/bar.js`): one fixed-size transparent canvas per orientation (520 x 560 lying
down, 470 x 600 standing up), resized only when a drop changes the orientation. The renderer only says when a
drag starts (with the pointer's offset in the window) and ends; in between the main process reads the cursor every
8 ms and calls `setPosition` with whole pixels, only when the position changed. On release it snaps to the nearest
edge of the display under the pointer, gliding over 180 ms in 8 ms whole-pixel steps (one jump with reduced
motion). The edge decides the shape (left and right stand it up), the flyout opens toward the middle of the
screen, and the spot is remembered as `{ displayId, edge, fraction }`, so a resolution or scaling change keeps
it in the same place and a missing display falls back to the primary. Always-on-top is re-asserted on blur and
after a snap, at most once a second. Double-clicking the status dots sends it back to bottom right.

`bar-layout.js` and `dock-layout.js` are no longer used by the app; they stay, with their tests, until the design
steps are done, then go in one commit.

Two Windows fixes found by dragging the real app at 125 %: every move restates the window size (`setPosition` let a
650 x 700 canvas creep to 700 x 755 over one drag), and click-through is re-applied after every snap (mouse
forwarding went deaf after a resize). Double-click is listened on the document, since the press's pointer capture
sends it to the body.

**What it can't do:** the cursor is polled, so the window trails the pointer when the main process is busy; in one
scripted run on the dev machine it only caught up at the drop, and the glide took about half a second. A drag that
never reports its end stops by itself after 10 s.

## The living face (design D3b, 10 Oct 2026)

The pill's status dot is now the cat's face (`cat-face-live.svg` with `mew-eyes.js`), with the protection status as a
6 px dot at its lower right. The main process reads the SVG and hands it over once (`bar:face`), because the sandboxed
page can't read files. The face is a plain element, not a button: it is the drag handle, and a double-click sends
the dock back to bottom right. Tapping it no longer opens the main window; the panel's rows do that.

The main process looks at the cursor 4 times a second and, while it is within 300 px of the dock's middle or a drag
is on, sends it 30 times a second (`bar:cursor`, window coordinates), then `null` once when it leaves, so the eyes
look back toward the middle of the screen. Moods: Brake or Guard stopped something → `caught`; a card, question or
alert → `needs`; Rules-only mode or no agents for 5 minutes → `sleepy`; otherwise `calm`. A card that arrives while
the pill is a dot pops the face out (scale 0.6 to 1, 180 ms).

**What it can't do:** with reduced motion the cursor isn't fed and the eyes don't move or blink; only the moods change
their shape. The peek has no "Claude needs you" chip yet. Idle CPU with the eyes following hasn't been measured.

## Floating surfaces restyled (design D3, 10 Oct 2026)

The bar, the Agent Inbox cards and the Talk box use the float set (`design/tokens.css`, `design/base.css`): near-black
capsules with a hairline edge and a soft top highlight, Figtree, float keycaps, status colours only in rings, words
and dots. Cards follow §11.3: header with who, position dots, J/K and Esc chips; a status ring with the state in words
and how long ago; the agent's lines as a bubble; numbered 36 px options; a 40 px reply row (Space, V, Enter); and
the answered look (chosen option in mint soft with a check, the rest at 40 %, "Answer sent · Esc to take back", a
2 px mint grace bar). `describe()` now carries `chosen` and `at`, and the view adds the agent's name.

The cards and the Talk box now open beside the dock, toward the middle of the screen, and follow it when it moves
(`beside()` in `dock-place.js`, `onPlaced` from the bar); before, they were pinned to the primary display's right
side and bottom centre. When idle the pill becomes the edge tab: flush to the edge, 20 px thick, one dot per agent.

Floating windows set `color-scheme: normal !important`: with Windows in dark mode the tokens' dark scheme applied,
which can paint the canvas behind a transparent window.

**What it can't do yet:** the capsule stack (Inbox, Agents, Talk and More as separate capsules) and the tab's concave
fillets; your own last message on a card (the core sends no snippet); a Brake key on cards (the dock's Brake works);
the Receipt's suggested replies on Done cards; a live target line in the Talk box (it shows only after Enter); the
§11.6 floating toasts (there is no toast surface yet; Windows notifications are still used).

## Main window shell (design D4, 10 Oct 2026)

The main window is now the §7 shell: a hidden title bar with Windows' own buttons drawn over our 40 px bar
(`titleBarOverlay`, colours follow the system theme), a 224 px sidebar that collapses to 64 px (remembered in the
window's localStorage), and one screen at a time: Home, Inbox, Agents, Timeline, Connections, Skills, Protected
folders. Ctrl+1 to Ctrl+7 jump between them; arrow keys move in the list. The window opens at 1180 x 760 (minimum
900 x 600) and remembers its size and position (`settings.windowBounds`) if that still lands on a display.

The old single page is the Protected folders screen, unchanged inside; the agent hook setup and the brief safety
rules moved to Agents. The old styles now use the design tokens, so the screens follow light and dark.

The "Protect your work" checklist ticks itself from real state: a protected folder; Guard hooks installed for Claude
Code, Codex or Cursor; a restore done (`settings.triedUndo`, set by the first restore); a shortcut Test that received
the key press (`settings.shortcutsTested`). Once all four are done it says "You're set up" for that session, then
hides for good (`settings.checklistDone`).

**What it can't do yet:** Protected folders is the first screen until Home (D5) is built; Home, Inbox, Timeline,
Connections and Skills are short pages that say what isn't there yet. "Connect an account" is left out of the
checklist and "Invite a tester" out of the sidebar until those exist.

## Light main window and Home banners (10 Oct 2026)

At the user's request the main window is light, like Wispr Flow's: the frame and sidebar share one soft grey
(`--sidebar`) and the screen sits on a white rounded sheet; the title bar overlay uses the same grey. It no longer
follows the system's dark mode (`data-theme="light"` on the page); a theme choice in Settings can bring dark back.

Home is now the first screen: a greeting with the undo shortcut as keycaps, and a banner in the style of Wispr's
"Make Flow sound like you": dark, a serif headline with one italic word, a line of text, one button, and one of the
kit's cat poses in milk on a warm glow. The banner points at the next unfinished checklist step (protect a folder,
connect an agent, try an undo, pick shortcuts) and, once all are done, says "Mewndo has your back".

## First run in five steps (design D6, 10 Oct 2026)

First run is one card (720 x 520) on the frame grey: a progress row, the step with its cat (sit, trot, face, face,
reach), and Back / Skip / Next. 1 Welcome. 2 Protect a folder: the same folder list, suggestions and checks as before;
Next protects the ticked folders and won't go on until at least one is protected. 3 Connect agents: opens the same
hook dialogs as the Agents screen (optional). 4 Shortcuts: undo, brief, Inbox and Talk as keycaps, with a link to
Settings to change or test them (optional). 5 Done: "Try it", the start-at-sign-in choice, and "Start using Mewndo",
which finishes setup.

**What it can't do yet:** there is no invite code field (the app has no way to reach the gateway yet); shortcut
conflicts with Wispr Flow are found by Settings' Test, not flagged here; the card sits inside the normal window
instead of a 720 x 520 window of its own; and it hasn't been walked through on a fresh Windows profile.

## Timeline with Undo to here (design D7, 10 Oct 2026)

Timeline lists every save point in every protected folder, newest first, under "Today", "Yesterday" and dated
headings, with search and agent and folder filters. Each row shows the time, who (the agent's initial, or the cat
for Mewndo's own save points), the label, and the folder, agent and trigger. Hover or focus shows **Undo to here**
and **See changes**. Undo to here always shows the restore plan first (the engine's own plan text: what is put back,
what is replaced, what goes to the trash, and that a save point is made first), then restores the whole folder in
place and shows a toast with the reaching cat ("Restored 2 files in … Verified."), or the pounce cat if verification
failed. Toasts are now the §11.6 float style with an optional cat.

Checked in the real app on a throwaway folder in %TEMP%: an edited file came back and a new file went to the trash.

**What it can't do yet:** rows are save points, not agent turns with their Receipt; there are no change counts per
row (that needs a diff per row); no Copy summary or Flag; at most 500 rows are drawn (filters narrow it).

## Agents and Connections screens, brand logos (design D8, 10 Oct 2026)

Agents lists every agent Mewndo knows (the same data as the dock's panel): logo, name, what it's doing, a connection
chip (Hooked, Detected, Not connected, with a tooltip saying what Mewndo can do), status ring and words, and Brake or
Resume. A row opens to show what the connection means and the agent's latest save points with Undo to here. The hook
setup is below, under "Connect agents".

Brand logos (Claude, Codex, Cursor, Gemini, Gmail, Google Drive, Notion, GitHub) are bundled in
`app/assets/logos` (Simple Icons, CC0; LobeHub Icons, MIT; see LICENSE.txt there), only to name what they stand for.
They appear in Agents, Timeline rows, the Inbox cards' headers, the dock's panel and Connections. Agents without a
logo get an initial badge. Connections shows Gmail, Google Drive, Notion and GitHub cards that say plainly they
aren't available yet.

**What it can't do yet:** no Learning / Active switch or agreement score (Guard has one mode); no lane in the agent
detail (lanes aren't connected to the app yet); no account can be connected.
