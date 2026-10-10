// Draws Mewndo's app and tray icons from the cat (design spec §4.3) and writes them as PNG and ICO. Run with Electron:
//   electron scripts/make-icons.js
// App icon: the face in ink on a milk squircle (radius 22 %), a mint dot at the lower right; the small face at 16 and
// 24 px. Tray: the face alone, milk for a dark taskbar and ink for a light one, with an optional state dot.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const CAT = path.join(ROOT, 'app', 'assets', 'cat');
const OUT = path.join(ROOT, 'app', 'assets', 'icon');
const svg = (name, colour) => fs.readFileSync(path.join(CAT, name), 'utf8').replaceAll('currentColor', colour);
const dataUrl = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString('base64')}`;

const INK = '#15171A';
const MILK = '#EEF1EC';
const DOTS = { protected: '#34D6B6', needs: '#F2B04A', stopped: '#F27A70' };

// One PNG per job, drawn on a canvas in a hidden window. Data URLs keep the canvas untainted.
const PAGE = `(${async (jobs) => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  const out = {};
  for (const j of jobs) {
    const c = document.createElement('canvas');
    c.width = c.height = j.size;
    const g = c.getContext('2d');
    const s = j.size;
    if (j.kind === 'app') {
      const r = s * 0.22;
      g.fillStyle = j.milk;
      g.beginPath(); g.roundRect(0, 0, s, s, r); g.fill();
      const pad = s * (s <= 24 ? 0.12 : 0.14);
      g.drawImage(await load(j.face), pad, pad, s - 2 * pad, s - 2 * pad);
      const d = Math.max(3, s * 0.2);
      g.fillStyle = j.dot;
      g.beginPath(); g.arc(s - d * 0.75, s - d * 0.75, d / 2, 0, Math.PI * 2); g.fill();
      g.lineWidth = Math.max(1, s * 0.03); g.strokeStyle = j.milk; g.stroke();
    } else {
      g.drawImage(await load(j.face), 0, 0, s, s);
      if (j.dot) {
        const d = s * 0.42;
        g.globalCompositeOperation = 'destination-out'; // a clear ring around the dot, so it reads on any taskbar
        g.beginPath(); g.arc(s - d / 2, s - d / 2, d / 2 + s * 0.08, 0, Math.PI * 2); g.fill();
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = j.dot;
        g.beginPath(); g.arc(s - d / 2, s - d / 2, d / 2, 0, Math.PI * 2); g.fill();
      }
    }
    out[j.name] = c.toDataURL('image/png').split(',')[1];
  }
  return out;
}})`;

// A Windows .ico holding PNG layers (Vista and later read PNG layers at every size).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const jobs = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const face = dataUrl(svg(size <= 24 ? 'cat-face-small.svg' : 'cat-face.svg', INK));
    jobs.push({ kind: 'app', name: `app-${size}`, size, face, milk: MILK, dot: DOTS.protected });
  }
  for (const [theme, colour] of [['dark', MILK], ['light', INK]]) {
    for (const [scale, size] of [['', 16], ['@2x', 32]]) {
      const face = dataUrl(svg(size <= 24 ? 'cat-face-small.svg' : 'cat-face.svg', colour));
      for (const state of ['idle', 'protected', 'needs', 'stopped']) {
        jobs.push({ kind: 'tray', name: `tray-${theme}-${state}${scale}`, size, face, dot: DOTS[state] ?? null });
      }
    }
  }
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
  const pngs = await win.webContents.executeJavaScript(`${PAGE}(${JSON.stringify(jobs)})`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, b64] of Object.entries(pngs)) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'));
  const layers = [16, 24, 32, 48, 64, 256].map((size) => ({ size, data: Buffer.from(pngs[`app-${size}`], 'base64') }));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico(layers));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), Buffer.from(pngs['app-256'], 'base64'));
  console.log(`wrote ${Object.keys(pngs).length} PNGs, build/icon.ico and build/icon.png`);
  app.quit();
});
