// Run a command with a mewndo-core running and MEWNDO_CORE_PIPE pointing at it, so every journal the command
// creates restores through the Rust core (engine/core-client.js). Used to run every v0 test and the reliability
// suite against the Rust core:
//   node apps/desktop/scripts/with-core.js node --test "apps/desktop/test/**/*.test.js"
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCore } = require('../app/core');

const EXE = process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core';
const BINARY = process.env.MEWNDO_CORE_BIN || path.join(__dirname, '..', '..', '..', 'core', 'target', 'debug', EXE);

(async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mewndo-with-core-'));
  let core;
  await new Promise((resolve, reject) => {
    core = createCore({
      binary: BINARY, runDir, logDir: path.join(runDir, 'logs'), log: { info() {}, warn() {}, error: (...a) => console.error(...a) },
      onChange: (s) => (s.state === 'running' ? resolve() : ['failed', 'missing'].includes(s.state) && reject(new Error(s.message))),
    });
    core.start();
  });
  const [cmd, ...args] = process.argv.slice(2);
  const child = spawn(cmd === 'node' ? process.execPath : cmd, args, { stdio: 'inherit', env: { ...process.env, MEWNDO_CORE_PIPE: core.address } });
  const code = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
  await core.stop();
  fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(code);
})().catch((e) => { console.error(e); process.exit(1); });
