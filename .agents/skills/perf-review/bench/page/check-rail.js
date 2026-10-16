// Turn rail jump in a column-reverse transcript, and a transcript in Focus mode.
(async () => {
  const { UI } = window.__ret;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const vpEl = document.querySelector('.canvas-viewport');
  vpEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  await wait(300);
  const out = {};
  // A transcript with a rail (2+ turns) and something to scroll.
  const tr = [...document.querySelectorAll('.cwin .transcript')].find((t) => t.parentElement.querySelector('.turn-rail') && t.scrollHeight > t.clientHeight + 100);
  if (tr) {
    const rail = tr.parentElement.querySelector('.turn-rail');
    const ticks = rail.querySelectorAll('.rail-tick');
    const turns = tr.querySelectorAll('section.turn');
    out.rail = { ticks: ticks.length, turns: turns.length, scrollTop0: tr.scrollTop };
    // Keyboard activation of the first tick jumps to the first turn.
    ticks[0].click();
    await wait(900);
    const first = turns[0].getBoundingClientRect(), box = tr.getBoundingClientRect();
    out.rail.afterJumpFirst = { scrollTop: Math.round(tr.scrollTop), firstTurnTopFromView: Math.round(first.top - box.top) };
    ticks[ticks.length - 1].click();
    await wait(900);
    const last = turns[turns.length - 1].getBoundingClientRect();
    out.rail.afterJumpLast = { scrollTop: Math.round(tr.scrollTop), lastTurnTopFromView: Math.round(last.top - box.top) };
  }
  // Focus mode: open the first board window's thread there.
  const threadId = UI.activeBoard().windows.find((w) => !w.threadId.startsWith('app:') && !w.threadId.startsWith('file:'))?.threadId;
  UI.useUI.setState((s) => ({ mode: 'focus', tabs: s.tabs.includes(threadId) ? s.tabs : [...s.tabs, threadId], activeTab: threadId }));
  await wait(1200);
  await frame();
  const ft = document.querySelector('.focus-body .transcript, .transcript');
  if (ft) {
    const inner = ft.querySelector('.transcript-inner');
    const fb = ft.getBoundingClientRect(), ib = inner.getBoundingClientRect();
    out.focus = { scrollTop: ft.scrollTop, overflow: ft.scrollHeight > ft.clientHeight, innerBottomGap: Math.round(fb.bottom - ib.bottom), innerTopGap: Math.round(ib.top - fb.top), width: Math.round(ib.width), viewWidth: Math.round(fb.width) };
  }
  UI.useUI.setState({ mode: 'canvas' });
  await wait(500);
  return out;
})()
