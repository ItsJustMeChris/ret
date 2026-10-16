// After viz-prep: pan the board away so its windows are culled (their panes leave the document),
// then back. A frame that leaves the document loses its page, so coming back loads it again. With
// viz-statedoc before viz-prep, each height should be one more after than before (state kept).
(async () => {
  const { VP } = window.__ret;
  const N = window.__nav;
  const RB = window.__board.viewport;
  const frames = () => [...document.querySelectorAll('.viz-frame')];
  const heights = () => frames().map((f) => f.style.height).join(' ');
  const before = { loads: window.__vizLoads, frames: frames().length, heights: heights() };
  // Culled windows linger in the document for a few seconds before they leave it.
  VP.viewport.set({ ...RB, x: RB.x - 40000 });
  VP.viewport.flush();
  await N.wait(5000);
  const away = { connected: frames().length };
  VP.viewport.set({ ...RB });
  VP.viewport.flush();
  await N.wait(3000);
  return { before, away, back: { frames: frames().length, heights: heights() }, loads: window.__vizLoads - before.loads };
})()
