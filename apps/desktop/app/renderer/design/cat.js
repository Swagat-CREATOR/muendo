// The cat ("Mew", design spec §4): one cat, six poses, always beside words that say the same thing.
// A plain script for the sandboxed renderers: it sets `window.MewCat`, and tests load it with require().
//
//   const cat = MewCat.create({ pose: 'sit', size: 96 });  parent.append(cat.el);
//   cat.set('reach');   // cross-fades over --m-open; no bouncing, no looping (§4.2)
//
// The fill is the --cat token through a CSS mask, so the eyes and inner lines are cut-outs that show the
// surface behind, in both themes (§4.2 rule 3). The SVGs live in app/assets/cat/.
(function (root) {
  // What each pose means (§4.1), for anyone reading the code next to the screen.
  const POSES = {
    face: 'Mewndo itself',
    sit: 'Watching: everything is protected',
    trot: 'Working on it',
    pounce: 'Caught it',
    reach: 'Got it back',
    loaf: 'Nothing happening',
  };
  const SIZES = [16, 20, 24, 48, 96, 160];

  // 16 to 24 px only ever shows the small face, which drops the outer whiskers (§4.2 rule 4).
  function file(pose, size) {
    if (size <= 24) return 'cat-face-small.svg';
    if (!(pose in POSES)) throw new Error(`no such cat pose: ${pose}`);
    return `cat-${pose}.svg`;
  }

  function create({ pose = 'sit', size = 96, label = '', base = MewCat.base, doc = root.document } = {}) {
    if (!SIZES.includes(size)) throw new Error(`the cat comes in ${SIZES.join(', ')} px, not ${size}`);
    const el = doc.createElement('span');
    el.className = 'cat';
    el.style.setProperty('--cat-size', `${size}px`);
    // The cat never replaces information (§2.3 rule 5): it is decoration unless a label is given.
    if (label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); } else el.setAttribute('aria-hidden', 'true');
    let current = null;

    function layer(name) {
      const i = doc.createElement('i');
      // Absolute: a url() inside a custom property resolves against the stylesheet that uses it (base.css),
      // not this page, so a relative path would point at the wrong folder.
      i.style.setProperty('--pose', `url("${new URL(base + file(name, size), doc.baseURI).href}")`);
      i.dataset.pose = name;
      return i;
    }

    function set(name) {
      if (current && current.dataset.pose === name) return api;
      const next = layer(name);
      if (!current) {
        el.append(next);
      } else {
        const old = current;
        next.classList.add('out');
        el.append(next);
        // Next frame, so the transition runs: the new pose fades in while the old one fades out.
        (root.requestAnimationFrame || ((f) => setTimeout(f, 0)))(() => {
          next.classList.remove('out');
          old.classList.add('out');
          setTimeout(() => old.remove(), 220);
        });
      }
      current = next;
      return api;
    }

    const api = { el, set, pose: () => current?.dataset.pose ?? null };
    set(pose);
    return api;
  }

  // Relative to the page: every window's HTML is in app/renderer/, the SVGs in app/assets/cat/.
  const MewCat = { create, file, POSES, SIZES, base: '../assets/cat/' };
  root.MewCat = MewCat;
  if (typeof module !== 'undefined') module.exports = MewCat;
})(typeof window !== 'undefined' ? window : globalThis);
