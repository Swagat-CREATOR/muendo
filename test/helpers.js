const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

// A fresh folder under the OS temp dir, removed when the test file finishes.
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muendo-test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 'junction' makes a directory junction on Windows (no admin needed) and a normal symlink elsewhere.
function linkDir(target, at) {
  fs.symlinkSync(path.resolve(target), at, 'junction');
}

module.exports = { tempDir, linkDir };
