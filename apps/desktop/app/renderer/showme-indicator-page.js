// The indicator's clock: minutes and seconds since the recording started (a recording stops at 10:00).
const started = Date.now();
const clock = document.getElementById('clock');
setInterval(() => {
  const s = Math.floor((Date.now() - started) / 1000);
  clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 500);
