// The main window's warning rows (a folder that can't be found, low disk space, storage over budget, watcher
// trouble...): what each one says and which buttons it gets. Pure functions over plain objects, no DOM, so tests
// run it with plain Node and app.js only draws the result.
//
// Every row has Dismiss. A missing folder also gets Locate… and Remove from Mewndo; low disk space and storage over
// budget get Open storage settings, with an honest note about what that can and can't free.
(function () {
  const ICONS = { 'folder-unavailable': 'folder', 'low-disk': 'disk', 'over-budget': 'disk', watcher: 'eye' };

  // Locate… can't keep a folder's history at a new place: the v0 engine files a folder's save points under its
  // path, and has no way yet to move them. Said plainly wherever Locate… is offered.
  const LOCATE_LIMIT = "Mewndo can't move a folder's history to a new place yet. If you moved the folder, protect it "
    + 'where it is now: its history starts fresh there. The old save points stay under the old entry, so you can still '
    + 'restore files from them into a separate folder, until you remove it.';
  const DISK_NOTE = 'A smaller history budget frees space at the next daily cleanup. Mewndo never deletes your own '
    + "files to make room, and can't free space other programs use.";

  const nameOf = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || String(p ?? '');
  const same = (a, b, windows) => (windows ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

  // One row: { key, code, folder, tone, icon, title, text, note, actions: [{ id, label }] }.
  function row(alert, { folders = [], windows = false } = {}) {
    const folder = alert.folder ?? null;
    const known = folder ? folders.find((f) => same(f.root, folder, windows)) : null;
    const actions = [];
    let title = null;
    let note = null;
    if (alert.code === 'folder-unavailable' && known) {
      title = `${known.name ?? nameOf(folder)} can't be found`;
      actions.push({ id: 'locate', label: 'Locate…' }, { id: 'remove', label: 'Remove from Mewndo…' });
    } else if (alert.code === 'low-disk' || alert.code === 'over-budget') {
      title = alert.code === 'low-disk' ? 'Low disk space' : 'History is over its budget';
      note = DISK_NOTE;
      actions.push({ id: 'storage', label: 'Open storage settings' });
    }
    actions.push({ id: 'dismiss', label: 'Dismiss' });
    return {
      key: `${alert.code}|${folder ?? ''}`,
      code: alert.code,
      folder,
      tone: alert.code === 'mewndo-core' || alert.code === 'hook-server' ? 'stopped' : 'needs',
      icon: ICONS[alert.code] ?? 'alert',
      title,
      text: alert.message,
      note,
      actions,
    };
  }

  const rows = (alerts, context) => (alerts ?? []).map((a) => row(a, context));

  // What Remove from Mewndo does with the user's choice in its dialog: the folder itself is never touched, and its
  // save points stay unless the user also chose to delete them.
  const removeCall = (choice) => ({ keepHistory: choice !== 'delete' });

  const api = { row, rows, removeCall, nameOf, LOCATE_LIMIT, DISK_NOTE };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MewAlerts = api;
}());
