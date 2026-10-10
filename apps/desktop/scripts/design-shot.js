// Screenshots for the design QA checklist (design spec §0 step 5, §16): renders a page at a given scale and
// theme and saves a PNG. Run with Electron, not node:
//   electron scripts/design-shot.js <page.html> <out.png> [scale=1] [theme=light|dark] [width=1180] [height=760]
// The scale is a device scale factor, the same thing Windows' 150 % display scaling gives a window.
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const [page, out, scale = '1', theme = 'light', width = '1180', height = '760'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
app.commandLine.appendSwitch('force-device-scale-factor', String(scale));
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.disableHardwareAcceleration(); // capturePage fails on WSLg's GPU path; a screenshot tool doesn't need the GPU

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: Number(width), height: Number(height), paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error(`page: ${message}`); });
  await win.loadFile(path.resolve(page));
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))');
  const height2 = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
  win.setContentSize(Number(width), Math.min(Math.max(Number(height), height2), 4000));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  console.log(`${out}: ${image.getSize().width}x${image.getSize().height}`);
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
