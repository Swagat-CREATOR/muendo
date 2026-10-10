# UI requests

Data the core and app logic already send, waiting for a look from the UI session. Each entry: what to show, which
field carries it, and which states exist. Nothing here is styled.

## Habit card (spec §34.7)

- **Arrives as** an `inbox.card` with `kind: "habit"`, the same stack as the other Inbox cards
  (`apps/desktop/app/desk/cards.js`; `describe(card)` returns the fields below).
- **Show**: `title` — the question, e.g. "Always allow `npm test` in shop?" (the backticks mark the command);
  `lines` — two lines saying it was the same answer 3 times and that yes writes it to rules.toml for every project
  after a restart; `hints` — `['1 yes', '2 no', '3 never ask']`. `agentId` is the agent kind (`claude`, `codex`,
  `cursor`), not a running agent, so there is no lane or agent row to link to. `risk` is always 0.
- **Keys**: 1 yes, 2 no, 3 never ask, with the usual 2 s grace and Esc to take it back. No U (nothing to undo) and no
  Space/V (there is nothing to type), although a spoken "yes"/"no"/"never ask" sent as `text` is accepted.
- **States**: `open` → `answering` (grace bar) → `sent` → gone on `inbox.release`. It never expires on its own; it
  stays until answered or dismissed with E (dismissing answers nothing, and the core keeps offering it to a
  reconnecting app until it is answered).
- Currently it renders with whatever the renderer does for an unknown kind; it needs its own quiet look, lower key
  than a Permission card, since no agent is waiting on it.

## Lanes window (spec §33.7, §33.10 Part G)

The core and the app logic are done (`core/crates/mewndo-core/src/desk_lanes.rs`, `apps/desktop/app/desk/lanes.js`,
wired in `desk.js`). The window still shows the "not yet connected" placeholder, and `app/lanes-preload.js` only
exposes `action` and `onOpen`, so it needs:

- **Preload** (`lanes-preload.js`, yours): also expose `onState(fn)` for `lanes:state` and `onData(fn)` for
  `lanes:data`. `action(action, laneId, arg)` already sends `lanes:action` and is all the window needs to send.
- **`lanes:state`** — `{ lanes: [...], connected }`, sent whole on every change. Each lane: `laneId`, `program`
  (`claude` / `codex` / `cursor-agent`), `cwd`, `pid`, `rows`, `cols`, `running` (false once the agent ended; the
  lane stays so its last output can be read), `exitCode`, `bytesOut`, `lastOutputAt` (ms), `agentId` (the agent
  running in it once `agent.status` names the lane, else null). `connected: false` means the core is away; the
  list is then empty until it reconnects.
- **`lanes:data`** — `{ laneId, data }`: raw terminal output (a byte array, ANSI included) for a terminal emulator
  such as xterm.js to draw. It arrives for every lane, also while the window is hidden.
- **`lanes:open`** (existing) — show this lane.
- **Actions to send** with `action(...)`:
  - `('open', laneId)` when a lane is shown: the core replies with its replay buffer (up to 256 KB) as
    `lanes:data`, then a fresh `lanes:state`, so clear that lane's terminal before sending it.
  - `('start', null, { program, cwd, args? })`: program is one of the three agents; cwd an absolute folder (a
    protected folder is the natural choice).
  - `('type', laneId, data)`: the terminal's own keystrokes (xterm's `onData`), sent as they are.
  - `('reply', laneId, text)`: a one-line reply box; the core adds Enter.
  - `('brake', laneId)`: Ctrl+C. Worth a visible button: it is the §24 brake.
  - `('resize', laneId, { rows, cols })`: xterm's size after a fit.
  - `('close', laneId)`: ends the agent and removes the lane. It cannot be undone, so it wants a confirmation;
    closing the *window* must not send it (the lane keeps running, §33.7).
- **States per lane**: running, ended (with exit code, output still readable), and gone (removed from the list).

## Computer use (spec §36)

- **A setting**, off by default: "Let agents use the computer (guarded)". When on, `startCore()` in main.js must add
  `--computer-use` to the core's arguments (a shared-file edit; ask the core session or do it in its own function).
  Say beside it what it can't do: Mewndo cannot undo a click; each action is shown to you first.
- **Cards**: computer actions arrive as ordinary permission cards (`inbox.card`, kind `permission`), `agent_id`
  `computer:<session>`, title like "Claude wants to click at 412, 230". No new kind.
- **Paused**: `computer.pause {sessions: []}` arrives when the user took over the mouse or keyboard while an agent
  was acting. Show a clear "Agents paused — Resume" control (dock), and send `computer.resume {sessions: []}`
  through the core client when pressed; the core echoes `computer.resume` to every app, which clears the state.

