// Computer use in the app (app/computer-use.js): the pinned cua-driver, the download's hash check with a local fake
// file (no network), the install's per-file check, the switch, and the agents' MCP settings. Temporary folders only.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cu = require('../app/computer-use');
const { tempDir } = require('./helpers');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// rustfmt wraps the (name, hash) pairs over several lines; the pins are compared exactly, the line breaks are not.
const VENDOR_RS = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'core', 'crates', 'mewndo-computer', 'src', 'vendor.rs'), 'utf8')
  .replace(/\(\s+/g, '(').replace(/,\s+/g, ', ').replace(/,?\s+\)/g, ')');

test('the app pins exactly the cua-driver the core checks (vendor.rs)', () => {
  assert.match(VENDOR_RS, new RegExp(`pub const VERSION: &str = "${cu.VERSION}";`));
  for (const arch of ['x64', 'arm64']) {
    const p = cu.pin(arch);
    assert.ok(VENDOR_RS.includes(`"${p.sha256}"`), `${arch} archive hash`);
    assert.ok(VENDOR_RS.includes(p.size.toLocaleString('en').replace(/,/g, '_')), `${arch} size`);
    for (const [name, hash] of Object.entries(p.files)) assert.ok(VENDOR_RS.includes(`("${name}", "${hash}")`), `${arch} ${name}`);
    assert.strictEqual(p.url, `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.34.0/${p.asset}`);
    assert.ok(p.size < 100 * 1024 * 1024, 'under the ask-first threshold, but it is still asked');
  }
  assert.strictEqual(cu.pin('x64').size, 31_316_916);
  assert.throws(() => cu.pin('ia32'), /no Windows build/);
  assert.strictEqual(cu.archOf('x64'), 'x64');
  assert.strictEqual(cu.archOf('ia32'), null);
  assert.strictEqual(cu.vendorDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } }),
    path.join('C:\\Users\\a\\AppData\\Local', 'Mewndo', 'vendor', 'cua-driver'));
  assert.strictEqual(cu.vendorDir({ platform: 'win32', env: {} }), null);
});

// A pin for bytes the test made, so the success path can run without the real release.
function fakePin(dir, files) {
  const zipBytes = Buffer.from('pretend this is the release zip');
  const zip = path.join(dir, 'source.zip');
  fs.writeFileSync(zip, zipBytes);
  return {
    pinned: {
      ...cu.pin('x64'), asset: 'fake.zip', folder: 'fake', size: zipBytes.length, sha256: sha(zipBytes),
      files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha(b)])),
    },
    source: zip,
  };
}
// A file link; false where Windows doesn't allow one without developer mode.
function fileLink(target, at) {
  try { fs.symlinkSync(target, at, 'file'); return true; } catch (e) { if (e.code === 'EPERM') return false; throw e; }
}

const fromFile = (file) => async () => ({ total: fs.statSync(file).size, stream: fs.createReadStream(file) });

test('a download whose bytes are not the pinned ones leaves nothing behind', async () => {
  const dir = tempDir();
  const wrong = path.join(dir, 'wrong.bin');
  fs.writeFileSync(wrong, 'not the release');
  const vendor = path.join(dir, 'vendor');
  await assert.rejects(cu.download({ arch: 'x64', dir: vendor, get: fromFile(wrong) }), /is not cua-driver 0\.34\.0[\s\S]*Nothing was installed/);
  assert.deepStrictEqual(fs.readdirSync(vendor), [], 'no .part, no archive');
  // Right length, wrong bytes: still refused.
  const { pinned } = fakePin(dir, {});
  const same = path.join(dir, 'same-size.bin');
  fs.writeFileSync(same, Buffer.alloc(pinned.size, 1));
  await assert.rejects(cu.download({ arch: 'x64', dir: vendor, get: fromFile(same), pinned }), /SHA-256/);
  assert.deepStrictEqual(fs.readdirSync(vendor), []);
  // A server that fails: nothing either.
  await assert.rejects(cu.download({ arch: 'x64', dir: vendor, get: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepStrictEqual(fs.readdirSync(vendor), []);
});

test('a download that matches is renamed into place, with progress', async () => {
  const dir = tempDir();
  const { pinned, source } = fakePin(dir, {});
  const vendor = path.join(dir, 'vendor');
  const seen = [];
  const zip = await cu.download({ arch: 'x64', dir: vendor, get: fromFile(source), pinned, onProgress: (p) => seen.push(p) });
  assert.strictEqual(zip, path.join(vendor, 'fake.zip'));
  assert.deepStrictEqual(fs.readdirSync(vendor), ['fake.zip'], 'the .part is gone');
  assert.deepStrictEqual(seen.at(-1), { received: pinned.size, total: pinned.size });
});

test('install checks every program before moving any, and the status checks them again', async () => {
  const dir = tempDir();
  const files = { 'cua-driver.exe': Buffer.from('driver'), 'cua_driver_sdk.dll': Buffer.from('sdk') };
  const { pinned } = fakePin(dir, files);
  const vendor = path.join(dir, 'vendor');
  fs.mkdirSync(vendor);
  const expandWith = (contents) => async (_zip, staging) => {
    fs.mkdirSync(path.join(staging, 'fake'), { recursive: true });
    for (const [n, b] of Object.entries(contents)) fs.writeFileSync(path.join(staging, 'fake', n), b);
  };

  assert.deepStrictEqual(await cu.driverStatus(vendor, 'x64', pinned), { verified: false, missing: true, problem: null });

  // One tampered program: nothing installed, the archive and staging removed.
  fs.writeFileSync(path.join(vendor, 'fake.zip'), 'zip');
  await assert.rejects(cu.install({ arch: 'x64', dir: vendor, zip: path.join(vendor, 'fake.zip'), pinned,
    expand: expandWith({ ...files, 'cua_driver_sdk.dll': Buffer.from('evil') }) }), /cua_driver_sdk\.dll in the archive doesn't match/);
  assert.deepStrictEqual(fs.readdirSync(vendor), []);

  fs.writeFileSync(path.join(vendor, 'fake.zip'), 'zip');
  const status = await cu.install({ arch: 'x64', dir: vendor, zip: path.join(vendor, 'fake.zip'), pinned,
    expand: expandWith({ ...files, LICENSE: 'MIT' }) });
  assert.strictEqual(status.verified, true);
  assert.deepStrictEqual(fs.readdirSync(vendor).sort(), ['LICENSE', 'cua-driver.exe', 'cua_driver_sdk.dll', 'mewndo-installed.json']);

  // Changed afterwards: no longer verified, and the reason says it is never run.
  fs.writeFileSync(path.join(vendor, 'cua-driver.exe'), 'swapped');
  const after = await cu.driverStatus(vendor, 'x64', pinned);
  assert.strictEqual(after.verified, false);
  assert.match(after.problem, /never run/);
  // A link in its place is not followed.
  fs.rmSync(path.join(vendor, 'cua-driver.exe'));
  fs.writeFileSync(path.join(dir, 'elsewhere.exe'), files['cua-driver.exe']);
  if (fileLink(path.join(dir, 'elsewhere.exe'), path.join(vendor, 'cua-driver.exe'))) {
    const linked = await cu.driverStatus(vendor, 'x64', pinned);
    assert.strictEqual(linked.verified, false);
    assert.match(linked.problem, /not a plain file/);
  }
  assert.strictEqual((await cu.driverStatus(null, 'x64')).verified, false);
});

test('the switch: on needs the checked driver, off always works', () => {
  assert.deepStrictEqual(cu.switchPlan({ want: true, driver: { verified: false } }), { on: false, restart: false, needsDownload: true });
  assert.deepStrictEqual(cu.switchPlan({ want: true, driver: { verified: true } }), { on: true, restart: true, needsDownload: false });
  assert.deepStrictEqual(cu.switchPlan({ want: false, driver: { verified: false } }), { on: false, restart: true, needsDownload: false });
  assert.deepStrictEqual(cu.coreArgs({ on: true, driverVerified: true }), ['--computer-use']);
  assert.deepStrictEqual(cu.coreArgs({ on: true, driverVerified: false }), []);
  assert.deepStrictEqual(cu.coreArgs({ on: false, driverVerified: true }), []);
  assert.strictEqual(cu.statusText({ on: false }), 'Off.');
  assert.match(cu.statusText({ on: true, driver: { verified: true }, coreRunning: true, coreHasFlag: true, paused: true }), /^Paused/);
  assert.match(cu.statusText({ on: true, driver: { verified: true }, coreRunning: true, coreHasFlag: true }), /asks you first/);
  assert.match(cu.statusText({ on: true, driver: { verified: false } }), /not downloaded/);
  assert.ok(cu.LIMITS.some((l) => /mouse or press a key/.test(l)), 'the takeover rule is stated');
  assert.ok(cu.LIMITS.some((l) => /Windows yet/.test(l)), 'and that it has not run on Windows');
});

const EXE = 'C:\\Program Files\\Mewndo\\resources\\mewndo-core.exe';

test('Claude Code and Cursor: the server is added beside the user\'s own, with a backup, and removed again', async () => {
  const home = tempDir();
  const env = {};
  const claudeFile = path.join(home, '.claude.json');
  const original = { numStartups: 4, mcpServers: { mine: { command: 'x' } }, projects: { a: 1 } };
  fs.writeFileSync(claudeFile, JSON.stringify(original));
  const plan = await cu.planMcp('claude', { exe: EXE, home, env });
  assert.strictEqual(plan.installed, false);
  assert.strictEqual(plan.file, claudeFile);
  assert.deepStrictEqual(JSON.parse(plan.preview), { mcpServers: { 'mewndo-computer': { type: 'stdio', command: EXE, args: ['mcp-computer', '--agent', 'claude'], env: {} } } });
  const added = await cu.installMcp('claude', { exe: EXE, home, env });
  assert.ok(added.backup && fs.readFileSync(added.backup, 'utf8') === JSON.stringify(original));
  const now = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.deepStrictEqual(now.mcpServers.mine, { command: 'x' });
  assert.strictEqual(now.numStartups, 4);
  assert.strictEqual((await cu.planMcp('claude', { exe: EXE, home, env })).installed, true);
  assert.strictEqual((await cu.installMcp('claude', { exe: EXE, home, env })).backup, null, 'twice changes nothing');
  const removed = await cu.removeMcp('claude', { home, env });
  assert.strictEqual(removed.removed, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), original);
  assert.strictEqual((await cu.removeMcp('claude', { home, env })).removed, false);

  // Cursor: a new file is created.
  const cursor = await cu.installMcp('cursor', { exe: EXE, home, env });
  assert.strictEqual(cursor.backup, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')),
    { mcpServers: { 'mewndo-computer': { command: EXE, args: ['mcp-computer', '--agent', 'cursor'] } } });

  // A link or a broken file is refused.
  const linkHome = tempDir();
  fs.writeFileSync(path.join(linkHome, 'real.json'), '{}');
  if (fileLink(path.join(linkHome, 'real.json'), path.join(linkHome, '.claude.json'))) {
    await assert.rejects(cu.installMcp('claude', { exe: EXE, home: linkHome, env }), /is a link/);
  }
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{ broken');
  await assert.rejects(cu.planMcp('cursor', { exe: EXE, home, env }), /can't be read, so nothing was changed/);
  await assert.rejects(cu.planMcp('gemini', { exe: EXE, home, env }), /unknown agent/);
});

test('Codex: a marked block at the end of config.toml, taken out exactly', async () => {
  for (const original of ['', 'model = "o3"\n', 'model = "o3"\r\n[profiles.x]\nmodel = "y"', '# just a comment']) {
    const merged = cu.mergeToml(original, 'codex', EXE);
    assert.match(merged, /\[mcp_servers\.mewndo-computer\]/);
    assert.ok(merged.includes('command = "C:\\\\Program Files\\\\Mewndo\\\\resources\\\\mewndo-core.exe"'), merged);
    assert.ok(merged.includes('args = ["mcp-computer", "--agent", "codex"]'));
    assert.ok(merged.startsWith(original), 'the user\'s text is untouched');
    assert.strictEqual(cu.mergeToml(merged, 'codex', EXE), merged, 'twice changes nothing');
    assert.strictEqual(cu.removeTomlBlock(merged), original, JSON.stringify(original));
  }
  assert.throws(() => cu.mergeToml('[mcp_servers.mewndo-computer]\ncommand = "mine"\n', 'codex', EXE), /its own \[mcp_servers\.mewndo-computer\]/);

  const home = tempDir();
  const env = { CODEX_HOME: path.join(home, 'codex') };
  fs.mkdirSync(env.CODEX_HOME);
  const file = path.join(env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(file, 'model = "o3"\n');
  const r = await cu.installMcp('codex', { exe: EXE, home, env });
  assert.ok(r.backup);
  assert.strictEqual((await cu.planMcp('codex', { exe: EXE, home, env })).installed, true);
  await cu.removeMcp('codex', { home, env });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'model = "o3"\n');
});
