// Saving and restoring the foreground window (app/desk/focus.js), spec §33.3 and §33.10 Part E step 5.
// koffi is not a dependency of this app, so the point of these tests is mostly the honest degradation: without
// it, focus is not restored, `reason()` says so in those words, and nothing throws.
const { test } = require('node:test');
const assert = require('node:assert');
const { createFocus, NOT_RESTORED } = require('../app/desk/focus');

// A fake koffi: `user32.func(convention, name, ret, args)` hands back the function the test wants to be called.
function fakeKoffi({ foreground = 0x1234, setForeground = () => true, isWindow = () => true, calls = [] } = {}) {
  return {
    calls,
    load(dll) {
      calls.push(['load', dll]);
      return {
        func(convention, name) {
          calls.push(['func', convention, name]);
          if (name === 'GetForegroundWindow') return () => { calls.push(['GetForegroundWindow']); return foreground; };
          if (name === 'SetForegroundWindow') return (h) => { calls.push(['SetForegroundWindow', h]); return setForeground(h); };
          if (name === 'IsWindow') return (h) => { calls.push(['IsWindow', h]); return isWindow(h); };
          throw new Error(`the test fake does not know ${name}`);
        },
      };
    },
  };
}

function quietLog() {
  const lines = [];
  const add = (level) => (message, details) => lines.push(`${level} ${message} ${details ?? ''}`.trim());
  return { lines, info: add('INFO'), warn: add('WARN'), error: add('ERROR') };
}

test('on Windows with koffi: the foreground window is saved, then handed back', () => {
  const koffi = fakeKoffi({ foreground: 0xabcd });
  const log = quietLog();
  const focus = createFocus({ load: () => koffi, platform: 'win32', log });
  assert.strictEqual(focus.saved(), null, 'nothing is saved before the Inbox key');
  assert.strictEqual(focus.save(), 0xabcd);
  assert.strictEqual(focus.saved(), 0xabcd);
  assert.strictEqual(focus.available(), true);
  assert.strictEqual(focus.reason(), null);
  assert.strictEqual(focus.restore(), true);
  // The window is checked before focus is handed to it, so focus is never given to a recycled handle.
  assert.deepStrictEqual(
    koffi.calls.filter((c) => ['GetForegroundWindow', 'IsWindow', 'SetForegroundWindow'].includes(c[0])),
    [['GetForegroundWindow'], ['IsWindow', 0xabcd], ['SetForegroundWindow', 0xabcd]],
  );
  // Only the three calls §33.10 Part E step 5 names are declared.
  assert.deepStrictEqual(
    koffi.calls.filter((c) => c[0] === 'func').map((c) => c[2]),
    ['GetForegroundWindow', 'SetForegroundWindow', 'IsWindow'],
  );
  assert.deepStrictEqual(koffi.calls[0], ['load', 'user32.dll']);
  assert.strictEqual(focus.saved(), null, 'the handle is used once and forgotten');
  assert.strictEqual(focus.restore(), false, 'restoring twice does nothing');
});

test('user32 is loaded lazily, so a broken native module cannot stop Mewndo starting', () => {
  let loads = 0;
  const koffi = fakeKoffi();
  const focus = createFocus({ load: () => { loads++; return koffi; }, platform: 'win32', log: quietLog() });
  assert.strictEqual(loads, 0, 'nothing is loaded by createFocus itself');
  focus.save();
  assert.strictEqual(loads, 1);
  focus.save();
  focus.restore();
  assert.strictEqual(loads, 1, 'and it is loaded once, not per key press');
});

test('without koffi: "focus not restored" in those words, a clear log line, and nothing thrown', () => {
  // koffi is not installed in this app (it is not in apps/desktop/package.json), so this is what happens today.
  const log = quietLog();
  const missing = () => {
    const e = new Error("Cannot find module 'koffi'");
    e.code = 'MODULE_NOT_FOUND';
    throw e;
  };
  const focus = createFocus({ load: missing, platform: 'win32', log });
  assert.strictEqual(focus.save(), null);
  assert.strictEqual(focus.restore(), false, 'the caller hides its window and carries on');
  assert.strictEqual(focus.available(), false);
  assert.strictEqual(focus.reason(), `${NOT_RESTORED}: koffi is not installed.`);
  assert.strictEqual(NOT_RESTORED, 'focus not restored');
  // The log says which dependency is missing and what the user loses, not just that something failed.
  assert.strictEqual(log.lines.length, 1, `one line, got ${JSON.stringify(log.lines)}`);
  assert.match(log.lines[0], /^WARN/);
  assert.match(log.lines[0], /koffi is not installed/);
  assert.match(log.lines[0], /focus not restored/);
});

test('a koffi that is installed but broken is reported with its own message', () => {
  const log = quietLog();
  const focus = createFocus({ load: () => { throw new Error('this version of koffi needs Node 24'); }, platform: 'win32', log });
  assert.strictEqual(focus.available(), false);
  assert.strictEqual(focus.reason(), `${NOT_RESTORED}: this version of koffi needs Node 24.`);
  assert.ok(log.lines.some((l) => /needs Node 24/.test(l)));
});

test('a user32.dll that will not load, or a call it will not declare, is reported the same way', () => {
  const log = quietLog();
  const focus = createFocus({
    load: () => ({ load() { throw new Error('user32.dll: not found'); } }), platform: 'win32', log,
  });
  assert.strictEqual(focus.save(), null);
  assert.strictEqual(focus.reason(), `${NOT_RESTORED}: user32.dll: not found.`);
  const half = createFocus({
    load: () => ({ load: () => ({ func: (c, name) => { if (name === 'IsWindow') throw new Error('bad prototype'); return () => 1; } }) }),
    platform: 'win32',
    log,
  });
  assert.strictEqual(half.available(), false, 'all three calls or none: a half-declared api is not used');
  assert.match(half.reason(), /bad prototype/);
});

test('off Windows: no attempt at all, and the reason says which platform this is', () => {
  // Mewndo is a Windows app; only Windows hands focus over this way. On Linux and macOS the module must not even
  // try to load user32, and must say why rather than look broken.
  for (const platform of ['linux', 'darwin']) {
    let loaded = false;
    const focus = createFocus({ load: () => { loaded = true; return fakeKoffi(); }, platform, log: quietLog() });
    assert.strictEqual(focus.available(), false, platform);
    assert.strictEqual(focus.reason(), `${NOT_RESTORED}: only Windows hands focus back this way (this is ${platform}).`);
    assert.strictEqual(focus.save(), null);
    assert.strictEqual(focus.restore(), false);
    assert.strictEqual(loaded, false, `${platform}: koffi is never loaded`);
  }
});

test('a window that closed while the card was open is left alone', () => {
  // SetForegroundWindow on a handle Windows has recycled would put focus on somebody else's window.
  const koffi = fakeKoffi({ foreground: 0x99, isWindow: () => false });
  const focus = createFocus({ load: () => koffi, platform: 'win32', log: quietLog() });
  focus.save();
  assert.strictEqual(focus.restore(), false);
  assert.ok(!koffi.calls.some((c) => c[0] === 'SetForegroundWindow'), 'focus is not handed anywhere');
});

test('Windows refusing the hand-over is reported as a plain false, not an error', () => {
  // SetForegroundWindow fails when another process holds the foreground lock. The user keeps their caret where it
  // was; Mewndo simply did not bring the window forward.
  const focus = createFocus({ load: () => fakeKoffi({ setForeground: () => false }), platform: 'win32', log: quietLog() });
  focus.save();
  assert.strictEqual(focus.restore(), false);
});

test('a call into user32 that throws is logged, not propagated', () => {
  const log = quietLog();
  const boom = () => { throw new Error('access violation'); };
  const saving = createFocus({ load: () => fakeKoffi({ foreground: boom }), platform: 'win32', log });
  // GetForegroundWindow throwing: nothing is saved, and the Inbox key still shows the card.
  const thrower = createFocus({
    load: () => ({ load: () => ({ func: (c, name) => (name === 'GetForegroundWindow' ? boom : () => true) }) }),
    platform: 'win32',
    log,
  });
  assert.strictEqual(thrower.save(), null);
  assert.ok(log.lines.some((l) => /GetForegroundWindow failed/.test(l)));
  assert.strictEqual(thrower.restore(), false, 'and there is nothing to restore');
  // SetForegroundWindow throwing: the same.
  const setter = createFocus({ load: () => fakeKoffi({ setForeground: boom }), platform: 'win32', log });
  setter.save();
  assert.strictEqual(setter.restore(), false);
  assert.ok(log.lines.some((l) => /SetForegroundWindow failed/.test(l)));
  assert.ok(saving, 'the fake with a throwing getter builds without being called');
});

test('forget drops the saved window, for Esc that should not move focus', () => {
  const focus = createFocus({ load: () => fakeKoffi({ foreground: 0x77 }), platform: 'win32', log: quietLog() });
  focus.save();
  focus.forget();
  assert.strictEqual(focus.saved(), null);
  assert.strictEqual(focus.restore(), false);
});

test('a handle of 0 (no foreground window at all) is not restored to', () => {
  // GetForegroundWindow returns NULL when no window has focus, e.g. at the lock screen. Handing focus to NULL is
  // meaningless, so it counts as nothing saved.
  const koffi = fakeKoffi({ foreground: 0 });
  const focus = createFocus({ load: () => koffi, platform: 'win32', log: quietLog() });
  assert.strictEqual(focus.save(), 0);
  assert.strictEqual(focus.restore(), false);
  assert.ok(!koffi.calls.some((c) => c[0] === 'SetForegroundWindow'));
});

test('the real loader is require("koffi"), and asking for it does not throw here', () => {
  // The default load() is a plain require, so this test also records the dependency: koffi is installed. On Windows
  // it reaches user32; anywhere else there is no user32.dll to load, and that is said, not thrown.
  assert.doesNotThrow(() => require('koffi'), 'koffi is a dependency of apps/desktop');
  const focus = createFocus({ platform: 'win32', log: quietLog() });
  if (process.platform === 'win32') {
    assert.strictEqual(focus.available(), true, focus.reason());
  } else {
    assert.strictEqual(focus.available(), false);
    assert.match(focus.reason(), /^focus not restored: /);
  }
});
