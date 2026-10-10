// Brand logos for agents and accounts (assets/logos, see LICENSE.txt there): only to name what they stand for.
// MewLogos.img(name) returns an <img> for a known name, or a round initial badge for anything else.
(function () {
  const FILES = {
    'claude code': 'claude', claude: 'claude', 'claude desktop': 'claude', codex: 'codex', 'openai codex': 'codex', cursor: 'cursor', gemini: 'gemini',
    'gemini cli': 'gemini', gmail: 'gmail', 'google drive': 'drive', drive: 'drive', notion: 'notion', github: 'github',
  };
  const file = (name) => FILES[String(name ?? '').trim().toLowerCase()] ?? null;
  function img(name, size = 20, doc = document) {
    const f = file(name);
    if (f) {
      const i = doc.createElement('img');
      i.src = new URL(`../assets/logos/${f}.svg`, doc.baseURI).href;
      i.alt = '';
      i.width = size;
      i.height = size;
      i.className = 'logo';
      return i;
    }
    const b = doc.createElement('span');
    b.className = 'logo initial';
    b.textContent = String(name ?? '?').trim()[0]?.toUpperCase() ?? '?';
    return b;
  }
  const api = { file, img, FILES };
  if (typeof module !== 'undefined') module.exports = api;
  else window.MewLogos = api;
}());
