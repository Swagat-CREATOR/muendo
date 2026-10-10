// Stand-in preloads for design screenshots (scripts/design-shot.js --stub=<name>): the page gets the same bridge
// object it has in the app, fed with a state from --state=<file.json>, and nothing it sends goes anywhere.
const fs = require('node:fs');
const path = require('node:path');
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => ipcRenderer.on(channel, (_e, s) => fn(s));
const noop = () => {};
const stubs = {
  bar: { mouse: noop, dragStart: noop, dragEnd: noop, action: noop, voice: noop, onState: listen('bar:state'),
    face: async () => fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'cat', 'cat-face-live.svg'), 'utf8'),
    onCursor: listen('bar:cursor') },
  desk: { key: noop, click: noop, graceEnd: noop, text: noop, onState: listen('cards:state') },
  talk: { submit: noop, chip: noop, close: noop, onOpen: listen('talk:open'), onChips: listen('talk:chips') },
};
const name = process.argv.find((a) => a.startsWith('--stub='))?.slice(7);
if (stubs[name]) contextBridge.exposeInMainWorld(name, stubs[name]);
