// Lanes (spec §33.7, §33.10 Part G): agents Mewndo starts in a terminal it owns. The core runs them
// (core/crates/mewndo-core/src/desk_lanes.rs); this keeps the app's picture of them and turns what the lanes
// window asks for into messages to the core. Plain state and plain functions, no Electron, so tests run it with
// plain Node, like cards.js.
//
// From the core:  lane.opened (a lane exists, or a reopened window's replay has finished), lane.closed (the agent
//                 ended, or with `removed` the lane is gone), and lane frames: raw terminal output.
// To the core:    lane.open, lane.reply (the core adds Enter), lane.brake (Ctrl+C), lane.resize, lane.attach
//                 (send me the replay buffer), lane.close, and lane frames: raw keystrokes from the window's terminal.
//
// What it can't do: it does not read the terminal. Output is bytes for the window's terminal to draw; nothing here
// knows whether the agent is waiting at a prompt (mewndo-pty, "What a lane cannot do").

// What a lane may start: the same three names the core accepts (desk_lanes::AGENTS). The core checks again.
// A plain shell is not among them: the core refuses anything else, so the lanes window offers Shell greyed out.
const AGENTS = ['claude', 'codex', 'cursor-agent'];

// An agent's kind or name, as agent.status and the Router say it, to the program a lane would start for it.
const PROGRAMS = {
  claude: 'claude', 'claude-code': 'claude', 'claude code': 'claude',
  codex: 'codex', 'openai codex': 'codex',
  cursor: 'cursor-agent', 'cursor-agent': 'cursor-agent',
};
const programFor = (kindOrName) => PROGRAMS[String(kindOrName ?? '').trim().toLowerCase()] ?? null;

// Codex and Cursor started in a lane are keyed on it: agent_id "lane:<lane id>" (core agents/codex.rs and
// cursor.rs, agent_id). Claude Code's agent id is its own and does not name the lane.
function laneOfAgent(agentId) {
  const m = /^lane:(.+)$/.exec(String(agentId ?? ''));
  return m ? m[1] : null;
}

// The folder a new lane starts in: the protected folder that changed most recently, else the first one, else home.
// folders: [{ root, lastChangeAt }] as the engine's folders() lists them.
function defaultFolder(folders = [], home = '') {
  const roots = (Array.isArray(folders) ? folders : []).filter((f) => f?.root);
  if (!roots.length) return String(home ?? '');
  const at = (f) => Date.parse(f.lastChangeAt ?? '') || Number(f.lastChangeAt) || 0;
  return roots.reduce((best, f) => (at(f) > at(best) ? f : best)).root;
}

// How long a lane.open waits for its answer before an `error` from the core is no longer taken to be about it.
const OPEN_DEADLINE_MS = 30_000;

// Terminal size bounds, as mewndo-pty's Resize::clamped: anything outside is the window still laying out.
const MIN_ROWS = 2;
const MIN_COLS = 10;
const MAX_ROWS = 500;
const MAX_COLS = 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));

function fromOpened(body, previous) {
  return {
    laneId: String(body.lane_id),
    program: String(body.program ?? ''),
    cwd: String(body.cwd ?? ''),
    pid: Number.isFinite(body.pid) ? body.pid : null,
    rows: Number(body.rows ?? 30),
    cols: Number(body.cols ?? 120),
    running: body.running !== false,
    exitCode: Number.isFinite(body.exit_code) ? body.exit_code : null,
    bytesOut: previous?.bytesOut ?? 0,
    lastOutputAt: previous?.lastOutputAt ?? null,
  };
}

// client: app/desk/core-client.js (or a fake). now(): injected in tests.
function createLanes({ client, now = Date.now } = {}) {
  const lanes = new Map(); // lane_id -> lane, in the order the core reported them
  // lane.open requests the core has not answered yet: { program, cwd, at }. The core answers lane.opened, or an
  // `error` with the request's id; client.send doesn't hand that id back, so an error while one waits is its own.
  let pending = [];

  const has = (id) => lanes.has(String(id ?? ''));
  const send = (type, body) => Boolean(client?.send?.(type, body));

  return {
    // One core message. Returns the lane it touched, or null when it was for something else.
    apply(event) {
      const body = event?.body ?? {};
      if (event?.type === 'lane.opened' && body.lane_id) {
        const lane = fromOpened(body, lanes.get(String(body.lane_id)));
        lanes.set(lane.laneId, lane);
        const waited = pending.findIndex((p) => p.program === lane.program && p.cwd === lane.cwd);
        if (waited >= 0) pending.splice(waited, 1);
        return lane;
      }
      if (event?.type === 'lane.closed' && body.lane_id) {
        const lane = lanes.get(String(body.lane_id));
        if (!lane) return null;
        lane.running = false;
        if (Number.isFinite(body.exit_code)) lane.exitCode = body.exit_code;
        if (body.removed) lanes.delete(lane.laneId);
        return { ...lane, removed: body.removed === true };
      }
      return null;
    },

    // The core refused something (`error`). While a lane.open waits, that is its answer: the core's own words,
    // such as "claude is not on PATH" or "D:\gone is not a folder". Null when no lane.open waits.
    failed(event) {
      if (event?.type !== 'error') return null;
      pending = pending.filter((p) => now() - p.at <= OPEN_DEADLINE_MS);
      const open = pending.shift();
      if (!open) return null;
      return { program: open.program, cwd: open.cwd, message: String(event.body?.message ?? 'the core refused it') };
    },
    waiting: () => pending.map((p) => ({ program: p.program, cwd: p.cwd })),

    // Terminal output for a lane (a `lane` event from core-client.js). Null for a lane the app doesn't know yet,
    // which happens for a moment while lane.opened is on its way; the window draws the bytes either way.
    output(laneId, data) {
      const lane = lanes.get(String(laneId));
      if (!lane) return null;
      lane.bytesOut += data?.length ?? 0;
      lane.lastOutputAt = now();
      return lane;
    },

    // "Start Claude in shop" (§33.7). False, with nothing sent, for anything but an agent and a folder.
    start({ program, cwd, args = [] } = {}) {
      if (!AGENTS.includes(program) || !cwd || typeof cwd !== 'string') return false;
      const list = Array.isArray(args) ? args.map(String) : []; // from a renderer: never trusted to be an array
      const sent = send('lane.open', { program, cwd, args: list, env: [] });
      if (sent) pending.push({ program, cwd, at: now() });
      return sent;
    },
    reply(laneId, text) {
      if (!has(laneId) || !String(text ?? '').length) return false;
      return send('lane.reply', { lane_id: String(laneId), text: String(text) });
    },
    brake(laneId) {
      return has(laneId) && send('lane.brake', { lane_id: String(laneId) });
    },
    resize(laneId, rows, cols) {
      if (!has(laneId)) return false;
      const size = { rows: clamp(rows, MIN_ROWS, MAX_ROWS), cols: clamp(cols, MIN_COLS, MAX_COLS) };
      const lane = lanes.get(String(laneId));
      if (lane.rows === size.rows && lane.cols === size.cols) return true; // the terminal reports the same size often
      Object.assign(lane, size);
      return send('lane.resize', { lane_id: String(laneId), ...size });
    },
    // Raw keystrokes from the window's terminal, exactly as typed.
    type(laneId, data) {
      if (!has(laneId) || !data?.length) return false;
      return Boolean(client?.sendLane?.(String(laneId), data));
    },
    // A window (re)opened on this lane: the core sends its replay buffer, then lane.opened.
    attach(laneId) {
      return has(laneId) && send('lane.attach', { lane_id: String(laneId) });
    },
    // End the lane for good. The core answers with lane.closed {removed: true}.
    close(laneId) {
      return has(laneId) && send('lane.close', { lane_id: String(laneId) });
    },

    // The connection to the core dropped: the core still has the lanes (they don't die with a connection), and it
    // re-sends lane.opened for each when the app reconnects. Until then the app knows nothing current.
    forget() {
      lanes.clear();
      pending = [];
    },

    get: (id) => lanes.get(String(id)) ?? null,
    list: () => [...lanes.values()].sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0)),
    count: () => lanes.size,
  };
}

module.exports = {
  createLanes, programFor, laneOfAgent, defaultFolder, AGENTS, OPEN_DEADLINE_MS, MIN_ROWS, MIN_COLS, MAX_ROWS, MAX_COLS,
};
