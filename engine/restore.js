// Restore: make a protected folder, or selected paths in it, match a save point exactly. Or rebuild a save
// point in a separate empty folder. Every step is logged before it runs and every step is safe to run twice,
// so an interrupted restore is finished by running its whole log again.
//
// Order: trash new things -> remove new empty folders -> create folders -> write files and links.
// Nothing is deleted: anything new or about to be replaced is moved into
// <folder data>/trash/Restored/<restore start time>_<restore id>/<its relative path>.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { scan } = require('./scanner');
const { hashFile, writeFileAtomic, isInside, TEMP_SUFFIX } = require('./store');

const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRIES = 4;
const OWN_TEMP = new RegExp(`\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${TEMP_SUFFIX.replace('.', '\\.')}$`);
const COUNT = { trash: 'trashed', rmdir: 'foldersRemoved', mkdir: 'foldersCreated', write: 'written', link: 'linked' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const depth = (p) => p.split('/').length;
const toAbs = (base, rel) => path.join(base, ...rel.split('/'));
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const lstatOrNull = (p) => fsp.lstat(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Link targets compare as resolved paths: Windows may report a junction's target differently than it was set.
function sameTarget(a, b, linkAbs) {
  const norm = (t) => path.resolve(path.dirname(linkAbs), t.replace(/^\\\\\?\\/, ''));
  return a === b || samePath(norm(a), norm(b));
}

// Selected paths are relative, '/'-separated, inside the folder. A folder selects everything under it.
function selector(paths) {
  if (!paths) return () => true;
  const clean = paths.map((p) => {
    const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').includes('..')) throw new Error(`invalid path: ${p}`);
    return s;
  });
  return (p) => clean.some((s) => p === s || p.startsWith(`${s}/`));
}

// Compare the save point's index (target) with the folder's current index and list the work.
function buildPlan(target, current, paths) {
  const sel = selector(paths);
  const ancestors = new Set(); // folders that must exist for selected items, even if not selected themselves
  for (const p of Object.keys(target)) {
    if (sel(p)) for (let a = path.posix.dirname(p); a !== '.'; a = path.posix.dirname(a)) ancestors.add(a);
  }
  const plan = { write: [], links: [], mkdirs: [], trash: [], rmdirs: [], overwrites: [], unrestorable: [] };

  for (const [p, have] of Object.entries(current)) {
    if (!sel(p)) continue;
    const want = target[p];
    if (have.type === 'directory') { if (want?.type !== 'directory') plan.rmdirs.push(p); }
    else if (!want || want.type === 'directory') plan.trash.push(p);
  }
  for (const [p, want] of Object.entries(target)) {
    if (!sel(p) && !(want.type === 'directory' && ancestors.has(p))) continue;
    const have = current[p];
    if (want.type === 'directory') {
      if (have?.type !== 'directory') plan.mkdirs.push(p);
      continue;
    }
    const restorable = want.type === 'file' ? !!want.hash : want.type === 'link' && want.target !== undefined;
    if (!restorable) {
      plan.unrestorable.push({ path: p, reason: want.skipped ?? want.error ?? 'not stored' });
      continue;
    }
    const same = have?.type === want.type && (want.type === 'file' ? have.hash === want.hash : have.target === want.target);
    if (same) continue;
    (want.type === 'file' ? plan.write : plan.links).push(p);
    if (have && have.type !== 'directory') plan.overwrites.push(p); // edited after the save point
  }

  for (const k of ['write', 'links', 'trash', 'overwrites']) plan[k].sort();
  plan.rmdirs.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b)); // deepest first
  plan.mkdirs.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)); // shallowest first
  return plan;
}

function stepsFor(plan, target) {
  return [
    ...plan.trash.map((p) => ({ op: 'trash', path: p })),
    ...plan.rmdirs.map((p) => ({ op: 'rmdir', path: p })),
    ...plan.mkdirs.map((p) => ({ op: 'mkdir', path: p })),
    ...plan.write.map((p) => ({ op: 'write', path: p, hash: target[p].hash, size: target[p].size, mtimeMs: target[p].mtimeMs })),
    ...plan.links.map((p) => ({ op: 'link', path: p, target: target[p].target })),
  ];
}

// Refuse to work through a link: the parent folder's real path must be exactly where we expect it.
// ponytail: a link swapped in between this check and the write can't be fully blocked from Node.
async function checkParent(abs) {
  const parent = path.dirname(abs);
  if (!samePath(await fsp.realpath(parent), parent)) throw new Error('a link or junction is in the way');
}

async function moveToTrash(abs, rel, trashRoot) {
  const st = await lstatOrNull(abs);
  if (!st) return false; // already gone (or already moved before a crash)
  if (st.isDirectory()) throw new Error('a folder is in the way');
  await checkParent(abs);
  let dest = toAbs(trashRoot, rel);
  for (let i = 1; await lstatOrNull(dest); i++) dest = `${toAbs(trashRoot, rel)}.${i}`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(abs, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // trash is on another drive: copy, check, then remove the original
    if (st.isSymbolicLink()) {
      await writeFileAtomic(`${dest}.link.json`, JSON.stringify({ target: await fsp.readlink(abs) }));
    } else {
      await fsp.copyFile(abs, dest, fs.constants.COPYFILE_EXCL);
      if ((await hashFile(dest)) !== (await hashFile(abs))) throw new Error('copy to trash did not match');
    }
    await fsp.unlink(abs);
  }
  return true;
}

async function linkType(target, at) {
  if (process.platform !== 'win32') return undefined;
  const st = await fsp.stat(path.resolve(path.dirname(at), target)).catch(() => null);
  return st?.isDirectory() ? 'junction' : 'file';
}

const OPS = {
  trash: (step, abs, ctx) => moveToTrash(abs, step.path, ctx.trashRoot),

  async rmdir(step, abs) {
    if (!(await lstatOrNull(abs))?.isDirectory()) return false;
    try { await fsp.rmdir(abs); return true; } catch (e) {
      if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') return false; // still holds ignored or failed items
      throw e;
    }
  },

  async mkdir(step, abs) {
    const st = await lstatOrNull(abs);
    if (st?.isDirectory()) return false;
    if (st) throw new Error('something is in the way');
    await checkParent(abs);
    await fsp.mkdir(abs);
    return true;
  },

  async write(step, abs, ctx) {
    const st = await lstatOrNull(abs);
    if (st?.isFile() && st.size === step.size && (await hashFile(abs)) === step.hash) return false;
    if (st?.isDirectory()) throw new Error('a folder is in the way');
    await checkParent(abs);
    const tmp = await ctx.store.extract(step.hash, abs);
    try {
      await fsp.utimes(tmp, step.mtimeMs / 1000, step.mtimeMs / 1000);
      if (st) await moveToTrash(abs, step.path, ctx.trashRoot);
      await fsp.rename(tmp, abs);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return true;
  },

  async link(step, abs, ctx) {
    const st = await lstatOrNull(abs);
    if (st?.isSymbolicLink() && sameTarget(await fsp.readlink(abs), step.target, abs)) return false;
    if (st?.isDirectory()) throw new Error('a folder is in the way');
    await checkParent(abs);
    const tmp = `${abs}.${crypto.randomUUID()}${TEMP_SUFFIX}`;
    const type = await linkType(step.target, abs); // Windows: folder links become junctions
    await fsp.symlink(type === 'junction' ? path.resolve(path.dirname(abs), step.target) : step.target, tmp, type);
    try {
      if (st) await moveToTrash(abs, step.path, ctx.trashRoot);
      await fsp.rename(tmp, abs);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return true;
  },
};

// Locked files (antivirus, an open editor) usually free up quickly on Windows.
async function retry(fn, delayMs, onRetry) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= RETRIES || !LOCKED.has(e.code)) throw e;
      onRetry(e);
      await sleep(delayMs * 2 ** i);
    }
  }
}

// Run fn over items, `size` at a time. After the first throw, starts nothing new, waits, then rethrows.
async function pool(items, size, fn) {
  let next = 0;
  let error = null;
  const worker = async () => {
    while (!error && next < items.length) {
      try { await fn(items[next++]); } catch (e) { error = e; }
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  if (error) throw error;
}

// Paths in the folder that differ from the save point. Unrestorable entries are left out.
function verify(target, now, paths, base) {
  const sel = selector(paths);
  const mismatches = [];
  for (const [p, want] of Object.entries(target)) {
    if (!sel(p)) continue;
    const have = now[p];
    const ok = want.type === 'directory' ? have?.type === 'directory'
      : want.type === 'file' ? !want.hash || (have?.type === 'file' && have.hash === want.hash)
        : want.type === 'link' ? want.target === undefined
          || (have?.type === 'link' && sameTarget(have.target, want.target, toAbs(base, p)))
          : true;
    if (!ok) mismatches.push(p);
  }
  for (const p of Object.keys(now)) if (sel(p) && !target[p]) mismatches.push(p);
  return mismatches.sort();
}

// Leftover temp files from a crash mid-write, next to the files being restored. Only Mewndo's own names.
async function removeOwnTemps(log) {
  const dirs = new Set(log.steps.filter((s) => s.op === 'write' || s.op === 'link')
    .map((s) => path.dirname(toAbs(log.base, s.path))));
  for (const dir of dirs) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (OWN_TEMP.test(name)) await fsp.rm(path.join(dir, name), { force: true });
    }
  }
}

const logFile = (journal, id) => path.join(journal.folderDir, 'restores', `${id}.json`);
const running = new WeakSet(); // journals with a restore in progress

async function run(journal, log, { resuming = false, retryDelayMs = 100, crashAfterSteps = Infinity } = {}) {
  const ctx = { store: journal.store, trashRoot: log.trashRoot };
  const counts = { written: 0, linked: 0, trashed: 0, foldersCreated: 0, foldersRemoved: 0 };
  const failures = [];
  const retried = []; // steps that succeeded after waiting for a lock
  if (log.inPlace) await journal.setRestoring(true);
  try {
    if (resuming) await removeOwnTemps(log);
    let done = 0;
    const runStep = async (i) => {
      if (i >= crashAfterSteps) throw new Error('simulated crash'); // tests only
      const step = log.steps[i];
      let attempts = 1;
      const onRetry = (e) => {
        attempts++;
        journal.emit('retry', { path: step.path, op: step.op, attempt: attempts, error: e.code });
      };
      try {
        const did = await retry(() => OPS[step.op](step, toAbs(log.base, step.path), ctx), retryDelayMs, onRetry);
        if (did) counts[COUNT[step.op]]++;
        if (attempts > 1) retried.push({ path: step.path, op: step.op, attempts });
      } catch (e) {
        const error = e.code ?? e.message;
        failures.push({
          path: step.path, op: step.op, error, attempts,
          message: `Could not ${step.op} ${step.path} after ${attempts} attempt${attempts > 1 ? 's' : ''}: ${error}`,
        });
      }
      journal.emit('progress', { phase: 'restoring', done: ++done, total: log.steps.length });
    };
    // Steps run phase by phase (same op = one phase). Folder steps run one at a time, deepest/shallowest
    // first; files, links and trash moves touch distinct paths, so several run at once to overlap disk flushes.
    const phases = [];
    for (const [i, step] of log.steps.entries()) {
      if (phases.at(-1)?.op === step.op) phases.at(-1).items.push(i);
      else phases.push({ op: step.op, items: [i] });
    }
    for (const { op, items } of phases) await pool(items, op === 'rmdir' || op === 'mkdir' ? 1 : 4, runStep);

    // Fresh scan with full rehash: verify what is really on disk, not what the index assumes.
    const { index: target } = await journal.getSavePoint(log.savePointId);
    const now = await scan(log.base, {
      ...journal.scanOptions,
      onProgress: (p) => journal.emit('progress', { ...p, phase: `verifying (${p.phase})` }),
    });
    const mismatches = verify(target, now, log.paths, log.base);
    const result = {
      id: log.id, savePointId: log.savePointId, beforeUndoId: log.beforeUndoId, folder: log.base,
      trashFolder: log.trashRoot, resumed: resuming, counts, failures, retried, mismatches, verified: mismatches.length === 0,
    };
    await writeFileAtomic(logFile(journal, log.id), JSON.stringify({ ...log, status: 'done', finishedAt: new Date().toISOString(), result }));
    journal.emit('restored', result);
    return result;
  } finally {
    if (log.inPlace) await journal.setRestoring(false);
  }
}

async function savePointOrThrow(journal, id) {
  const sp = await journal.getSavePoint(id);
  if (!sp) throw new Error(`no such save point: ${id}`);
  return sp;
}

// A separate restore target: created if missing, must be empty and outside the protected folder.
async function prepareInto(journal, into) {
  const abs = path.resolve(into);
  await fsp.mkdir(abs, { recursive: true });
  const real = await fsp.realpath(abs);
  if (samePath(real, journal.root) || isInside(real, journal.root) || isInside(journal.root, real)) {
    throw new Error('restore folder must be outside the protected folder');
  }
  if ((await fsp.readdir(real)).length) throw new Error('restore folder must be new or empty');
  return real;
}

// What a restore would do, without doing it. `overwrites` lists files edited since the save point.
async function planRestore(journal, savePointId, { paths, into } = {}) {
  selector(paths);
  const { index: target } = await savePointOrThrow(journal, savePointId);
  const current = into ? {} : await journal.sync();
  return { savePointId, into: into ?? null, paths: paths ?? null, ...buildPlan(target, current, paths) };
}

async function restore(journal, savePointId, { paths, into, retryDelayMs, crashAfterSteps } = {}) {
  selector(paths);
  if (running.has(journal)) throw new Error('a restore is already running for this folder');
  running.add(journal);
  try {
    const sp = await savePointOrThrow(journal, savePointId);
    let base;
    let current;
    let beforeUndoId = null;
    if (into) {
      base = await prepareInto(journal, into);
      current = {};
    } else {
      // Going back to a before-undo save point undoes a restore. A fixed label there keeps labels from
      // nesting ("Before restoring "Before restoring ..."") when undos are undone.
      const label = sp.trigger === 'before-undo' ? 'Before undoing a restore'
        : `Before restoring ${sp.label ? `"${sp.label}"` : `the save point from ${sp.createdAt}`}`;
      beforeUndoId = (await journal.createSavePoint({ trigger: 'before-undo', label })).id;
      current = (await journal.getSavePoint(beforeUndoId)).index;
      base = journal.root;
    }
    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const log = {
      id, status: 'running', startedAt, savePointId, beforeUndoId,
      base, inPlace: !into, paths: paths ?? null,
      // The name starts with when it was trashed: moved files keep their own modified times.
      trashRoot: path.join(journal.folderDir, 'trash', 'Restored', `${startedAt.replace(/:/g, '-')}_${id}`),
      steps: stepsFor(buildPlan(sp.index, current, paths), sp.index),
    };
    await writeFileAtomic(logFile(journal, id), JSON.stringify(log)); // the whole plan, before any step runs
    return await run(journal, log, { retryDelayMs, crashAfterSteps });
  } finally {
    running.delete(journal);
  }
}

// At startup: finish any restore that was interrupted (crash, power loss).
async function resumeRestores(journal) {
  const dir = path.join(journal.folderDir, 'restores');
  const results = [];
  for (const name of (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()) {
    const log = await readJson(path.join(dir, name));
    if (log?.status !== 'running') continue;
    running.add(journal);
    try { results.push(await run(journal, log, { resuming: true })); } finally { running.delete(journal); }
  }
  return results;
}

const isRestoreRunning = (journal) => running.has(journal);

// Past and unfinished restores, newest first, without their step lists.
async function listRestores(journal) {
  const dir = path.join(journal.folderDir, 'restores');
  const list = [];
  for (const name of (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
    const { steps, ...log } = await readJson(path.join(dir, name));
    list.push({ ...log, stepCount: steps.length });
  }
  return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

module.exports = { planRestore, restore, resumeRestores, buildPlan, isRestoreRunning, listRestores };
