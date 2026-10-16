// Open the other one as a canvas window: hydrating fetches its 12 turns (~800 steps) through the engine.
// Then it's put big in the middle of the board's saved view (each measured step starts from that view).
(async () => {
  const { AC, UI, VP } = window.__ret;
  const N = window.__nav;
  const id = 'cuwin001-0000-4000-8000-000000000000';
  const t0 = performance.now();
  AC.openThread(id, { mode: 'canvas' });
  let shown = 0;
  for (let i = 0; i < 600 && !shown; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (document.querySelector('.thread-pane[data-thread="' + id + '"] section.turn')) shown = performance.now() - t0;
  }
  await N.wait(1500);
  const RB = window.__board.viewport;
  const { w: W, h: H } = VP.viewport.size;
  const cx = (W / 2 - RB.x) / RB.zoom, cy = (H / 2 - RB.y) / RB.zoom;
  const ww = Math.round(Math.min(W * 0.7, 1100) / RB.zoom), wh = Math.round(Math.min(H * 0.85, 900) / RB.zoom);
  UI.updateBoard((b) => ({ ...b, windows: b.windows.map((x) => (x.threadId === id ? { ...x, x: cx - ww / 2, y: cy - wh / 2, w: ww, h: wh, z: 99999 } : x)) }));
  VP.viewport.load({ ...RB });
  await N.wait(1500);
  const pane = document.querySelector('.thread-pane[data-thread="' + id + '"]');
  const r = pane.getBoundingClientRect();
  return { contentShownMs: Math.round(shown), zoom: RB.zoom, paneOnScreen: r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight, paneSize: [Math.round(r.width), Math.round(r.height)], size: pane.className.match(/size-\w+/)?.[0] };
})()
