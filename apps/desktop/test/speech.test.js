// The bar's speech provider (app/speech.js) on Windows: Windows speaks a command into a WAV file, the offline
// recognizer turns it back into text, and it parses as the right intent.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createSpeech } = require('../app/speech');
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
