// Agent awareness: which AI agents are running, judged from the list of running processes. The agents to look for
// live in a JSON file users can edit (agents.json in Mewndo's data folder); it is re-read on every check, so
// additions apply without a restart.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { writeFileAtomic } = require('./store');

// A process is an agent when its name (file name without .exe) is one of `names`, or its executable path or
// command line contains one of `commandLine`, and it contains none of `notCommandLine`. All case-insensitive.
// Claude Code and the Claude desktop app are both "claude" on Windows; only the install path tells them apart.
const CLAUDE_DESKTOP_PATHS = ['AnthropicClaude', 'WindowsApps\\Claude', '\\Programs\\Claude\\', 'Claude.app/Contents'];
const DEFAULT_AGENTS = [
  { name: 'Claude Code', names: ['claude'], commandLine: ['@anthropic-ai/claude-code', '@anthropic-ai\\claude-code'], notCommandLine: CLAUDE_DESKTOP_PATHS },
  { name: 'Claude desktop', names: [], commandLine: CLAUDE_DESKTOP_PATHS, notCommandLine: [] },
  { name: 'Cursor', names: ['cursor', 'cursor-agent'], commandLine: ['Cursor.app/Contents', '\\Programs\\cursor\\'], notCommandLine: [] },
  { name: 'Codex', names: ['codex'], commandLine: ['@openai/codex', '@openai\\codex'], notCommandLine: [] },
  { name: 'Windsurf', names: ['windsurf'], commandLine: ['Windsurf.app/Contents', '\\Programs\\Windsurf\\'], notCommandLine: [] },
  { name: 'OpenClaw', names: ['openclaw'], commandLine: ['openclaw'], notCommandLine: [] },
];
const HELP = 'AI agents Mewndo looks for. A running process counts as an agent when its file name (without .exe) is in '
  + '"names", or its path or command line contains a text in "commandLine", and contains nothing in "notCommandLine". '
  + 'Case does not matter. Add your own entries; changes apply within a few seconds.';

const processName = (p) => path.basename(String(p.name || p.exe || '').replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();

// Names of the agents among the given processes ({ name, exe, cmd }).
function matchAgents(processes, agents) {
  const found = new Set();
  for (const p of processes) {
    const name = processName(p);
    const text = `${p.exe ?? ''} ${p.cmd ?? ''}`.toLowerCase();
    for (const a of agents) {
      const hit = (a.names ?? []).some((n) => n.toLowerCase() === name)
        || (a.commandLine ?? []).some((c) => c && text.includes(c.toLowerCase()));
      if (hit && !(a.notCommandLine ?? []).some((c) => c && text.includes(c.toLowerCase()))) found.add(a.name);
    }
  }
  return found;
}

function validAgents(json) {
  const list = json?.agents;
  if (!Array.isArray(list) || !list.every((a) => a && typeof a.name === 'string' && a.name.trim())) {
    throw new Error('agents.json must look like { "agents": [ { "name": "...", "names": [...], "commandLine": [...] } ] }');
  }
  const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);
  return list.map((a) => ({ name: a.name.trim(), names: strings(a.names), commandLine: strings(a.commandLine), notCommandLine: strings(a.notCommandLine) }));
}

// The agent list; created with the defaults the first time. A file the user broke is never overwritten: the
// caller keeps using the last good list and tells the user.
async function loadAgents(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    await writeFileAtomic(file, `${JSON.stringify({ _help: HELP, agents: DEFAULT_AGENTS }, null, 2)}\n`);
    return DEFAULT_AGENTS;
  }
  return validAgents(JSON.parse(text));
}

// --- Listing processes -----------------------------------------------------------------------------------------------

// Windows: one hidden PowerShell lists processes with their paths and command lines every intervalMs and prints
// them as one JSON line. Starting PowerShell for every check would cost far more. It exits on any error, e.g.
// when Mewndo is gone and nobody reads its output anymore.
function windowsProcessSource(intervalMs) {
  const script = `trap { exit 1 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $p = @(Get-CimInstance Win32_Process | Select-Object ProcessId, Name, ExecutablePath, CommandLine)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $p -Compress -Depth 2))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${Math.max(1000, intervalMs)}
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let latest = null;
  let child = null;
  let stopped = false;
  let error = null;
  const start = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          latest = JSON.parse(line).map((p) => ({ pid: p.ProcessId, name: p.Name, exe: p.ExecutablePath, cmd: p.CommandLine }));
          error = null;
        } catch { /* a partial or odd line: keep the previous list */ }
      }
    });
    child.on('error', (e) => { error = e; });
    child.on('exit', () => { if (!stopped) setTimeout(start, 5000).unref(); }); // restart if it ever dies
  };
  start();
  return {
    async list() {
      if (error) throw error;
      return latest; // null until the first list arrives
    },
    stop() { stopped = true; child?.kill(); },
  };
}

// Linux and macOS: ps, once per check. Names and command lines come from two calls, joined on the process id,
// because either can contain spaces.
function psProcessSource() {
  const ps = (field) => new Promise((resolve, reject) => {
    execFile('ps', ['-axo', `pid=,${field}=`], { maxBuffer: 32 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out)));
  });
  const rows = (out) => new Map(out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  return {
    async list() {
      const [names, args] = await Promise.all([ps('comm'), ps('args')]);
      const cmds = rows(args);
      return [...rows(names)].map(([pid, name]) => ({ pid: Number(pid), name, exe: name, cmd: cmds.get(pid) ?? '' }));
    },
    stop() {},
  };
}

const defaultProcessSource = (intervalMs) => (process.platform === 'win32' ? windowsProcessSource(intervalMs) : psProcessSource());

// Checks every intervalMs and calls onChange({ started, stopped, running }) when the set of running agents
// changes. Agents already running at the first check count as started. listProcesses replaces the real
// process list in tests.
function createAgentWatcher({ agentsFile, intervalMs = 5000, listProcesses, onChange, onError = () => {} }) {
  const source = listProcesses ? { list: listProcesses, stop() {} } : defaultProcessSource(intervalMs);
  let agents = DEFAULT_AGENTS;
  let agentsProblem = null;
  let running = new Set();
  let timer = null;
  let checking = false;

  async function check() {
    if (checking) return;
    checking = true;
    try {
      try {
        agents = await loadAgents(agentsFile);
        agentsProblem = null;
      } catch (e) {
        if (agentsProblem !== e.message) onError(new Error(`agents.json can't be used, so the previous list is kept: ${e.message}`));
        agentsProblem = e.message;
      }
      const processes = await source.list();
      if (!processes) return; // the first list isn't ready yet
      const now = matchAgents(processes, agents);
      const started = [...now].filter((n) => !running.has(n));
      const stopped = [...running].filter((n) => !now.has(n));
      running = now;
      if (started.length || stopped.length) onChange({ started, stopped, running: [...now] });
    } catch (e) {
      onError(e);
    } finally {
      checking = false;
    }
  }

  return {
    start() {
      timer = setInterval(check, intervalMs);
      timer.unref();
      return check();
    },
    check,
    stop() { clearInterval(timer); source.stop(); },
  };
}

module.exports = { createAgentWatcher, matchAgents, loadAgents, DEFAULT_AGENTS };
