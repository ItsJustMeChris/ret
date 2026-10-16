// Shared by the nav* scripts: time a navigation from the click to its first painted frame, then how
// long the page stays busy (long animation frames, worst frame gap) over the next `after` ms.
window.__nav = (() => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  async function measure(label, act, after = 2500) {
    await wait(700);
    const loaf = [];
    const po = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
    po.observe({ type: 'long-animation-frame' });
    const t0 = performance.now();
    act();
    const handler = performance.now() - t0;
    await painted();
    const first = performance.now() - t0;
    let last = performance.now(), maxGap = 0, run = true, frames = 0;
    const tick = (t) => { maxGap = Math.max(maxGap, t - last); last = t; frames++; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await wait(after);
    run = false;
    po.disconnect();
    const mine = loaf.filter((e) => e.startTime + e.duration >= t0);
    const r = (v) => Math.round(v);
    return { label, handler: r(handler), firstPaint: r(first), longFrames: mine.length, blocked: r(mine.reduce((s, e) => s + Math.max(0, e.duration - 50), 0)), worst: r(Math.max(0, ...mine.map((e) => e.duration))), maxGapAfter: r(maxGap), dom: document.getElementsByTagName('*').length };
  }
  const click = (sel, text) => () => { const el = [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.includes(text)); if (!el) throw new Error('no ' + sel + ' ' + text); el.click(); };
  const mode = (name) => click('.segmented button', name[0].toUpperCase() + name.slice(1));
  /** A thread as long as the user's longest: `turns` turns made of the real board's biggest shapes. */
  function longThread(id, turns = 40) {
    const { TH } = window.__ret;
    const shapes = Object.values(window.__boardShapes).sort((a, b) => b.reduce((s, [, q]) => s + q.length, 0) - a.reduce((s, [, q]) => s + q.length, 0));
    const shape = [];
    for (let i = 0; shape.length < turns; i++) shape.push(...shapes[i % shapes.length]);
    const s = TH.useThreads.getState();
    const th = window.__stress.mkThread(id, 9000);
    th.name = 'Long thread';
    const lt = window.__stress.mkLive(id, shape.slice(0, turns));
    TH.useThreads.setState({ threads: { ...s.threads, [id]: th }, live: { ...s.live, [id]: lt }, owner: { ...s.owner, [id]: 'codex' } });
    return { turns: lt.turnOrder.length, items: Object.keys(lt.items).length };
  }
  return { wait, painted, measure, click, mode, longThread };
})();
'nav ready';
