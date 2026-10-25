// The Show Me recording indicator (spec §36.6 U9): "Recording — Esc to stop", on top of every window, for as long
// as a recording runs. It can't be clicked (clicks go through to the app being recorded), never takes focus, and is
// kept out of screen captures like the bar, so it never appears in an agent's screenshots. Esc is also taken as a
// global shortcut while it shows, as a second way to stop if the core's keyboard hook misses it.
const path = require('node:path');
const { BrowserWindow, screen, globalShortcut } = require('electron');

function createIndicator({ onEsc, log }) {
  let win = null;
  let escTaken = false;

  function make() {
    win = new BrowserWindow({
      width: 300, height: 44, show: false, frame: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: 'Mewndo is recording',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true);
    win.loadFile(path.join(__dirname, 'renderer', 'showme-indicator.html'));
    win.on('closed', () => { win = null; });
  }

  return {
    show() {
      if (!win || win.isDestroyed()) make();
      else win.webContents.reload(); // a reused window: its clock starts again
      const area = screen.getPrimaryDisplay().workArea;
      win.setPosition(Math.round(area.x + (area.width - 300) / 2), area.y + 12);
      win.showInactive();
      if (!escTaken) {
        escTaken = globalShortcut.register('Escape', () => onEsc());
        if (!escTaken) log.warn('Show Me: Esc could not be taken as a shortcut; the core\'s keyboard hook still stops on Esc');
      }
    },
    hide() {
      if (escTaken) { globalShortcut.unregister('Escape'); escTaken = false; }
      if (win && !win.isDestroyed()) win.hide();
    },
  };
}

module.exports = { createIndicator };
