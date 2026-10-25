// Makes the soft sound a card can play when it arrives (Settings > Notifications): two sine tones a fifth apart
// (E5 then B5), each with a quick fade in and a long gentle fade out, 0.45 s, 22 050 Hz mono 16-bit WAV. Nothing is
// downloaded; the same code always writes the same bytes, and the test checks the committed file matches.
//   node scripts/make-sound.js
const fs = require('node:fs');
const path = require('node:path');

const RATE = 22_050;
const SECONDS = 0.45;
const PEAK = 0.32; // soft: about a third of full scale, before the user's volume

function samples() {
  const n = Math.round(RATE * SECONDS);
  const out = new Int16Array(n);
  const tone = (t, freq, start) => {
    if (t < start) return 0;
    const u = t - start;
    const attack = Math.min(1, u / 0.012); // no click at the start
    return Math.sin(2 * Math.PI * freq * u) * attack * Math.exp(-u * 7);
  };
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const tail = Math.min(1, (SECONDS - t) / 0.04); // and none at the end
    const v = (0.6 * tone(t, 659.25, 0) + 0.5 * tone(t, 987.77, 0.09)) * PEAK * tail;
    out[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  return out;
}

function wav() {
  const data = Buffer.from(samples().buffer);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16); // PCM chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // bytes per frame
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const OUT = path.join(__dirname, '..', 'app', 'assets', 'sounds', 'card.wav');

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, wav());
  console.log(`Wrote ${OUT}`);
}

module.exports = { wav, OUT, RATE, SECONDS };
