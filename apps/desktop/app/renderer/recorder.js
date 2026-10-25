// Mewndo's one recorder, used by the dock's mic (bar.js) and a card's mic (cards.js): 16 kHz mono from the default
// microphone, handed over as a 16-bit WAV for app/speech.js. Nothing is kept: the recording exists only until it
// is handed over.
//   const r = MewRecorder();  await r.start({ maxMs, onMax }) -> true | false (no microphone)  ·  r.stop() -> WAV | null
// stop() gives null for a tap shorter than 0.3 s, and when it is called before the microphone was ready.
// What it can't do: it records whatever the microphone hears, and Windows' privacy settings can block it (start
// then says false).
function MewRecorder() {
  const MIN_SECONDS = 0.3;
  let rec = null; // { stream, ctx, chunks, timer } while recording
  let wanted = false; // stop() before getUserMedia answered: the recording is thrown away when it arrives

  function close(r) {
    clearTimeout(r.timer);
    for (const t of r.stream.getTracks()) t.stop();
    r.ctx.close();
  }

  async function start({ maxMs = 30_000, onMax = () => {} } = {}) {
    if (rec || wanted) return true;
    wanted = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination);
      const r = { stream, ctx, chunks, timer: setTimeout(onMax, maxMs) };
      if (!wanted) { close(r); return true; } // let go before the mic was ready
      rec = r;
      return true;
    } catch {
      wanted = false;
      return false;
    }
  }

  function wavOf(chunks, rate) {
    const n = chunks.reduce((a, c) => a + c.length, 0);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    let o = 44;
    for (const c of chunks) for (const x of c) { v.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true); o += 2; }
    return new Uint8Array(buf);
  }

  function stop() {
    wanted = false;
    if (!rec) return null;
    const r = rec;
    rec = null;
    const rate = r.ctx.sampleRate;
    close(r);
    const samples = r.chunks.reduce((a, c) => a + c.length, 0);
    return samples > rate * MIN_SECONDS ? wavOf(r.chunks, rate) : null; // shorter: a tap, not speech
  }

  return { start, stop, active: () => !!rec || wanted };
}
