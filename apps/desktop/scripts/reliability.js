// Reliability tests: realistic disasters at realistic sizes, end to end. Run with `npm run reliability`.
// Everything happens in a temporary folder that is removed afterwards.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createJournal, createStore, scan } = require('../engine');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mewndo-reliability-'));
let passed = 0;
let failed = 0;
let skipped = 0;
let clock = performance.now();

const ms = (t) => (t >= 1000 ? `${(t / 1000).toFixed(1)} s` : `${Math.round(t)} ms`);
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const rel = (...parts) => parts.join('/');

// One line per check, with the time spent since the previous check (the work that check covers).
function check(name, ok, detail = '') {
  const now = performance.now();
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${ms(now - clock).padStart(8)}${detail ? `   ${detail}` : ''}`);
  clock = now;
  if (ok) passed++; else failed++;
}

function skip(name, why) {
  console.log(`  SKIP  ${name.padEnd(56)} ${''.padStart(8)}   ${why}`);
  skipped++;
}

async function scenario(title, fn) {
  console.log(`\n${title}`);
  const start = performance.now();
  clock = start;
  try {
    await fn();
  } catch (e) {
    check('scenario ran to the end', false, e.stack.split('\n').slice(0, 3).join(' | '));
  }
  console.log(`  ${''.padEnd(62)} total ${ms(performance.now() - start)}`);
}

function write(root, p, content) {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), content);
}

// A protected folder plus its own data folder. Real default timings, as a user would have them.
async function protect(name, files) {
  const root = path.join(base, name, 'project');
  fs.mkdirSync(root, { recursive: true });
  for (const [p, content] of Object.entries(files)) write(root, p, content);
  const dataDir = path.join(base, name, 'data');
  const opts = { root, dataDir, store: createStore(path.join(dataDir, 'store')) };
  const journal = createJournal(opts);
  const warnings = [];
  journal.on('warning', (e) => warnings.push(e));
  await journal.start();
  return { root, opts, journal, warnings };
}

// Paths whose type, hash or link target differ between a save point's index and a fresh scan.
async function differences(expected, root) {
  const now = await scan(root);
  const out = [];
  for (const p of new Set([...Object.keys(expected), ...Object.keys(now)])) {
    const a = expected[p];
    const b = now[p];
    if (!a || !b || a.type !== b.type || a.hash !== b.hash || a.target !== b.target) out.push(p);
  }
  return out.sort();
}

const preview = (list) => (list.length ? `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` +${list.length - 3} more` : ''}` : '');
const randomText = (i) => `file ${i}\n${crypto.randomBytes(16 + (i % 200)).toString('hex')}\n`;

// ~300 files: d0..d9 / s0..s2 / f0..f9
function projectFiles(count = 300) {
  const files = {};
  for (let i = 0; i < count; i++) files[rel(`d${Math.floor(i / 30)}`, `s${Math.floor(i / 10) % 3}`, `f${i % 10}.txt`)] = randomText(i);
  return files;
}

async function agentDisaster() {
  const files = projectFiles();
  const precious = path.join(base, 'disaster', 'precious');
  for (let i = 0; i < 20; i++) write(precious, `keep${i}.txt`, randomText(i));
  const { root, journal, warnings } = await protect('disaster', files);
  try {
    fs.symlinkSync(precious, path.join(root, 'precious-link'), 'junction');
    const preciousBefore = await scan(precious);
    const sp = await journal.createSavePoint({ label: 'before agent' });
    const expected = (await journal.getSavePoint(sp.id)).index;
    check('protected 300 files and a junction, save point created', Object.keys(expected).length > 300
      && expected['precious-link']?.type === 'link', `${Object.keys(files).length} files`);

    // The reckless agent.
    const names = Object.keys(files).filter((p) => !p.startsWith('d9/')).sort();
    for (const p of names.slice(0, 200)) fs.rmSync(path.join(root, p));
    for (const p of names.slice(200, 220)) fs.appendFileSync(path.join(root, p), 'agent was here\n');
    for (const [i, p] of names.slice(220, 225).entries()) write(root, `renamed/r${i}.txt`, files[p]), fs.rmSync(path.join(root, p));
    const created = Array.from({ length: 10 }, (_, i) => rel('agent-output', `n${i % 3}`, `new${i}.txt`));
    for (const p of created) write(root, p, `agent junk ${p}\n`);
    fs.rmSync(path.join(root, 'd9'), { recursive: true });
    fs.unlinkSync(path.join(root, 'precious-link'));
    check('agent deleted 200, edited 20, renamed 5, created 10, removed d9 and junction',
      (await differences(expected, root)).length > 0);

    const result = await journal.restore(sp.id);
    check('restore finished and verified itself', result.verified && result.failures.length === 0,
      `written ${result.counts.written}, trashed ${result.counts.trashed}, links ${result.counts.linked}`);

    const diff = await differences(expected, root);
    check('every path and hash matches the save point', diff.length === 0, preview(diff));

    const missing = created.filter((p) => {
      try { return fs.readFileSync(path.join(result.trashFolder, p), 'utf8') !== `agent junk ${p}\n`; } catch { return true; }
    });
    check("the 10 new files are in Mewndo's trash", missing.length === 0, preview(missing));

    const link = path.join(root, 'precious-link');
    const isLink = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink();
    const target = isLink && path.resolve(root, fs.readlinkSync(link).replace(/^\\\\\?\\/, ''));
    check('the junction is back and points to precious', isLink && target === precious, target || 'missing');

    const preciousAfter = await scan(precious);
    check('nothing in precious was touched', JSON.stringify(preciousAfter) === JSON.stringify(preciousBefore));
    check('no background warnings', warnings.length === 0, warnings.map((w) => w.message).join('; '));
  } finally { await journal.stop(); }
}

async function fastBurst() {
  const { root, journal, warnings } = await protect('burst', {});
  try {
    const names = Array.from({ length: 5000 }, (_, i) => rel(`b${i % 50}`, `f${i}.txt`));
    for (const p of names) write(root, p, `small ${p}\n`);
    check('created 5,000 small files', true);

    const sp = await journal.createSavePoint({ label: 'after burst' });
    const expected = (await journal.getSavePoint(sp.id)).index;
    const captured = names.filter((p) => expected[p]?.hash).length;
    check('save point captured all 5,000', captured === 5000, `${captured} captured`);

    const start = performance.now();
    for (const p of names) fs.rmSync(path.join(root, p));
    const deleteMs = performance.now() - start;
    await sleep(500); // let the watcher react to the burst while the folder is empty
    check('deleted all 5,000 within a few seconds', deleteMs < 5000 && names.every((p) => !fs.existsSync(path.join(root, p))),
      `in ${ms(deleteMs)}`);

    const result = await journal.restore(sp.id);
    check('restore finished and verified itself', result.verified && result.failures.length === 0,
      `written ${result.counts.written}`);
    const back = names.filter((p) => fs.readFileSync(path.join(root, p), 'utf8') === `small ${p}\n`).length;
    check('all 5,000 came back with the right content', back === 5000, `${back} back`);
    const diff = await differences(expected, root);
    check('every path and hash matches the save point', diff.length === 0, preview(diff));
    check('no background warnings', warnings.length === 0, warnings.map((w) => w.message).join('; '));
  } finally { await journal.stop(); }
}

async function crashDuringRestore() {
  const files = projectFiles();
  const { root, opts, journal } = await protect('crash', files);
  const sp = await journal.createSavePoint({ label: 'good' });
  const expected = (await journal.getSavePoint(sp.id)).index;
  for (const p of Object.keys(files).slice(0, 150)) fs.rmSync(path.join(root, p));
  for (const p of Object.keys(files).slice(150, 200)) fs.appendFileSync(path.join(root, p), 'edited\n');
  for (let i = 0; i < 20; i++) write(root, `junk/j${i}.txt`, 'junk');

  const plan = await journal.planRestore(sp.id);
  const total = plan.trash.length + plan.rmdirs.length + plan.mkdirs.length + plan.write.length + plan.links.length;
  const half = Math.floor(total / 2);
  let crashed = false;
  try { await journal.restore(sp.id, { crashAfterSteps: half }); } catch (e) { crashed = /simulated crash/.test(e.message); }
  const logs = fs.readdirSync(path.join(journal.folderDir, 'restores'))
    .map((n) => JSON.parse(fs.readFileSync(path.join(journal.folderDir, 'restores', n), 'utf8')));
  const unfinished = logs.filter((l) => l.status === 'running');
  check('restore stopped halfway, leaving an unfinished log', crashed && unfinished.length === 1,
    `stopped after ${half} of ${total} steps`);
  const midway = (await differences(expected, root)).length;
  check('folder is part-way restored', midway > 0, `${midway} paths still differ`);
  await journal.stop();

  // Relaunch.
  const relaunched = createJournal(opts);
  const restored = [];
  relaunched.on('restored', (r) => restored.push(r));
  await relaunched.start();
  try {
    const r = restored[0];
    check('relaunch found the unfinished log and finished it', restored.length === 1 && r.resumed);
    check('resumed restore verified itself', r?.verified && r.failures.length === 0);
    const diff = await differences(expected, root);
    check('every path and hash matches the save point', diff.length === 0, preview(diff));
    const log = JSON.parse(fs.readFileSync(path.join(relaunched.folderDir, 'restores', `${unfinished[0].id}.json`), 'utf8'));
    check('restore log is marked done', log.status === 'done');
  } finally { await relaunched.stop(); }
}

// Hold a file so it can't be replaced. Windows: an open handle that refuses sharing, as an editor or
// antivirus would. Linux/macOS never lock open files, so the file is held open and its folder made read-only.
async function lock(file) {
  if (process.platform === 'win32') {
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `$f = [System.IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); 'locked'; [Console]::In.ReadLine(); $f.Close()`]);
    await new Promise((resolve, reject) => { ps.stdout.once('data', resolve); ps.once('error', reject); });
    return { how: 'open handle with no sharing', release: () => new Promise((r) => { ps.once('exit', r); ps.stdin.end('\n'); }) };
  }
  const fd = fs.openSync(file, 'r');
  fs.chmodSync(path.dirname(file), 0o555);
  return {
    how: 'held open + read-only folder',
    release: async () => { fs.chmodSync(path.dirname(file), 0o755); fs.closeSync(fd); },
  };
}

async function lockedFile() {
  if (process.platform !== 'win32' && process.getuid?.() === 0) {
    skip('locked file', 'running as root: permissions cannot simulate a lock');
    return;
  }
  const files = {};
  for (let i = 0; i < 20; i++) files[`f${i}.txt`] = randomText(i);
  files['stays-locked/report.docx'] = 'original report';
  files['briefly-locked/notes.txt'] = 'original notes';
  const { root, journal } = await protect('locked', files);
  try {
    const sp = await journal.createSavePoint({ label: 'before edits' });
    for (const p of Object.keys(files)) fs.appendFileSync(path.join(root, p), 'edited by agent\n');

    const stays = await lock(path.join(root, 'stays-locked/report.docx'));
    const briefly = await lock(path.join(root, 'briefly-locked/notes.txt'));
    const waits = [];
    journal.on('retry', (r) => {
      waits.push(r);
      if (r.path === 'briefly-locked/notes.txt' && r.attempt === 2) briefly.release(); // freed while Mewndo waits
    });
    let result;
    try { result = await journal.restore(sp.id); } finally { await stays.release(); }
    check('restore finished despite the locks', !!result, stays.how);

    const failure = result.failures.find((f) => f.path === 'stays-locked/report.docx');
    check('kept retrying the locked file', failure?.attempts > 1
      && waits.filter((w) => w.path === 'stays-locked/report.docx').length === failure.attempts - 1,
    failure && `${failure.attempts} attempts, a retry event for each wait`);
    check('reported the locked file clearly', result.failures.length === 1 && /Could not .+ after \d+ attempts/.test(failure?.message),
      failure?.message);
    const retriedOk = result.retried.find((r) => r.path === 'briefly-locked/notes.txt');
    check('a lock released mid-restore was retried and restored', !!retriedOk
      && fs.readFileSync(path.join(root, 'briefly-locked/notes.txt'), 'utf8') === 'original notes',
      retriedOk && `succeeded on attempt ${retriedOk.attempts}`);
    const others = Object.keys(files).filter((p) => !p.startsWith('stays-locked/'));
    const wrong = others.filter((p) => fs.readFileSync(path.join(root, p), 'utf8') !== files[p]);
    check('restored everything else', wrong.length === 0, `${others.length - wrong.length} of ${others.length}`);
    check('verification reports only the locked file',
      result.verified === false && JSON.stringify(result.mismatches) === '["stays-locked/report.docx"]',
      `mismatches: ${result.mismatches.join(', ')}`);
  } finally { await journal.stop(); }
}

async function main() {
  console.log(`Mewndo reliability tests  (${process.platform}, Node ${process.version})`);
  const start = performance.now();
  try {
    await scenario('1. Agent disaster', agentDisaster);
    await scenario('2. Fast burst of 5,000 files', fastBurst);
    await scenario('3. Crash during restore', crashDuringRestore);
    await scenario('4. Locked file', lockedFile);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  const ok = failed === 0 && passed > 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}  in ${ms(performance.now() - start)}`);
  process.exitCode = ok ? 0 : 1;
}

main();
