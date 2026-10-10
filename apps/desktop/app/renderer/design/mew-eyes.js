// Mewndo living face: pupils follow a target, random blinks, moods.
// Usage: const eyes = MewEyes(svgElement); eyes.lookAt(screenX, screenY); eyes.mood('needs');
// In Electron, call lookAt() with the cursor position that the main process sends (screen coordinates),
// converted to client coordinates: x - window.screenX, y - window.screenY.
function MewEyes(svg, opts = {}) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pupils = ['l', 'r'].map(s => svg.querySelector('#mew-pupil-' + s));
  const lids = ['l', 'r'].map(s => svg.querySelector('#mew-lid-' + s));
  const rest = pupils.map(p => ({ cx: +p.dataset.restCx, cy: +p.dataset.restCy, w: +p.dataset.eyeW, h: +p.dataset.eyeH,
                                  rx: +p.getAttribute('rx'), ry: +p.getAttribute('ry') }));
  let target = { dx: 0, dy: 0 }, cur = { dx: 0, dy: 0 }, raf = 0, lidOpen = 1, moodName = 'calm', blinkTimer = 0;
  const MAXX = 0.20, MAXY = 0.12;                         // share of eye width/height the pupil may travel

  function setLids(open) {                                  // 1 = fully open, 0 = closed
    lidOpen = open;
    lids.forEach(l => { l.style.transform = `translateY(${-100 * open}%)`; });
  }
  function frame() {
    const k = reduce ? 1 : 0.25;                            // easing per frame
    cur.dx += (target.dx - cur.dx) * k; cur.dy += (target.dy - cur.dy) * k;
    pupils.forEach((p, i) => {
      p.setAttribute('cx', (rest[i].cx + cur.dx * rest[i].w * MAXX).toFixed(1));
      p.setAttribute('cy', (rest[i].cy + cur.dy * rest[i].h * MAXY).toFixed(1));
    });
    raf = (Math.abs(target.dx - cur.dx) + Math.abs(target.dy - cur.dy) > 0.002) ? requestAnimationFrame(frame) : 0;
  }
  function lookAt(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height * 0.55;
    let dx = clientX - cx, dy = clientY - cy; const d = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, d / 160);                     // close targets move the eyes less
    target = { dx: dx / d * reach, dy: dy / d * reach };
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function lookToward(side) {                               // 'left' | 'right' | 'up' | 'down' | 'center'
    target = { left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 }, up: { dx: 0, dy: -1 },
               down: { dx: 0, dy: 1 }, center: { dx: 0, dy: 0 } }[side];
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function blink() {
    if (reduce || moodName === 'sleepy') return;
    const was = lidOpen; setLids(0);
    setTimeout(() => setLids(was), 130);
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => { blink(); scheduleBlink(); }, 2800 + Math.random() * 3600);
  }
  function mood(name) {                                     // calm | needs | caught | sleepy
    moodName = name;
    pupils.forEach((p, i) => {
      const s = { calm: [1, 1], needs: [1.15, 1.1], caught: [0.6, 1.05], sleepy: [1, 1] }[name];
      p.setAttribute('rx', (rest[i].rx * s[0]).toFixed(1)); p.setAttribute('ry', (rest[i].ry * s[1]).toFixed(1));
    });
    setLids(name === 'sleepy' ? 0.45 : 1);
    if (name === 'caught' && !reduce) { blink(); setTimeout(blink, 260); }
  }
  lids.forEach(l => { l.style.transformBox = 'fill-box'; l.style.transition = reduce ? 'none' : 'transform 110ms ease-in-out'; });
  setLids(1); scheduleBlink();
  return { lookAt, lookToward, blink, mood, destroy() { clearTimeout(blinkTimer); cancelAnimationFrame(raf); } };
}
if (typeof module !== 'undefined') module.exports = { MewEyes };
