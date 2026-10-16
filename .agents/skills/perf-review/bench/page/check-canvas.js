// Functional checks on the demo board: pans, wheel over a transcript, zoom, drag, typing, cards and back.
(async () => {
  const { VP, UI } = window.__ret;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = document.querySelector('.canvas-scroller');
  const vpEl = document.querySelector('.canvas-viewport');
  const wins = () => [...document.querySelectorAll('.cwin')];
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const out = {};
  // The demo fits the board until the view is touched: a right press counts.
  vpEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  await wait(300);
  const w0 = wins()[0];
  const first = rectOf(w0);
  const vp0 = { ...VP.viewport.vp };
  // 1. Wheel on empty canvas pans by the delta.
  const r = vpEl.getBoundingClientRect();
  const ev1 = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, deltaX: 60, clientX: r.left + 5, clientY: r.bottom - 5 });
  sc.dispatchEvent(ev1);
  await frame();
  const afterPan = rectOf(w0);
  out.wheelPan = { prevented: ev1.defaultPrevented, moved: [afterPan.x - first.x, afterPan.y - first.y], vpDelta: [VP.viewport.vp.x - vp0.x, VP.viewport.vp.y - vp0.y] };
  // 2. Wheel over a transcript that can scroll up: not prevented (it scrolls natively), canvas stays.
  const tr = [...document.querySelectorAll('.cwin .transcript')].find((t) => t.scrollHeight > t.clientHeight + 20);
  if (tr) {
    const tb = tr.getBoundingClientRect();
    const target = document.elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2);
    const vpb = { ...VP.viewport.vp };
    const ev2 = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: tb.left + tb.width / 2, clientY: tb.top + tb.height / 2 });
    target.dispatchEvent(ev2);
    await frame();
    out.wheelTranscriptUp = { prevented: ev2.defaultPrevented, canvasMoved: VP.viewport.vp.x !== vpb.x || VP.viewport.vp.y !== vpb.y, scrollTop: tr.scrollTop };
    // ...and down at the bottom (can't scroll further): prevented, so it can't chain to the canvas.
    const ev3 = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, clientX: tb.left + tb.width / 2, clientY: tb.top + tb.height / 2 });
    target.dispatchEvent(ev3);
    await frame();
    out.wheelTranscriptDownAtBottom = { prevented: ev3.defaultPrevented, scrollTop: tr.scrollTop };
  }
  // 3. Ctrl+wheel zooms around the pointer: the point under it stays put.
  const px = r.left + r.width * 0.3, py = r.top + r.height * 0.4;
  const worldAt = (sx, sy) => VP.viewport.toWorld(sx - r.left, sy - r.top);
  const before = worldAt(px, py);
  const z0 = VP.viewport.vp.zoom;
  sc.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -150, ctrlKey: true, clientX: px, clientY: py }));
  await frame();
  const mid = { scaling: vpEl.classList.contains('scaling'), anims: document.querySelector('.canvas-world').getAnimations().length };
  const after = worldAt(px, py);
  // What's on screen under the pointer: compare a window's on-screen rect with where the viewport math puts it.
  const win = UI.activeBoard().windows[0];
  const el = document.querySelector(`.cwin[data-win="${win.id}"]`);
  const vp = VP.viewport.vp;
  const expect = { x: Math.round(r.left + win.x * vp.zoom + vp.x), y: Math.round(r.top + win.y * vp.zoom + vp.y) };
  out.zoom = { z0, z1: vp.zoom, anchorDrift: [Math.round((after.x - before.x) * 100) / 100, Math.round((after.y - before.y) * 100) / 100], mid, screenVsMath: [rectOf(el).x - expect.x, rectOf(el).y - expect.y] };
  await wait(400);
  const vp2 = VP.viewport.vp;
  const expect2 = { x: Math.round(r.left + win.x * vp2.zoom + vp2.x), y: Math.round(r.top + win.y * vp2.zoom + vp2.y) };
  out.zoomSettled = { scaling: vpEl.classList.contains('scaling'), anims: document.querySelector('.canvas-world').getAnimations().length, screenVsMath: [rectOf(el).x - expect2.x, rectOf(el).y - expect2.y] };
  // 4. Pan with the pointer on empty canvas (left drag), then check the math again.
  const sx = r.left + 4, sy = r.bottom - 4;
  const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 7, isPrimary: true };
  sc.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: sx, clientY: sy }));
  for (let i = 1; i <= 10; i++) { vpEl.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: sx + i * 20, clientY: sy - i * 10 })); await frame(); }
  vpEl.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0, clientX: sx + 200, clientY: sy - 100 }));
  await wait(300);
  const vp3 = VP.viewport.vp;
  const expect3 = { x: Math.round(r.left + win.x * vp3.zoom + vp3.x), y: Math.round(r.top + win.y * vp3.zoom + vp3.y) };
  out.dragPan = { screenVsMath: [rectOf(el).x - expect3.x, rectOf(el).y - expect3.y], scroll: [sc.scrollLeft, sc.scrollTop] };
  // 5. Focus scrolls the canvas natively (a composer brought into view): the view follows (vp synced).
  // 6. Zoom out to cards and back: panes detach and come back.
  VP.viewport.animateTo({ ...VP.viewport.vp, zoom: 0.3 }, 120);
  await wait(700);
  out.cards = { cards: document.querySelectorAll('.cwin[data-lod="card"]').length, hosts: document.querySelectorAll('.cwin-body').length };
  VP.viewport.animateTo({ ...VP.viewport.vp, zoom: 0.7 }, 120);
  await wait(900);
  out.backFromCards = { cards: document.querySelectorAll('.cwin[data-lod="card"]').length, hosts: document.querySelectorAll('.cwin-body').length, transcripts: document.querySelectorAll('.cwin .transcript').length };
  return out;
})()
