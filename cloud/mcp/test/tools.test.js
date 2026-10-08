import { test } from 'node:test'
import assert from 'node:assert'
import { TOOLS, toolScopes, ALL_SCOPES } from '../src/tools.js'

test('undo is never exposed to cloud agents', () => {
  assert.equal(TOOLS.find((t) => t.name === 'undo'), undefined)
  assert.equal(toolScopes.undo, undefined)
})

test('every tool has a scope and every scope is known', () => {
  for (const t of TOOLS) {
    assert.ok(toolScopes[t.name], `${t.name} has no scope`)
    assert.ok(ALL_SCOPES.includes(toolScopes[t.name]), `${t.name} has an unknown scope`)
  }
  // No scope entry without a tool.
  for (const name of Object.keys(toolScopes)) {
    assert.ok(TOOLS.some((t) => t.name === name), `${name} has a scope but no tool`)
  }
})

test('held tools need the hold scope; read tools do not', () => {
  assert.equal(toolScopes.send_email, 'mewndo.hold')
  assert.equal(toolScopes.request_delete, 'mewndo.hold')
  assert.equal(toolScopes.mewndo_status, 'mewndo.read')
  assert.equal(toolScopes.list_changes, 'mewndo.read')
  // A read-only client sees only read tools.
  const readOnly = TOOLS.filter((t) => ['mewndo.read'].includes(toolScopes[t.name])).map((t) => t.name)
  assert.ok(!readOnly.includes('send_email'))
  assert.ok(!readOnly.includes('request_delete'))
  assert.ok(!readOnly.includes('create_save_point'))
})

test('every tool declares an object input schema', () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, 'object', `${t.name}`)
    assert.ok(t.description.length > 20, `${t.name} needs a real description`)
  }
})

test('the held tools say plainly that nothing happened yet', () => {
  for (const name of ['send_email', 'request_delete']) {
    const t = TOOLS.find((x) => x.name === name)
    assert.match(t.description, /approv|held|pending/i, `${name}: ${t.description}`)
  }
})
