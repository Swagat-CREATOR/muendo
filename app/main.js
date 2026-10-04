const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  new BrowserWindow({ width: 900, height: 600 }).loadURL('data:text/html,<h1>Muendo</h1>');
});

app.on('window-all-closed', () => app.quit());
