// The bar's speech provider (app/speech.js) on Windows: Windows speaks a command into a WAV file, the offline
// recognizer turns it back into text, and it parses as the right intent.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createSpeech, cloudProvider } = require('../app/speech');
const { parseIntent } = require('../engine/voice');
const { tempDir } = require('./helpers');

test('Windows speech: a spoken "stop codex" becomes the stop intent', { skip: process.platform !== 'win32' && 'Windows only', timeout: 60_000 }, async () => {
  const wav = path.join(tempDir(), 'said.wav');
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer;
    $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
    $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('Stop Codex.'); $s.Dispose()`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps]);
  const speech = createSpeech({ log: { warn() {} } });
  try {
    const text = await speech.transcribe(fs.readFileSync(wav));
    const intent = parseIntent(text, { agents: ['Claude Code', 'Codex', 'Cursor'] });
    assert.deepStrictEqual([intent.intent, intent.agent], ['stop', 'Codex'], `heard "${text}"`);
  } finally { speech.stop(); }
});

// The cloud provider against a fake gateway: canned audio in, the gateway's answer out, and every way it can fail
// ending at the local recognizer (CLAUDE.md rule 3).
const CANNED = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40), Buffer.alloc(3200)]);

function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return reply(init);
  };
  return { fetch, calls };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeLocal() {
  return { available: true, heard: 0, warm() {}, stop() {}, async transcribe() { this.heard++; return 'from windows'; } };
}

test('cloud speech: the WAV goes to the gateway with the device token and a deadline, and its text comes back', async () => {
  const { fetch, calls } = fakeFetch(() => json(200, { text: ' stop codex ', backend: 'workers_ai' }));
  const local = fakeLocal();
  const speech = createSpeech({ cloud: cloudProvider({ url: 'https://gw.test/', getToken: () => 'tok', fetch }), local });
  assert.strictEqual(await speech.transcribe(CANNED), 'stop codex');
  assert.strictEqual(calls[0].url, 'https://gw.test/v1/transcribe');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer tok');
  assert.strictEqual(calls[0].init.headers['content-type'], 'audio/wav');
  assert.ok(Number(calls[0].init.headers['x-mewndo-deadline-ms']) > 0);
  assert.strictEqual(calls[0].init.body, CANNED);
  assert.ok(calls[0].init.signal, 'every call can be cut off at its deadline');
  assert.strictEqual(local.heard, 0);
});

test('cloud speech: a fallback, an error status, a network failure, no token or a timeout all use the local recognizer', async () => {
  const replies = [
    () => json(200, { fallback: true, reason: 'budget_low_offline' }),
    () => json(401, { error: 'unauthorized' }),
    () => { throw new Error('getaddrinfo ENOTFOUND'); },
    () => json(200, { answers: {} }),
  ];
  for (const reply of replies) {
    const local = fakeLocal();
    const { fetch } = fakeFetch(reply);
    const speech = createSpeech({ cloud: cloudProvider({ url: 'https://gw.test', getToken: () => 'tok', fetch }), local, log: {} });
    assert.strictEqual(await speech.transcribe(CANNED), 'from windows');
    assert.strictEqual(local.heard, 1);
  }
  const noToken = createSpeech({ cloud: cloudProvider({ url: 'https://gw.test', getToken: () => null, fetch: () => assert.fail('no call without a token') }), local: fakeLocal() });
  assert.strictEqual(await noToken.transcribe(CANNED), 'from windows');

  const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const slow = createSpeech({ cloud: cloudProvider({ url: 'https://gw.test', getToken: () => 'tok', fetch: hanging, deadlineMs: 30 }), local: fakeLocal() });
  assert.strictEqual(await slow.transcribe(CANNED), 'from windows');
});

test('no gateway configured: speech is exactly the local provider', () => {
  const local = fakeLocal();
  assert.strictEqual(createSpeech({ cloud: null, local }), local);
});

