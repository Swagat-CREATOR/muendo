// POST /v1/transcribe: speech to text through the gateway (Whisper on Workers AI), driven through the Worker's own
// fetch handler with a fake AI binding and a canned WAV. It checks what the PC gets back, including every path
// where it must fall back to its own offline recognizer.
import { test } from 'node:test'
import assert from 'node:assert'
import worker from '../src/index.js'
import { fakeEnv, fakeCtx, ADMIN_SECRET } from './fake-do.js'
import * as g from '../src/gateway.js'

// A canned recording: 16 kHz mono 16-bit PCM (what the bar records), `seconds` long, a quiet tone.
function wav(seconds = 1.5) {
  const rate = 16000
  const samples = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + samples * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(800 * Math.sin(i / 8)), 44 + i * 2)
  return b
}

async function call(env, ctx, method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (body !== undefined) {
    init.body = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)
    if (!Buffer.isBuffer(body)) init.headers['content-type'] = 'application/json'
  }
  const res = await worker.fetch(new Request(`https://mewndo-cloud.test${path}`, init), env, ctx)
  return { status: res.status, body: await res.json() }
}

async function token(env, ctx) {
  const mint = await call(env, ctx, 'POST', '/admin/invites', { headers: { 'x-admin-secret': ADMIN_SECRET }, body: { count: 1 } })
  const redeemed = await call(env, ctx, 'POST', '/invite/redeem', { body: { code: mint.body.codes[0], name: 'Asha' } })
  return redeemed.body.token
}

const transcribe = (env, ctx, tok, audio, headers = {}) => call(env, ctx, 'POST', '/v1/transcribe', {
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'audio/wav', ...headers }, body: audio,
})

test('a WAV becomes text, with Whisper base given the bytes as Cloudflare documents them', async () => {
  const env = fakeEnv({ ai: () => ({ text: '  Stop Codex. ', word_count: 2 }) })
  const ctx = fakeCtx()
  const tok = await token(env, ctx)
  const audio = wav(1.5)
  const { status, body } = await transcribe(env, ctx, tok, audio)
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.text, 'Stop Codex.')
  assert.equal(body.backend, 'workers_ai')
  assert.equal(body.rules_only, false)
  assert.equal(env.calls.length, 1)
  assert.equal(env.calls[0].model, '@cf/openai/whisper')
  assert.equal(env.calls[0].input.audio.length, audio.length)
  assert.deepEqual(env.calls[0].input.audio.slice(0, 4), [...Buffer.from('RIFF')])
})

test('no token, not a WAV, or too long is refused before any model call', async () => {
  const env = fakeEnv({ ai: () => ({ text: 'x' }) })
  const ctx = fakeCtx()
  const tok = await token(env, ctx)
  assert.equal((await call(env, ctx, 'POST', '/v1/transcribe', { body: wav() })).status, 401)
  assert.equal((await transcribe(env, ctx, 'nope', wav())).status, 401)
  const notWav = await transcribe(env, ctx, tok, Buffer.from('ID3 this is an mp3, honestly'))
  assert.equal(notWav.status, 400)
  assert.match(notWav.body.error, /WAV/)
  assert.equal((await transcribe(env, ctx, tok, wav(31))).status, 413)
  assert.equal(env.calls.length, 0)
})

test('a model error or a missed deadline is a fallback to the offline recognizer, never an error', async () => {
  const ctx = fakeCtx()
  const broken = fakeEnv({ ai: () => { throw new Error('boom') } })
  const t1 = await token(broken, ctx)
  const failed = (await transcribe(broken, ctx, t1, wav())).body
  assert.deepEqual({ ...failed, ms: 0 }, { fallback: true, reason: 'workers_ai_error', ms: 0, rules_only: false })
  const slow = fakeEnv({ ai: () => new Promise((r) => setTimeout(() => r({ text: 'late' }), 200)) })
  const t2 = await token(slow, ctx)
  const late = await transcribe(slow, ctx, t2, wav(), { 'x-mewndo-deadline-ms': '20' })
  assert.equal(late.body.fallback, true)
  assert.equal(late.body.reason, 'workers_ai_error')
  const shape = fakeEnv({ ai: () => ({ response: 'not whisper' }) })
  const t3 = await token(shape, ctx)
  assert.equal((await transcribe(shape, ctx, t3, wav())).body.fallback, true)
})

test('transcribe sits below Guard in the day budget and falls back to the PC when it runs low', () => {
  const settings = g.DEFAULT_SETTINGS
  const low = { total: settings.total_cap * 0.85, code: 0, device: 0 }
  const plan = (kind) => g.plan({ kind, now: 0, usage: low, estNeurons: 2, settings })
  assert.equal(plan('transcribe').route, 'fallback')
  assert.equal(plan('transcribe').reason, 'budget_low_offline')
  assert.equal(plan('guard').route, 'workers_ai', 'Guard keeps the model')
  assert.equal(g.plan({ kind: 'transcribe', now: 0, usage: { total: 0 }, estNeurons: 2, settings }).deadlineMs, 8000)
})

test('the cost of a recording follows its length at 41.14 neurons a minute', () => {
  assert.equal(g.NEURONS_PER_AUDIO_MINUTE, 41.14)
  assert.equal(g.wavSeconds(wav(1.5)), 1.5)
  assert.equal(g.estimateAudioNeurons(1.5), 2)
  assert.equal(g.estimateAudioNeurons(30), 21)
  assert.equal(g.estimateAudioNeurons(0), 1)
  assert.throws(() => g.wavSeconds(Buffer.from('nope')), (e) => e.status === 400 && /WAV/.test(e.message))
})
