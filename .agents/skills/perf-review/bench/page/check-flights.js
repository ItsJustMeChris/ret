// Flights: drawn position vs the view math, mid-flight and after landing; interrupting a flight with a pan.
(async () => {
  const { VP, UI } = window.__ret;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vpEl = document.querySelector('.canvas-viewport');
  vpEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  await wait(300);
  const r = vpEl.getBoundingClientRect();
  const board = UI.activeBoard();
  const win = board.windows[0];
  const el = document.querySelector(`.cwin[data-win="${win.id}"]`);
  const off = () => {
    const vp = VP.viewport.vp;
    const b = el.getBoundingClientRect();
    return [Math.round(b.left - (r.left + win.x * vp.zoom + vp.x)), Math.round(b.top - (r.top + win.y * vp.zoom + vp.y))];
  };
  const out = { samples: [] };
  // Fly somewhere with a zoom change, sampling as it goes.
  const vp0 = { ...VP.viewport.vp };
  VP.viewport.animateTo({ x: vp0.x - 300, y: vp0.y + 120, zoom: vp0.zoom * 0.7 }, 400);
  for (let i = 0; i < 30; i++) {
    await frame();
    if (i % 4 === 1) out.samples.push({ zoom: Math.round(VP.viewport.vp.zoom * 1000) / 1000, off: off(), anims: document.querySelector('.canvas-world').getAnimations().length });
  }
  await wait(300);
  out.landed = { off: off(), anims: document.querySelector('.canvas-world').getAnimations().length, flight: !!VP.viewport.flight };
  // A pure pan flight (same zoom).
  VP.viewport.animateTo({ ...VP.viewport.vp, x: VP.viewport.vp.x + 500 }, 300);
  for (let i = 0; i < 10; i++) await frame();
  out.panFlightMid = off();
  await wait(500);
  out.panFlightLanded = off();
  // Interrupt a flight with a pan (as a wheel would).
  VP.viewport.animateTo({ ...VP.viewport.vp, x: VP.viewport.vp.x - 2000, zoom: VP.viewport.vp.zoom * 1.3 }, 500);
  for (let i = 0; i < 8; i++) await frame();
  VP.viewport.set({ ...VP.viewport.vp, x: VP.viewport.vp.x + 40 });
  await frame();
  await frame();
  out.interrupted = { off: off(), flight: !!VP.viewport.flight, anims: document.querySelector('.canvas-world').getAnimations().length };
  await wait(400);
  out.afterInterrupt = { off: off(), anims: document.querySelector('.canvas-world').getAnimations().length };
  return out;
})()
