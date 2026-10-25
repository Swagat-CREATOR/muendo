// The lanes window's picture of its tabs and its New lane picker (spec §33.7). Pure functions over plain objects,
// no DOM and no xterm, so tests run it with plain Node and the window (renderer/lanes.js) only draws the result.
//
// The model: { lanes, connected, selectedId, waiting, error, picker }
//   lanes:      the main process's lanes:state list, [{ laneId, program, cwd, running, exitCode, agentId }]
//   selectedId: the tab shown
//   waiting:    { program, cwd } while a lane.open this window sent has no answer yet
//   error:      { program, cwd, message } when the core refused it, shown in the picker in the core's own words
//   picker:     { open, program, cwd, folders }
(function () {
  // What the New lane picker offers. Shell is shown but can't be picked: the core starts only these three
  // programs in a lane (desk_lanes::AGENTS), and the window says so rather than offering something that fails.
  const PICKS = [
    { id: 'claude', label: 'Claude Code', program: 'claude', logo: 'claude code' },
    { id: 'codex', label: 'Codex', program: 'codex', logo: 'codex' },
    { id: 'cursor', label: 'Cursor', program: 'cursor-agent', logo: 'cursor' },
    {
      id: 'shell', label: 'Shell', program: null, logo: null,
      why: "Mewndo's core starts only Claude Code, Codex and Cursor in a lane for now, not a plain shell.",
    },
  ];
  const NAMES = { claude: 'Claude Code', codex: 'Codex', 'cursor-agent': 'Cursor' };

  // "claude", or a path to it with .exe or .cmd, to the agent's name.
  function agentName(program) {
    const base = String(program ?? '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
    return NAMES[base.toLowerCase()] ?? (base || 'Lane');
  }

  function folderName(cwd) {
    const parts = String(cwd ?? '').split(/[\\/]+/).filter(Boolean);
    return parts.at(-1) ?? String(cwd ?? '');
  }

  // What a tab says about its agent: "running", or "exited (code)" once it ended.
  function statusText(lane) {
    if (lane?.running) return 'running';
    return Number.isFinite(lane?.exitCode) ? `exited (${lane.exitCode})` : 'exited';
  }

  // One tab per lane, named after its agent; a second Claude Code in the same window is "Claude Code 2".
  function tabs(model) {
    const seen = new Map();
    return (model.lanes ?? []).map((lane) => {
      const name = agentName(lane.program);
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      return {
        laneId: lane.laneId,
        title: n > 1 ? `${name} ${n}` : name,
        folder: folderName(lane.cwd),
        cwd: lane.cwd,
        status: statusText(lane),
        running: lane.running === true,
        selected: lane.laneId === model.selectedId,
      };
    });
  }

  const empty = () => ({
    lanes: [], connected: true, selectedId: null, waiting: null, error: null,
    picker: { open: false, program: null, cwd: '', folders: [] },
  });

  // A new lanes:state. The tab shown stays; a lane this window was waiting for is shown as it arrives; a tab that
  // went away hands over to its neighbour. With no lanes at all, the picker opens.
  function withState(model, state) {
    const lanes = Array.isArray(state?.lanes) ? state.lanes : [];
    const before = new Set((model.lanes ?? []).map((l) => l.laneId));
    const ids = lanes.map((l) => l.laneId);
    let { selectedId, waiting, picker } = model;
    const arrived = waiting && lanes.find((l) => !before.has(l.laneId) && l.program === waiting.program && l.cwd === waiting.cwd);
    if (arrived) {
      selectedId = arrived.laneId;
      waiting = null;
      picker = { ...picker, open: false };
    } else if (!ids.includes(selectedId)) {
      const was = (model.lanes ?? []).findIndex((l) => l.laneId === selectedId);
      selectedId = ids.length ? ids[Math.min(Math.max(was, 0), ids.length - 1)] : null;
    }
    if (!ids.length && !waiting) picker = { ...picker, open: true };
    return { ...model, lanes, connected: state?.connected !== false, selectedId, waiting, picker };
  }

  function select(model, laneId) {
    if (!(model.lanes ?? []).some((l) => l.laneId === laneId)) return model;
    return { ...model, selectedId: laneId, picker: { ...model.picker, open: false } };
  }

  // The picker opens, set to an agent (or the one picked last) and a folder.
  function openPicker(model, { program, cwd, folders } = {}) {
    const known = PICKS.some((p) => p.program && p.program === program);
    return {
      ...model,
      error: null,
      picker: {
        open: true,
        program: known ? program : (model.picker?.program ?? 'claude'),
        cwd: cwd ? String(cwd) : (model.picker?.cwd ?? ''),
        folders: Array.isArray(folders) ? [...new Set(folders.map(String).filter(Boolean))] : (model.picker?.folders ?? []),
      },
    };
  }

  // A folder the core can start in must be a full path: C:\..., \\server\share\... or /...
  const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(String(p ?? ''));

  // Start: the message for the main process, or why not. Never sent twice while one waits.
  function start(model, { program, cwd } = {}) {
    const pick = PICKS.find((p) => p.program && p.program === program);
    const folder = String(cwd ?? '').trim();
    if (!model.connected) return { model, why: "Mewndo isn't connected to its core, so it can't start a lane." };
    if (model.waiting) return { model, why: `Still starting ${agentName(model.waiting.program)}…` };
    if (!pick) return { model, why: 'Pick Claude Code, Codex or Cursor.' };
    if (!isAbsolute(folder)) return { model, why: 'Choose a folder by its full path, like C:\\Users\\you\\project.' };
    return {
      model: { ...model, waiting: { program: pick.program, cwd: folder }, error: null, picker: { ...model.picker, program: pick.program, cwd: folder } },
      send: ['start', null, { program: pick.program, cwd: folder }],
    };
  }

  // The core refused the lane.open: the picker stays open with its words, e.g. "claude is not on PATH".
  function withError(model, error) {
    return {
      ...model,
      waiting: null,
      error: { program: error?.program ?? null, cwd: error?.cwd ?? null, message: String(error?.message ?? 'The core refused it.') },
      picker: { ...model.picker, open: true },
    };
  }

  // The terminal's size for lane.resize: whole rows and columns, nothing for a terminal not laid out yet.
  function resize(laneId, size) {
    const rows = Math.floor(Number(size?.rows));
    const cols = Math.floor(Number(size?.cols));
    if (!laneId || !(rows > 0) || !(cols > 0)) return null;
    return ['resize', laneId, { rows, cols }];
  }

  // The line a terminal gets once when its agent ends.
  const exitLine = (lane) => `\r\n\x1b[2m[${agentName(lane.program)} ${statusText(lane)}]\x1b[0m\r\n`;

  const api = { PICKS, agentName, folderName, statusText, tabs, empty, withState, select, openPicker, start, withError, resize, exitLine, isAbsolute };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MewLanes = api;
}());
