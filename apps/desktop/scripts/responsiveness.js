// Responsiveness check: starts the real app with a throwaway profile, protects a folder of 20,000 files and,
// while the first scan runs, checks that a message from the window to the engine process and back always
// completes within one second. Run with `npm run responsiveness`. Everything happens in a temporary folder.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron'); // path to the Electron binary

const FILES = 20_000;
const LIMIT_MS = 1000;
const SAMPLE_FOR_MS = 30_000;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mewndo-responsiveness-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (ok) passed++; else failed++;
}

// Evaluate JavaScript in the app window through the DevTools protocol.
async function connect(port) {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('the app window never appeared');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); };
  const evaluate = (expression) => new Promise((resolve, reject) => {
    pending.set(++id, (msg) => {
      const r = msg.result;
      if (r?.exceptionDetails) reject(new Error(r.exceptionDetails.exception?.description ?? 'evaluation failed'));
      else resolve(r?.result?.value);
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { evaluate, close: () => ws.close() };
}

async function main() {
  console.log(`Mewndo responsiveness check  (${process.platform})`);
  const folder = path.join(base, 'big');
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(folder, `d${i % 200}`);
    if (i < 200) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i} ${'x'.repeat(i % 3000)}`);
  }
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'app-settings.json'), JSON.stringify({ setupDone: true, openAtLogin: false }));
  console.log(`  made ${FILES.toLocaleString()} files`);

  const app = spawn(electron, [path.join(__dirname, '..'), '--remote-debugging-port=0'], {
    env: { ...process.env, MEWNDO_USER_DATA: profile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the app did not start')), 30_000);
    app.stderr.on('data', (d) => {
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(String(d));
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    app.on('exit', (code) => reject(new Error(`the app exited early (code ${code})`)));
  });
  const page = await connect(port);
  try {
    await page.evaluate('new Promise((r) => { const t = setInterval(() => { if (window.mewndo) { clearInterval(t); r(); } }, 50); })');
    const accepted = await page.evaluate(`window.mewndo.protect(${JSON.stringify([folder])})`);
    check('protecting a 20,000-file folder was accepted', accepted?.[0]?.ok === true, accepted?.[0]?.error ?? '');

    // While the first scan runs: window -> main -> engine process -> main -> window, every 250 ms.
    const times = [];
    let phases = new Set();
    const start = Date.now();
    while (Date.now() - start < SAMPLE_FOR_MS) {
      const s = await page.evaluate(`(async () => {
        const t = performance.now(); await window.mewndo.ping(); const ms = performance.now() - t;
        const f = (await window.mewndo.state()).folders[0];
        return { ms, status: f?.status, phase: f?.progress?.phase, hashed: f?.progress?.hashed };
      })()`);
      if (s.status !== 'scanning') break;
      times.push(s.ms);
      if (s.phase) phases.add(s.phase);
      await sleep(250);
    }
    const worst = Math.max(...times);
    const status = await page.evaluate('window.mewndo.state().then((s) => s.folders[0])');
    check('sampled while the first scan was running', times.length >= 20 && phases.has('hashing'),
      `${times.length} round trips, phases: ${[...phases].join(', ')}, ${status.progress?.hashed ?? 0} files hashed so far`);
    check(`every round trip to the engine took under ${LIMIT_MS} ms`, worst < LIMIT_MS,
      `worst ${Math.round(worst)} ms, median ${Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)])} ms`);
  } finally {
    page.close();
    app.kill('SIGTERM');
    await new Promise((r) => { if (app.exitCode !== null) r(); else app.on('exit', r); });
  }
}

main()
  .catch((e) => check('check ran to the end', false, e.message))
  .finally(() => {
    fs.rmSync(base, { recursive: true, force: true });
    const ok = failed === 0 && passed > 0;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
    process.exitCode = ok ? 0 : 1;
  });
