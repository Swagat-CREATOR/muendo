// Computer use and Show Me in the app's main process: the Settings "Computer use" section and the Skills screen.
// main.js gives it what it needs (settings, the core, the desk pipe, the windows) and spreads its handlers into
// its own; everything here is plain Node, so tests drive it with fakes.
//
//   Settings      on/off switch -> download the pinned cua-driver if needed (after the user says yes) -> restart
//                 the core with --computer-use; per agent, add or remove the MCP server; Resume after a takeover.
//   Skills        Record (showme.start) -> the indicator shows -> steps arrive (showme.step) -> Esc / Stop / 10 min
//                 (showme.state recording:false, with every step) -> the user reviews, names and saves.
const cu = require('./computer-use');
const skills = require('./skills');

// What the app knows about one recording, from the core's messages. Pure, so it is tested on its own.
//   idle -> starting (asked) -> recording (core said so) -> review (stopped with steps) -> idle (saved/discarded)
// A stop with no steps, or a refusal, goes straight back to idle with the reason.
function createRecording() {
  let state = { phase: 'idle', steps: [], reason: null };
  const view = () => ({ phase: state.phase, steps: state.steps.slice(), reason: state.reason });
  return {
    view,
    asked() {
      if (state.phase === 'recording' || state.phase === 'starting') return false;
      state = { phase: 'starting', steps: [], reason: null };
      return true;
    },
    // showme.state
    onState({ recording, reason = null, steps = [] } = {}) {
      if (recording) {
        if (state.phase !== 'recording') state = { phase: 'recording', steps: [], reason: null };
        return view();
      }
      if (state.phase === 'idle' || state.phase === 'review') return view(); // not ours, or already over
      const all = Array.isArray(steps) && steps.length ? steps : state.steps;
      state = all.length ? { phase: 'review', steps: all.slice(), reason } : { phase: 'idle', steps: [], reason };
      return view();
    },
    // showme.step: { index, step }
    onStep({ step } = {}) {
      if (state.phase !== 'recording' || !step || !Number.isInteger(step.index) || step.index < 0 || step.index > skills.MAX_STEPS) return view();
      const steps = state.steps.slice();
      steps[step.index] = step.step;
      state = { ...state, steps };
      return view();
    },
    done() {
      state = { phase: 'idle', steps: [], reason: null };
      return view();
    },
  };
}

function createComputerUse({
  getSettings, saveSettings, log, coreBinary, deskDir, restartCore, coreStatus,
  notifySettings = () => {}, notifyMain = () => {}, indicator = { show() {}, hide() {} }, onReview = () => {}, onRecordStart = () => {},
  openSettings = () => {},
  arch = cu.archOf(), vendor = cu.vendorDir(), home, env,
}) {
  let driver = { verified: false, missing: true, problem: null, checked: false };
  let downloading = null; // { received, total } while a download runs
  let paused = false;
  let client = null;
  let coreHasFlag = false;
  const recording = createRecording();
  const skillsDir = () => skills.skillsDir(deskDir());
  const on = () => getSettings().computerUse === true;

  async function refreshDriver() {
    if (!arch) driver = { verified: false, missing: true, problem: 'cua-driver has no build for this processor.', checked: true };
    else driver = { ...(await cu.driverStatus(vendor, arch)), checked: true };
    return driver;
  }

  // The core's arguments, asked by core.js at every start.
  function coreArgs() {
    const args = cu.coreArgs({ on: on(), driverVerified: driver.verified });
    coreHasFlag = args.length > 0;
    return args;
  }

  async function agentsView() {
    return Promise.all(Object.keys(cu.MCP_AGENTS).map(async (agent) => {
      try {
        const plan = await cu.planMcp(agent, { exe: coreBinary(), home, env });
        return { agent, name: plan.name, file: plan.file, installed: plan.installed, error: null };
      } catch (e) {
        return { agent, name: cu.MCP_AGENTS[agent].name, file: null, installed: false, error: e.message };
      }
    }));
  }

  async function view() {
    const p = arch ? cu.pin(arch) : null;
    const status = coreStatus?.() ?? null;
    const coreRunning = status?.state === 'running';
    return {
      on: on(),
      supported: process.platform === 'win32' && !!arch,
      driver: { ...driver, version: cu.VERSION, size: p?.size ?? null, unpacked: p?.unpacked ?? null, url: p?.url ?? null, page: p?.page ?? null, sha256: p?.sha256 ?? null, folder: vendor },
      downloading,
      paused,
      status: cu.statusText({ on: on(), driver, coreRunning, coreHasFlag, paused, downloading }),
      agents: await agentsView(),
      command: `"${coreBinary()}" mcp-computer --agent <name>`,
      limits: cu.LIMITS,
    };
  }

  const changed = async () => notifySettings(await view());

  // The switch. On without a verified driver stays off and says the download is needed (Settings then shows the
  // size and the Download button); nothing is ever downloaded from here.
  async function setOn(want) {
    await refreshDriver();
    const plan = cu.switchPlan({ want: want === true, driver });
    if (plan.needsDownload) return { ...(await view()), needsDownload: true };
    const settings = getSettings();
    settings.computerUse = plan.on;
    await saveSettings();
    log.info(`Computer use turned ${plan.on ? 'on' : 'off'}; restarting the core`);
    paused = false;
    if (plan.restart) await restartCore();
    return view();
  }

  // Only ever called by the Download button, after Settings has shown the size and source and the user confirmed.
  async function downloadDriver() {
    if (downloading) throw new Error('cua-driver is already downloading.');
    if (!arch || !vendor) throw new Error('cua-driver has no build for this computer.');
    downloading = { received: 0, total: cu.pin(arch).size };
    await changed();
    let last = 0;
    try {
      log.info(`Downloading cua-driver ${cu.VERSION} (${cu.pin(arch).asset}) to ${vendor}`);
      const zip = await cu.download({
        arch,
        dir: vendor,
        onProgress: (p) => {
          downloading = p;
          if (Date.now() - last > 250) { last = Date.now(); changed().catch(() => {}); }
        },
      });
      await cu.install({ arch, dir: vendor, zip });
      await refreshDriver();
      if (!driver.verified) throw new Error(driver.problem ?? 'cua-driver did not check out after unpacking.');
      log.info(`cua-driver ${cu.VERSION} downloaded and checked`);
    } catch (e) {
      log.warn('cua-driver download failed', e.message);
      throw e;
    } finally {
      downloading = null;
      await changed();
    }
    return view();
  }

  const mcpOptions = () => ({ exe: coreBinary(), home, env });
  const knownAgent = (agent) => { if (!cu.MCP_AGENTS[agent]) throw new Error('unknown agent'); return agent; };
  // The plan without the new file's contents: the window shows what is added, not the whole file.
  const planView = ({ after, ...rest }) => rest;

  function resume() {
    if (!client?.send('computer.resume', { sessions: [] })) throw new Error("Mewndo's core isn't connected, so it can't resume yet.");
    paused = false;
    changed().catch(() => {});
  }

  // --- Show Me ---------------------------------------------------------------------------------------------------

  const recordingChanged = () => notifyMain('skills-changed', recording.view());

  function startRecording() {
    if (!on()) throw new Error('Show Me needs computer use. Turn it on in Settings, under Computer use.');
    if (!client?.connected()) throw new Error("Mewndo's core isn't connected yet. Try again in a moment.");
    if (!recording.asked()) return recording.view();
    if (!client.send('showme.start', {})) { recording.done(); throw new Error("Mewndo's core isn't connected yet."); }
    onRecordStart();
    recordingChanged();
    return recording.view();
  }

  function stopRecording() {
    client?.send('showme.stop', {});
    return recording.view();
  }

  // The desk pipe (desk/core-client.js): Show Me's messages and the takeover pause.
  function attach(c) {
    client = c;
    c.on('showme.state', ({ body }) => {
      const before = recording.view().phase;
      const v = recording.onState(body);
      if (v.phase === 'recording') indicator.show();
      else indicator.hide();
      if (v.phase === 'review' && before !== 'review') onReview();
      recordingChanged();
    });
    c.on('showme.step', ({ body }) => { recording.onStep(body); recordingChanged(); });
    c.on('computer.pause', () => { paused = true; changed().catch(() => {}); });
    c.on('computer.resume', () => { paused = false; changed().catch(() => {}); });
    // A core that restarts mid-recording has lost it; say so instead of showing "Recording" forever.
    c.on('closed', () => {
      if (['starting', 'recording'].includes(recording.view().phase)) {
        recording.onState({ recording: false, reason: "Mewndo's core restarted, so the recording stopped." });
        indicator.hide();
        recordingChanged();
      }
    });
  }

  // After start-up: check the driver, and restart the core with computer use if it was on and checks out.
  async function init() {
    await refreshDriver();
    if (on() && driver.verified && !coreHasFlag) {
      log.info('Computer use is on and cua-driver checks out; restarting the core with it');
      await restartCore();
    } else if (on() && !driver.verified) {
      log.warn('Computer use is on but cua-driver is missing or does not check out; it stays off', driver.problem ?? '');
    }
  }

  const settingsHandlers = {
    computerView: view,
    computerSet: (want) => setOn(want),
    computerDownload: () => downloadDriver(),
    computerResume: () => { resume(); return view(); },
    computerMcpPlan: async (agent) => planView(await cu.planMcp(knownAgent(agent), mcpOptions())),
    computerMcpInstall: async (agent) => {
      const r = await cu.installMcp(knownAgent(agent), mcpOptions());
      log.info(`Added Mewndo's computer-use server to ${r.name}${r.backup ? `, backup ${r.backup}` : ''}`);
      return { ...planView(r), view: await view() };
    },
    computerMcpRemove: async (agent) => {
      const r = await cu.removeMcp(knownAgent(agent), { home, env });
      return { ...r, view: await view() };
    },
  };

  const mainHandlers = {
    skillsView: async () => ({ on: on(), recording: recording.view(), skills: await skills.list(skillsDir()) }),
    skillGet: (id) => skills.read(skillsDir(), id),
    skillRecord: () => startRecording(),
    skillStop: () => stopRecording(),
    // Save the reviewed recording as a new skill.
    skillSaveRecording: async ({ name, description, steps }) => {
      const saved = await skills.create(skillsDir(), { name, description, steps });
      log.info(`Show Me: saved a skill with ${saved.steps.length} steps`);
      recording.done();
      recordingChanged();
      return saved;
    },
    skillDiscardRecording: () => { recording.done(); recordingChanged(); return recording.view(); },
    skillUpdate: (id, changes) => skills.update(skillsDir(), id, changes ?? {}),
    skillDelete: (id) => skills.remove(skillsDir(), id),
    skillOpenSettings: () => openSettings('computer'),
  };

  return { coreArgs, init, attach, view, setOn, downloadDriver, refreshDriver, settingsHandlers, mainHandlers, recording: () => recording.view() };
}

module.exports = { createComputerUse, createRecording };
