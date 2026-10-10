// Speech to text for the bar's mic, behind one interface so providers can be swapped:
//   const speech = createSpeech({ log });  speech.available  ·  await speech.transcribe(wavBuffer) -> text
// Providers, in order:
//   1. the cloud: Mewndo's gateway (cloud/gateway, POST /v1/transcribe), Whisper base on Workers AI. Used only when
//      MEWNDO_GATEWAY_URL is set and the device token is in Windows Credential Manager (Mewndo/gateway-device-token,
//      the same one the core uses; never a file). The recording leaves this PC for that one call (the user agreed
//      on 10 Oct 2026); the gateway does not store it. Every call has a deadline.
//   2. Windows' own offline recognizer (System.Speech, part of Windows; free, runs on this PC, nothing leaves it),
//      in one PowerShell process kept warm and fed WAV files. The fallback whenever the cloud says no, fails, or
//      is too slow, and the only provider when no gateway is configured (CLAUDE.md rule 3).
// The bar records 16 kHz mono 16-bit WAV.
// What it can't do: System.Speech dictation is less accurate than modern models and English works best; Whisper
// base is better but needs the network and the day's free budget; other systems have no local provider.
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

const CLOUD_DEADLINE_MS = 9_000; // the gateway gives Whisper 8 s; a little more for the network
const TOKEN_TARGET = 'Mewndo/gateway-device-token';

// The device token from Windows Credential Manager, through koffi (already a dependency; see desk/focus.js). Null
// when it isn't there or anything about reading it fails: then the cloud provider is simply off.
function readDeviceToken({ load = () => require('koffi') } = {}) {
  if (process.platform !== 'win32') return null;
  try {
    const koffi = load();
    const advapi = koffi.load('advapi32.dll');
    const CREDENTIALW = koffi.struct('MEWNDO_CREDENTIALW', {
      Flags: 'uint32', Type: 'uint32', TargetName: 'void *', Comment: 'void *', LastWritten: 'uint64',
      CredentialBlobSize: 'uint32', CredentialBlob: 'void *', Persist: 'uint32', AttributeCount: 'uint32',
      Attributes: 'void *', TargetAlias: 'void *', UserName: 'void *',
    });
    const CredReadW = advapi.func('__stdcall', 'CredReadW', 'bool', ['str16', 'uint32', 'uint32', koffi.out(koffi.pointer('void *'))]);
    const CredFree = advapi.func('__stdcall', 'CredFree', 'void', ['void *']);
    const out = [null];
    if (!CredReadW(TOKEN_TARGET, 1 /* CRED_TYPE_GENERIC */, 0, out) || !out[0]) return null;
    try {
      const cred = koffi.decode(out[0], CREDENTIALW);
      const bytes = koffi.decode(cred.CredentialBlob, 'uint8_t', cred.CredentialBlobSize);
      const token = Buffer.from(bytes).toString('utf8').trim();
      return token || null;
    } finally {
      CredFree(out[0]);
    }
  } catch {
    return null;
  }
}

// The gateway provider. fetch is injected in tests. Throws on anything but a transcript, so the caller falls back.
function cloudProvider({ url, getToken, fetch = globalThis.fetch, deadlineMs = CLOUD_DEADLINE_MS }) {
  return {
    available: true,
    async transcribe(wav) {
      const token = getToken();
      if (!token) throw new Error('no device token');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      try {
        const res = await fetch(`${String(url).replace(/\/+$/, '')}/v1/transcribe`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav', 'x-mewndo-deadline-ms': String(deadlineMs - 1000) },
          body: wav,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`gateway status ${res.status}`);
        const body = await res.json();
        if (body.fallback || typeof body.text !== 'string') throw new Error(`gateway fell back: ${body.reason ?? 'no text'}`);
        return body.text.trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// The cloud, from the environment and Credential Manager, or null.
function cloudFromEnv({ fetch } = {}) {
  const url = process.env.MEWNDO_GATEWAY_URL;
  if (!url) return null;
  let token;
  return cloudProvider({ url, fetch, getToken: () => (token ??= readDeviceToken()) });
}

const NO_LOCAL = { available: false, warm() {}, async transcribe() { throw new Error('Voice commands need Windows for now.'); }, stop() {} };

// cloud and local are injected in tests; by default the cloud comes from the environment and the local provider is
// Windows' recognizer on Windows and nothing elsewhere.
function createSpeech({ log, cloud = cloudFromEnv(), local = process.platform === 'win32' ? windowsProvider({ log }) : NO_LOCAL } = {}) {
  if (!cloud) return local;
  return {
    available: true,
    warm: () => local.warm(),
    async transcribe(wav) {
      try {
        return await cloud.transcribe(wav);
      } catch (e) {
        log?.info?.(`Cloud speech not used (${e.name === 'AbortError' ? 'too slow' : e.message}); using ${local.available ? "Windows' recognizer" : 'nothing'}`);
        return local.transcribe(wav);
      }
    },
    stop: () => local.stop(),
  };
}

module.exports = { createSpeech, cloudProvider, readDeviceToken };
