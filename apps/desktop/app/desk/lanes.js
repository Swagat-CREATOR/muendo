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
const AGENTS = ['claude', 'codex', 'cursor-agent'];

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

  const has = (id) => lanes.has(String(id ?? ''));
  const send = (type, body) => Boolean(client?.send?.(type, body));

  return {
    // One core message. Returns the lane it touched, or null when it was for something else.
    apply(event) {
      const body = event?.body ?? {};
      if (event?.type === 'lane.opened' && body.lane_id) {
        const lane = fromOpened(body, lanes.get(String(body.lane_id)));
        lanes.set(lane.laneId, lane);
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
      if (!AGENTS.includes(program) || !cwd) return false;
      return send('lane.open', { program, cwd: String(cwd), args: args.map(String), env: [] });
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
    },

    get: (id) => lanes.get(String(id)) ?? null,
    list: () => [...lanes.values()].sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0)),
    count: () => lanes.size,
  };
}

module.exports = { createLanes, AGENTS, MIN_ROWS, MIN_COLS, MAX_ROWS, MAX_COLS };
