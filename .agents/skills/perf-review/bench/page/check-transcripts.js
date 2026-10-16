// Functional checks: transcript position survives release; wheel up/down in a transcript; composer grows; drag a window.
(async () => {
  const { VP, UI } = window.__ret;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = document.querySelector('.canvas-scroller');
  const vpEl = document.querySelector('.canvas-viewport');
  vpEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  await wait(300);
  const out = {};
  const board = UI.activeBoard();
  // A window whose transcript can scroll.
  let win = null, tr = null;
  for (const w of board.windows) {
    const t = document.querySelector(`.cwin[data-win="${w.id}"] .transcript`);
    if (t && t.scrollHeight > t.clientHeight + 150) { win = w; tr = t; break; }
  }
  if (!tr) return 'no scrollable transcript';
  const tb = tr.getBoundingClientRect();
  const at = { clientX: tb.left + tb.width / 2, clientY: tb.top + tb.height / 2 };
  const target = document.elementFromPoint(at.clientX, at.clientY);
  const up = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...at });
  target.dispatchEvent(up);
  const down = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ...at });
  target.dispatchEvent(down);
  out.wheelAtBottom = { upPrevented: up.defaultPrevented, downPrevented: down.defaultPrevented };
  tr.scrollTop = -150;
  await frame();
  const scrolledTo = tr.scrollTop;
  out.scrolledTo = scrolledTo;
  // Pan far away, long enough to be let go, then come back.
  const home = { ...VP.viewport.vp };
  VP.viewport.set({ ...home, x: home.x - 20000 });
  VP.viewport.flush();
  await wait(4500);
  const el = document.querySelector(`.cwin[data-win="${win.id}"]`);
  out.away = { culled: el.hasAttribute('data-culled'), attached: !!el.querySelector(':scope > .cwin-body') };
  VP.viewport.set(home);
  VP.viewport.flush();
  await wait(300);
  await frame();
  const tr2 = el.querySelector('.transcript');
  out.back = { attached: !!el.querySelector(':scope > .cwin-body'), sameNode: tr2 === tr, scrollTop: tr2 && tr2.scrollTop };
  // Composer grows with lines (field-sizing).
  const ta = el.querySelector('.composer textarea');
  const h0 = ta.offsetHeight;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'one\ntwo\nthree\nfour');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  const h1 = ta.offsetHeight;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  out.composer = { empty: h0, fourLines: h1, emptyAgain: ta.offsetHeight };
  // Drag the window by its header.
  const head = el.querySelector('.pane-header');
  const hr = head.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, isPrimary: true };
  const x0 = hr.left + 80, y0 = hr.top + hr.height / 2;
  const r0 = el.getBoundingClientRect();
  head.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x0, clientY: y0 }));
  for (let i = 1; i <= 8; i++) { head.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x0 + i * 10, clientY: y0 + i * 5 })); await frame(); }
  head.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0, clientX: x0 + 80, clientY: y0 + 40 }));
  await wait(200);
  const r1 = el.getBoundingClientRect();
  const w2 = UI.activeBoard().windows.find((w) => w.id === win.id);
  out.drag = { movedOnScreen: [Math.round(r1.left - r0.left), Math.round(r1.top - r0.top)], movedInWorld: [Math.round(w2.x - win.x), Math.round(w2.y - win.y)], zoom: Math.round(VP.viewport.vp.zoom * 1000) / 1000 };
  return out;
})()
