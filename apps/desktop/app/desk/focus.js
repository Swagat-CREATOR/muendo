// Save the window the user was in, and put focus back on it afterwards (spec §33.3, §33.10 Part E step 5,
// §38.3 focus.ts). This runs in Electron's main process and nowhere else: Windows only lets the *foreground*
// process hand focus to another window, and at the moment the Inbox key is pressed that process is Electron.
// The core must never try it.
//
// user32.dll through koffi: GetForegroundWindow, SetForegroundWindow, IsWindow. koffi is loaded lazily, the first
// time focus is saved, so a missing or broken native module can't stop Mewndo starting.
// What it can't do: without koffi (it is not yet a dependency of this app) or off Windows, focus is not restored —
// `reason()` says so in those words, and the cards window simply hides instead. The user's caret stays where it
// was in their app, but their keyboard focus does not come back by itself.
const NOT_RESTORED = 'focus not restored';

// load(): require('koffi') by default; tests pass a fake. platform: process.platform by default.
function createFocus({ load = () => require('koffi'), platform = process.platform, log } = {}) {
  let api = null; // { getForeground, setForeground, isWindow }
  let why = null; // why there is no api
  let saved = null;

  function ffi() {
    if (api || why) return api;
    if (platform !== 'win32') {
      why = `${NOT_RESTORED}: only Windows hands focus back this way (this is ${platform}).`;
      return null;
    }
    try {
      const koffi = load();
      const user32 = koffi.load('user32.dll');
      // HWND is an opaque pointer: it is only ever stored and handed straight back to Windows.
      api = {
        getForeground: user32.func('__stdcall', 'GetForegroundWindow', 'void *', []),
        setForeground: user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['void *']),
        isWindow: user32.func('__stdcall', 'IsWindow', 'bool', ['void *']),
      };
    } catch (e) {
      why = `${NOT_RESTORED}: ${e.code === 'MODULE_NOT_FOUND' ? 'koffi is not installed' : e.message}.`;
      // The log line says the same thing the UI does, so "focus not restored" and its cause are in one place: a
      // line about user32 would point at the wrong thing when the real problem is the missing module.
      log?.warn?.(`focus: ${why} The card window will hide instead, and the user's keyboard focus stays where Windows put it.`);
    }
    return api;
  }

  return {
    // True once user32 is loaded and usable. Loading happens on the first save, so ask after that.
    available: () => !!ffi(),
    reason: () => (ffi() ? null : why),
    saved: () => saved,

    // On the Inbox or Talk key, before any Mewndo window is shown.
    save() {
      const f = ffi();
      if (!f) return null;
      try {
        saved = f.getForeground();
      } catch (e) {
        log?.warn?.('focus: GetForegroundWindow failed', e.message);
        saved = null;
      }
      return saved;
    },

    // After an answer, or Esc out of answer mode. A window that has closed in the meantime is left alone, so focus
    // is never handed to a recycled handle.
    restore() {
      const f = ffi();
      const handle = saved;
      saved = null;
      if (!f || !handle) return false;
      try {
        if (!f.isWindow(handle)) return false;
        return f.setForeground(handle) !== false;
      } catch (e) {
        log?.warn?.('focus: SetForegroundWindow failed', e.message);
        return false;
      }
    },

    forget() { saved = null; },
  };
}

module.exports = { createFocus, NOT_RESTORED };
