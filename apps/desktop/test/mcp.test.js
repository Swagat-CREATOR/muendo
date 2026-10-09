// The local MCP server (spec §22.3): `mewndo-core mcp` on stdio, as an agent starts it, calling every tool
// against a running Mewndo engine. Undo is not offered; request_delete only holds, and approved files go to trash.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMewndo } = require('../engine');
const { tempDir, CORE_BINARY } = require('./helpers');

const skip = fs.existsSync(CORE_BINARY) ? false : 'mewndo-core is not built: run `npm test` from the repository root';

// A minimal MCP client over the child's stdio: newline-delimited JSON-RPC.
function mcpClient(cwd, env) {
  const child = spawn(CORE_BINARY, ['mcp', '--agent', 'codex'], { cwd, env: { ...process.env, ...env } });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    return { error: r.result?.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  // Waits for the exit: on Windows the child's working folder can't be removed while it runs.
  const close = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  });
  return { request, notify, call, close };
}

test('every tool works through mewndo-core mcp, and undo is not one of them', { skip, timeout: 60_000 }, async () => {
  const base = tempDir();
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of ['src/app.js', 'old.txt', 'keep.txt']) fs.writeFileSync(path.join(root, f), `content of ${f}`);
  const dataDir = path.join(base, 'data');
  const mewndo = createMewndo({ dataDir, journalOptions: { debounceMs: 50, writeFinishMs: 100 }, hookServer: { port: 0 } });
  await mewndo.start();
  await mewndo.protect(root);
  const real = fs.realpathSync(root);
  await mewndo.saveBrief(real, 'Tidy up the project.');
  const client = mcpClient(real, { MEWNDO_DATA_DIR: dataDir });
  let outside;
  // Cleanup runs here, not in after(): tempDir's after() removes the folders and must find the children gone.
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.strictEqual(init.result.serverInfo.name, 'mewndo');
    client.notify('notifications/initialized');
    const tools = (await client.request('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepStrictEqual(tools, ['append_progress', 'create_save_point', 'get_project_card', 'list_changes', 'mewndo_status', 'request_delete']);

    const sp = await client.call('create_save_point', { label: 'before tidying' });
    assert.ok(sp.json, sp.text);
    assert.match(sp.json.savePoint.id, /\S/);
    const status = await client.call('mewndo_status');
    assert.deepStrictEqual([status.json.protected, status.json.folder, status.json.newestSavePoint.label], [true, real, 'before tidying']);

    fs.writeFileSync(path.join(real, 'new.txt'), 'new');
    await mewndo.journals()[0].sync();
    const changes = await client.call('list_changes', { since: sp.json.savePoint.id });
    assert.deepStrictEqual(changes.json.created, ['new.txt']);

    const del = await client.call('request_delete', { paths: ['old.txt'], reason: 'unused' });
    assert.strictEqual(del.json.status, 'pending_approval');
    assert.ok(fs.existsSync(path.join(real, 'old.txt')), 'nothing deleted before the user approves');
    assert.deepStrictEqual((await client.call('mewndo_status')).json.pendingHolds.map((h) => [h.what, h.agent]), [['Delete old.txt', 'Codex']]);
    const done = await mewndo.approveHold(del.json.hold);
    assert.deepStrictEqual(done.trashed, ['old.txt']);
    assert.ok(!fs.existsSync(path.join(real, 'old.txt')));
    assert.strictEqual(fs.readFileSync(path.join(done.trashFolder, 'old.txt'), 'utf8'), 'content of old.txt', 'in Mewndo\'s trash');
    assert.ok((await client.call('request_delete', { paths: ['../outside.txt'], reason: 'x' })).error, 'outside the folder: refused');

    const note = await client.call('append_progress', { note: 'Removed the unused file' });
    assert.strictEqual(note.json.stored, true);
    const card = await client.call('get_project_card');
    assert.match(card.json.card, /Tidy up the project/);
    assert.match(card.json.card, /Removed the unused file/);

    outside = mcpClient(base, { MEWNDO_DATA_DIR: dataDir });
    await outside.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    outside.notify('notifications/initialized');
    assert.strictEqual((await outside.call('mewndo_status')).json.protected, false);
    assert.ok((await outside.call('create_save_point', {})).error);
  } finally {
    await outside?.close();
    await client.close();
    await mewndo.stop();
  }
});

test('with Mewndo not running, tools say so instead of failing silently', { skip, timeout: 30_000 }, async () => {
  const client = mcpClient(tempDir(), { MEWNDO_DATA_DIR: path.join(tempDir(), 'nothing') });
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    client.notify('notifications/initialized');
    const r = await client.call('mewndo_status');
    assert.ok(r.error);
    assert.match(r.text, /Mewndo isn't running/);
  } finally { await client.close(); }
});
