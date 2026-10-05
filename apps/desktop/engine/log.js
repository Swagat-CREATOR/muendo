// Mewndo's log: <data>/logs/mewndo.log, one line per event. When it passes maxBytes it becomes mewndo.log.1 (older
// ones move up, keeping `keep` of them), so the log never grows without limit. Writes are queued and async, and a
// failure to log never breaks Mewndo.
const fsp = require('node:fs/promises');
const path = require('node:path');

function createLog(dir, { maxBytes = 1024 * 1024, keep = 3 } = {}) {
  const file = path.join(dir, 'mewndo.log');
  let queue = Promise.resolve();
  let size = null;

  async function rotate() {
    for (let i = keep - 1; i >= 1; i--) await fsp.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
    await fsp.rename(file, `${file}.1`).catch(() => {});
    size = 0;
  }

  function write(level, message, details) {
    const extra = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${extra}`.replace(/\r?\n/g, '\n    ');
    queue = queue.then(async () => {
      if (size === null) {
        await fsp.mkdir(dir, { recursive: true });
        size = (await fsp.stat(file).catch(() => ({ size: 0 }))).size;
      }
      const bytes = Buffer.byteLength(line) + 1;
      if (size > 0 && size + bytes > maxBytes) await rotate();
      await fsp.appendFile(file, `${line}\n`);
      size += bytes;
    }).catch(() => {});
    return queue;
  }

  return {
    file,
    info: (message, details) => write('INFO', message, details),
    warn: (message, details) => write('WARN', message, details),
    error: (message, details) => write('ERROR', message, details),
    flush: () => queue,
  };
}

module.exports = { createLog };
