// Muendo engine: all file logic. Plain Node only, never imports Electron.
module.exports = { ...require('./store'), ...require('./scanner') };
