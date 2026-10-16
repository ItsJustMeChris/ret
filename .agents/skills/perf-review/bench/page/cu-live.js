// The measured part: 30 steps with whole 1600x900 screenshots, one every 400 ms, with the dock open
// and the previous turn's three thumbnails on screen. Long frames recorded with what ran in them.
(async () => {
  const N = window.__nav, C = window.__cu, shots = window.__cuShots, apps = window.__cuApps;
  const turn = 'cuwin001-live2';
  const loaf = [];
  const po = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
  po.observe({ type: 'long-animation-frame' });
  C.startTurn(turn);
  await N.wait(300);
  const t0 = performance.now();
  for (let k = 0; k < 30; k++) {
    C.step(turn, k, apps[(k >> 2) % 2], shots[k % 6]);
    await N.wait(400);
  }
  const secs = (performance.now() - t0) / 1000;
  const pane = document.querySelector('.thread-pane[data-thread="' + C.id + '"]');
  const dock = pane.querySelector('.screen-dock');
  const dockImg = dock?.querySelector('img');
  const state = { dockOpen: !!dock?.classList.contains('open'), dockImg: dockImg ? dockImg.naturalWidth + 'x' + dockImg.naturalHeight + (dockImg.src.startsWith('blob:') ? ' blob' : ' ?') : null, thumbsOnScreen: pane.querySelectorAll('.activity-thumbs img').length };
  C.endTurn(turn);
  await N.wait(500);
  po.disconnect();
  const r = (v) => Math.round(v);
  const scripts = {};
  for (const e of loaf) for (const s of e.scripts || []) { const k = (s.invoker || '?').slice(0, 60) + ' | ' + (s.sourceFunctionName || '') ; scripts[k] = (scripts[k] || 0) + s.duration; }
  return { secs: Math.round(secs * 10) / 10, ...state, longFrames: loaf.length, worst: r(Math.max(0, ...loaf.map((e) => e.duration))), blocked: r(loaf.reduce((s, e) => s + Math.max(0, e.duration - 50), 0)), longFrameScripts: Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + ' ' + r(v) + 'ms') };
})()
