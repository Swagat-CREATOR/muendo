const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createMewndo } = require('../engine');

const mewndo = createMewndo({ dataDir: path.join(app.getPath('userData'), 'data') });
mewndo.on('warning', (w) => console.warn(`[${w.code}] ${w.message}`));

app.whenReady().then(() => {
  mewndo.start().catch((e) => console.error('Mewndo failed to start:', e));
  new BrowserWindow({ width: 900, height: 600 }).loadURL('data:text/html,<h1>Mewndo</h1>');
});

app.on('window-all-closed', () => mewndo.stop().finally(() => app.quit()));
