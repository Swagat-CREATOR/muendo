// Bridge for the lanes window (spec §33.7, §33.10 Part G). It sends what the user does in a lane and hears the lane
// list, the terminal bytes, the picker's preset and the core's refusals: nothing else. No file, process or network
// access reaches the page; every decision is made in the main process (app/desk/desk.js, app/desk/lanes.js).
const { contextBridge, ipcRenderer } = require('electron');

const ACTIONS = ['start', 'type', 'resize', 'attach', 'brake', 'close', 'reply'];
const listen = (channel) => (fn) => { ipcRenderer.on(channel, (_e, payload) => fn(payload)); };

contextBridge.exposeInMainWorld('lanes', {
  action(action, laneId, arg) {
    if (ACTIONS.includes(action)) ipcRenderer.send('lanes:action', action, laneId ?? null, arg);
  },
  onState: listen('lanes:state'), // { lanes: [...], connected }
  onData: listen('lanes:data'), // { laneId, data: Uint8Array }
  onOpen: listen('lanes:open'), // a lane id to show
  onPick: listen('lanes:pick'), // { program, cwd, folders }: open the New lane picker set to these
  onError: listen('lanes:error'), // { program, cwd, message }: the core refused a lane.open
});
