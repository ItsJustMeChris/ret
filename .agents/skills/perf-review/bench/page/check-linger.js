// Leave the canvas for longer than the linger (it leaves the document), come back: windows where they
// were, a scrolled transcript where it was, and how long the return took.
(async () => {
  const N = window.__nav;
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  await N.wait(500);
  const vis = [...document.querySelectorAll('.cwin:not([data-culled]):not([data-lod])')].filter((w) => !w.closest('.kept[data-away]'));
  const rects = () => vis.map((w) => { const r = w.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
  const tr = vis.map((w) => w.querySelector('.transcript')).find((t) => t && t.scrollHeight > t.clientHeight + 400);
  tr.scrollTop = -300;
  await N.wait(300);
  const before = { rects: rects(), scroll: Math.round(tr.scrollTop) };
  N.mode('focus')();
  await N.wait(62000);
  const away = document.querySelectorAll('.kept[data-away]').length;
  const connected = document.querySelector('.canvas-viewport')?.isConnected ?? false;
  const t0 = performance.now();
  N.mode('canvas')();
  await N.painted();
  const back = performance.now() - t0;
  await N.wait(300);
  const after = { rects: rects(), scroll: Math.round(tr.scrollTop) };
  return { awayAfterLinger: away, canvasInDocWhileAway: connected, returnFirstPaint: Math.round(back), sameRects: JSON.stringify(before.rects) === JSON.stringify(after.rects), before: before.scroll, after: after.scroll, windows: vis.length };
})()
