// Speech to text for the bar's mic, behind one interface so providers can be swapped:
//   const speech = createSpeech({ log });  speech.available  ·  await speech.transcribe(wavBuffer) -> text
// Provider today: Windows' own offline recognizer (System.Speech, part of Windows; free, runs on this PC, nothing
// leaves it), in one PowerShell process kept warm and fed WAV files. The bar records 16 kHz mono 16-bit WAV.
// What it can't do: System.Speech dictation is less accurate than modern models, English works best, and other
// systems have no provider yet (the mic says so). A better local model (whisper.cpp) can be another provider.
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($file = [Console]::In.ReadLine())) {
  try {
    $r.SetInputToWaveFile($file)
    $parts = @()
    # At the end of the file Recognize() returns null, or throws once the input has been let go: both mean done.
    while ($true) { try { $res = $r.Recognize() } catch { break }; if ($null -eq $res) { break }; $parts += $res.Text }
    try { $r.SetInputToNull() } catch {}
    [Console]::Out.WriteLine((@{ text = ($parts -join ' ') } | ConvertTo-Json -Compress))
  } catch {
    try { $r.SetInputToNull() } catch {}
    [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

const DEADLINE_MS = 15_000; // a few seconds of speech takes well under this

function windowsProvider({ log }) {
  let child = null;
  let buffer = '';
  const waiting = []; // resolvers, in order
  function ensure() {
    if (child) return child;
    // The script goes in as -EncodedCommand, so stdin carries only the WAV paths.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg.ready) waiting.shift()?.(msg);
      }
    });
    child.on('exit', () => {
      child = null;
      for (const w of waiting.splice(0)) w({ error: 'The speech recognizer stopped.' });
    });
    child.on('error', (e) => log.warn(`Speech recognizer failed to start: ${e.message}`));
    return child;
  }
  return {
    available: true,
    warm: () => ensure(),
    async transcribe(wav) {
      const file = path.join(os.tmpdir(), `mewndo-voice-${process.pid}-${Date.now()}.wav`);
      await fsp.writeFile(file, wav);
      try {
        const p = ensure();
        const answer = await Promise.race([
          new Promise((resolve) => { waiting.push(resolve); p.stdin.write(`${file}\n`); }),
          new Promise((resolve) => setTimeout(() => { child?.kill(); resolve({ error: 'Speech recognition took too long.' }); }, DEADLINE_MS)),
        ]);
        if (answer.error) throw new Error(answer.error);
        return String(answer.text ?? '').trim();
      } finally {
        await fsp.rm(file, { force: true, maxRetries: 5 }).catch(() => {}); // our own temporary recording, never a user file
      }
    },
    stop: () => child?.kill(),
  };
}

function createSpeech({ log }) {
  if (process.platform === 'win32') return windowsProvider({ log });
  return { available: false, warm() {}, async transcribe() { throw new Error('Voice commands need Windows for now.'); }, stop() {} };
}

module.exports = { createSpeech };
