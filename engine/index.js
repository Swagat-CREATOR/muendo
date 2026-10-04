// Mewndo engine: all file logic. Plain Node only, never imports Electron.
module.exports = {
  ...require('./store'), ...require('./scanner'), ...require('./journal'), ...require('./diff'), ...require('./mewndo'),
  ...require('./agents'), ...require('./hook-server'), ...require('./claude-hooks'),
};
