const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { createStore } = require('../engine');

app.whenReady().then(() => {
  const store = createStore(path.join(app.getPath('userData'), 'store'));
  store.cleanTemp().catch((e) => console.error('temp cleanup failed:', e));
  new BrowserWindow({ width: 900, height: 600 }).loadURL('data:text/html,<h1>Muendo</h1>');
});

app.on('window-all-closed', () => app.quit());
