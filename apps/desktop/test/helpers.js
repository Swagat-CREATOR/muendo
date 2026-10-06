const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

// A fresh folder under the OS temp dir, removed when the test file finishes.
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mewndo-test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 'junction' makes a directory junction on Windows (no admin needed) and a normal symlink elsewhere.
function linkDir(target, at) {
  fs.symlinkSync(path.resolve(target), at, 'junction');
}

// The mewndo-core binary cargo built (`npm test` at the repository root builds it first). MEWNDO_CORE_BIN points
// elsewhere, e.g. at a Windows build on C: (scripts/windows.sh sets it).
const CORE_BINARY = process.env.MEWNDO_CORE_BIN
  || path.join(__dirname, '..', '..', '..', 'core', 'target', 'debug', process.platform === 'win32' ? 'mewndo-core.exe' : 'mewndo-core');

module.exports = { tempDir, linkDir, CORE_BINARY };
