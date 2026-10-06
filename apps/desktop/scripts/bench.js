// Benchmarks (spec §25.2 and §28.6): restoring one 1 GB file, restoring 5,000 small files, a first scan of 50,000
// files, and mewndo-core's idle memory and CPU. Each restore and the scan run on both engines: the v0 Node engine
// and the Rust core (a release build, over the pipe, as the app will use it). Prints a Markdown table with times.
// Runs in a temporary folder on the system drive, and again on every ReFS volume (a Dev Drive) it finds.
//   npm run bench            from the repository root (builds the release core first)
//   npm run bench:windows    from WSL, on Windows itself
// Targets: 5,000 files under 5 s, 1 GB under 1 s on the same volume (time until every file is in place, which
// is when the user is told "restored"; verification runs after).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createJournal, createStore, scan } = require('../engine');
const { createCore } = require('../app/core');

const EXE = process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core';
// The release build next to the debug one the tests use (scripts/windows.sh points MEWNDO_CORE_BIN at debug).
const BINARY = process.env.MEWNDO_CORE_BIN
  ? path.join(path.dirname(process.env.MEWNDO_CORE_BIN), '..', 'release', EXE)
  : path.join(__dirname, '..', '..', '..', 'core', 'target', 'release', EXE);
const GB = 1024 ** 3;
const SMALL_FILES = 5_000;
const SCAN_FILES = 50_000;
const IDLE_SAMPLE_MS = 30_000;
// After making test files, Defender scans them for a while. A real restore comes long after capture, so each one
// waits for that first.
const SETTLE_MS = 30_000;
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const freeBytes = (dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; };

function row(where, name, target, v0, rust, detail = '') {
  const met = target === null ? '' : rust.ms <= target ? 'met' : 'missed';
  const fmt = (r) => (r ? `${secs(r.ms)}${r.verifiedMs ? ` (verified ${secs(r.verifiedMs)})` : ''}` : 'not run');
  rows.push({ where, name, target: target === null ? '' : `under ${secs(target)}`, v0: fmt(v0), rust: fmt(rust), met, detail });
  console.log(`  ${name}: v0 ${fmt(v0)} · Rust ${fmt(rust)} ${met} ${detail}`);
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
}

// The machine: Defender, file system of each drive, disks, CPU and memory.
function machine() {
  const info = { cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / GB), platform: `${os.type()} ${os.release()}` };
  if (process.platform !== 'win32') return { ...info, defender: 'not Windows', volumes: [], disks: [] };
  const j = JSON.parse(powershell(`
    $d = try { (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { $null }
    @{ defender = $d;
       volumes = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { @{ letter = [string]$_.DriveLetter; fs = $_.FileSystemType } });
       disks = @(Get-PhysicalDisk | ForEach-Object { "$($_.FriendlyName) ($($_.BusType) $($_.MediaType))" }) } | ConvertTo-Json -Depth 3`));
  return { ...info, defender: j.defender === true ? 'on' : j.defender === false ? 'OFF' : 'unknown', volumes: j.volumes, disks: j.disks };
}

// A process's memory (working set and private bytes) and CPU time so far.
function usage(pid) {
  if (process.platform === 'win32') {
    const [ws, priv, cpuMs] = powershell(`$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $($p.TotalProcessorTime.TotalMilliseconds)"`).split(' ').map(Number);
    return { ws, priv, cpuMs };
  }
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (k) => Number(status.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0) * 1024;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return { ws: kb('VmRSS'), priv: kb('RssAnon'), cpuMs: (Number(stat[11]) + Number(stat[12])) * 10 };
}

async function startCore(dir) {
  let core;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: BINARY, runDir: dir, logDir: path.join(dir, 'logs'), log: { info() {}, warn() {}, error() {} },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
  return core;
}

async function protect(root, dataDir, extra = {}) {
  const journal = createJournal({ root, dataDir, store: createStore(path.join(dataDir, 'store')), ...extra });
  journal.on('warning', (e) => console.log(`  warning: ${e.message}`));
  await journal.start();
  return journal;
}

// One restore on one engine: the time until every file is in place ("restored"), and until verified.
async function timeRestore(journal, savePointId, core) {
  journal.core = core; // null: the v0 engine
  await sleep(SETTLE_MS);
  let placed = null;
  const t0 = performance.now();
  const onProgress = (p) => {
    const done = core ? p.phase === 'restored' : p.phase === 'restoring' && p.done === p.total;
    if (done && placed === null) placed = performance.now() - t0;
  };
  journal.on('progress', onProgress);
  try {
    const result = await journal.restore(savePointId);
    if (!result.verified || result.failures.length) throw new Error(`restore not verified: ${JSON.stringify(result).slice(0, 500)}`);
    return { ms: placed ?? performance.now() - t0, verifiedMs: performance.now() - t0, result };
  } finally { journal.off('progress', onProgress); }
}

// An agent deletes a folder of 5,000 small files; restore it on each engine. Then an agent edits all of them:
// restore, and undo that restore (the edited versions come back out of the trash: rung 1).
async function smallFiles(base, core, where) {
  const root = path.join(base, 'small');
  for (let i = 0; i < SMALL_FILES; i++) {
    const dir = path.join(root, 'src', `d${i % 100}`);
    if (i < 100) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.js`), `// file ${i}\n${crypto.randomBytes(256 + (i % 2048)).toString('base64')}\n`);
  }
  const journal = await protect(root, path.join(base, 'small-data'));
  try {
    const sp = await journal.createSavePoint({ label: 'clean' });
    const runs = {};
    for (const [engine, c] of [['rust', core], ['v0', null]]) {
      fs.rmSync(path.join(root, 'src'), { recursive: true });
      runs[engine] = await timeRestore(journal, sp.id, c);
    }
    row(where, `Restore ${SMALL_FILES.toLocaleString()} small files (folder deleted)`, 5000, runs.v0, runs.rust,
      `ladder ${JSON.stringify(runs.rust.result.ladder)}, core ${secs(runs.rust.result.timings.placedMs)}`);

    for (let i = 0; i < SMALL_FILES; i++) fs.appendFileSync(path.join(root, 'src', `d${i % 100}`, `f${i}.js`), '// edited by an agent\n');
    const edited = await timeRestore(journal, sp.id, core);
    const undo = await timeRestore(journal, edited.result.beforeUndoId, core);
    row(where, `Restore ${SMALL_FILES.toLocaleString()} edited files (each old version to the trash)`, 5000, null, edited,
      `ladder ${JSON.stringify(edited.result.ladder)}`);
    row(where, 'Undo that restore (edited versions renamed back from the trash)', 5000, null, undo,
      `ladder ${JSON.stringify(undo.result.ladder)}`);
  } finally {
    await journal.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(base, 'small-data'), { recursive: true, force: true });
  }
}

// One 1 GB file, deleted by an agent, restored on each engine. `name` decides how the store keeps it: a video as
// is (a copy, or a block clone on ReFS), anything else gzipped (unpacked).
async function oneGb(base, core, where, name, label) {
  const need = 5 * GB; // the file, its stored copy, and 3 GB to spare: never fill the user's drive
  if (freeBytes(base) < need) {
    console.log(`  skipped ${label}: needs ${need / GB} GB free, ${(freeBytes(base) / GB).toFixed(1)} GB free`);
    rows.push({ where, name: `Restore one 1 GB file, ${label}`, target: 'under 1 s', v0: 'not run', rust: 'not run', met: 'not run', detail: 'not enough free disk space' });
    return;
  }
  const root = path.join(base, 'gb');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  const chunk = crypto.randomBytes(16 * 1024 * 1024); // random: nothing to compress, as in a real video or model
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < 64; i++) { chunk.writeUInt32LE(i, 0); fs.writeSync(fd, chunk); }
  fs.closeSync(fd);
  const journal = await protect(root, path.join(base, 'gb-data'), { maxFileSize: 2 * GB });
  try {
    const sp = await journal.createSavePoint({ label: 'clean' });
    const runs = {};
    for (const [engine, c] of [['rust', core], ['v0', null]]) {
      fs.rmSync(file);
      runs[engine] = await timeRestore(journal, sp.id, c);
    }
    row(where, `Restore one 1 GB file, ${label}`, 1000, runs.v0, runs.rust, `ladder ${JSON.stringify(runs.rust.result.ladder)}`);
  } finally {
    await journal.stop();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(base, 'gb-data'), { recursive: true, force: true });
  }
}

// The first scan when a folder of 50,000 files is protected: every file read, hashed and stored. Then the core
// watches it, idle, and its memory and CPU are sampled.
async function bigScan(base, core, where, { idle }) {
  const root = path.join(base, 'scan');
  for (let i = 0; i < SCAN_FILES; i++) {
    const dir = path.join(root, `d${i % 500}`);
    if (i < 500) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i} ${crypto.randomBytes(64 + (i % 1024)).toString('hex')}\n`);
  }
  try {
    await sleep(SETTLE_MS);
    let t0 = performance.now();
    const reply = await core.request('scan', { root, store: path.join(base, 'scan-store-rust') }, { within: 60 * 60_000 });
    const rust = { ms: performance.now() - t0 };
    await sleep(SETTLE_MS);
    t0 = performance.now();
    await scan(root, { hash: createStore(path.join(base, 'scan-store-v0')).put });
    const v0 = { ms: performance.now() - t0 };
    row(where, `First scan of ${SCAN_FILES.toLocaleString()} files (hash and store all)`, null, v0, rust, `${reply.hashed} hashed`);

    if (idle) {
      await core.request('watch', { root });
      await sleep(10_000); // let the feed's catch-up finish
      const pid = core.status().pid;
      const a = usage(pid);
      await sleep(IDLE_SAMPLE_MS);
      const b = usage(pid);
      const cpu = ((b.cpuMs - a.cpuMs) / IDLE_SAMPLE_MS) * 100;
      const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
      rows.push({
        where, name: `mewndo-core idle, watching the ${SCAN_FILES.toLocaleString()}-file folder (${IDLE_SAMPLE_MS / 1000} s)`, target: '',
        v0: '', rust: `${mb(b.ws)} working set, ${mb(b.priv)} private, ${cpu.toFixed(2)}% CPU`, met: '', detail: '',
      });
      console.log(`  idle: ${rows.at(-1).rust}`);
      await core.request('unwatch', { root });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.join(base, 'scan-store-rust'), { recursive: true, force: true });
    fs.rmSync(path.join(base, 'scan-store-v0'), { recursive: true, force: true });
  }
}

async function runAll(parent, where, core, { idle }) {
  const base = fs.mkdtempSync(path.join(parent, 'mewndo-bench-'));
  console.log(`\n${where}: ${base}`);
  try {
    await smallFiles(base, core, where);
    await oneGb(base, core, where, 'video.mp4', 'stored as is (a video)');
    await oneGb(base, core, where, 'model.bin', 'stored gzipped');
    await bigScan(base, core, where, { idle });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  if (!fs.existsSync(BINARY)) throw new Error(`no release build of mewndo-core at ${BINARY}: run \`npm run bench\` from the repository root`);
  const m = machine();
  console.log(`Mewndo benchmarks  ${m.platform} · ${m.cpu} (${m.cores} threads) · ${m.memoryGb} GB · Defender real-time protection: ${m.defender}`);
  for (const d of m.disks) console.log(`  disk: ${d}`);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mewndo-bench-core-'));
  const core = await startCore(runDir);
  try {
    const systemFs = m.volumes.find((v) => v.letter === os.tmpdir()[0])?.fs ?? 'local';
    await runAll(os.tmpdir(), `${os.tmpdir()[0]}: (${systemFs})`, core, { idle: true });
    const refs = m.volumes.filter((v) => v.fs === 'ReFS');
    if (!refs.length) console.log('\nNo ReFS volume (Dev Drive) on this PC: skipped those runs.');
    for (const v of refs) await runAll(`${v.letter}:\\`, `${v.letter}: (ReFS / Dev Drive)`, core, { idle: false });
  } finally {
    await core.stop();
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  console.log(`\n## Results (${new Date().toISOString().slice(0, 10)})\n`);
  console.log(`${m.platform} · ${m.cpu} (${m.cores} threads) · ${m.memoryGb} GB RAM · ${m.disks.join(', ') || 'disk unknown'} · Defender real-time protection ${m.defender}\n`);
  console.log('| Where | Case | Target | v0 engine | Rust core | Target met | Notes |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.where} | ${r.name} | ${r.target} | ${r.v0} | ${r.rust} | ${r.met} | ${r.detail} |`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
