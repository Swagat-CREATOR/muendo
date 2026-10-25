// What the main window and the Settings window may ask of Connections. Every argument is checked here; secrets
// (the GitHub token, the Notion secret) pass straight through to the service and are never logged or returned.
// get(): the Connections service, or null before it has started.

const IDS = ['gmail', 'drive', 'notion', 'github'];
const WORKERS = ['gmail', 'drive', 'notion'];

function need(get) {
  const c = get();
  if (!c) throw new Error('Connections are still starting.');
  return c;
}
const id = (v, list = IDS) => {
  if (!list.includes(v)) throw new Error('unknown connection');
  return v;
};
const keys = (v) => {
  if (!Array.isArray(v) || !v.length || v.length > 500 || !v.every((k) => typeof k === 'string' && k.length < 300)) throw new Error('invalid changes');
  return v;
};
const secret = (v) => {
  if (typeof v !== 'string' || v.length > 400) throw new Error('invalid secret');
  return v;
};

// The main window: names are prefixed so they can't clash with the window's other handlers.
function mainHandlers(get) {
  return {
    connectionsView: () => need(get).view(),
    async connectionsConnect(which) {
      // Google sign-in waits up to 5 minutes for the browser; the window gets updates through events meanwhile.
      need(get).connect(id(which, ['gmail', 'drive'])).catch(() => {});
      return need(get).view();
    },
    connectionsCancel: (which) => need(get).cancelSignIn(id(which)),
    connectionsNotionSecret: async (s) => { await need(get).connectNotion(secret(s)); return need(get).view(); },
    connectionsGithubToken: async (t) => { await need(get).setGitHubToken(secret(t)); return need(get).view(); },
    connectionsGithubRepos: () => need(get).listRepos(),
    connectionsGithubSetRepos: async (list) => { await need(get).setRepos(list); return need(get).view(); },
    connectionsCheck: async (which) => { await need(get).check(id(which)); return need(get).view(); },
    connectionsUndo: (which, k) => need(get).undo(id(which), keys(k)),
    connectionsDisconnect: (which) => need(get).disconnect(id(which)),
  };
}

function settingsHandlers(get) {
  return {
    connectionsSettings: () => need(get).settingsView(),
    setConnectionUrl: (which, url) => {
      if (url != null && (typeof url !== 'string' || url.length > 300)) throw new Error('invalid address');
      return need(get).setUrl(id(which, WORKERS), url ?? '');
    },
  };
}

module.exports = { mainHandlers, settingsHandlers };
