// One change to `threads` (an agent renamed), timed: the store update with its subscribers (the agents
// index among them), then the render that follows, 40 times.
(async () => {
  const { TH } = window.__ret;
  const N = window.__nav;
  const agents = window.__agents;
  const sync = [], render = [];
  for (let i = 0; i < 40; i++) {
    const id = agents[8 + (i % 12)];
    const t0 = performance.now();
    TH.useThreads.setState((s) => ({ threads: { ...s.threads, [id]: { ...s.threads[id], name: 'idx ' + i } } }));
    const t1 = performance.now();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const t2 = performance.now();
    sync.push(t1 - t0);
    render.push(t2 - t1);
    await N.wait(60);
  }
  const med = (a) => Math.round(a.slice().sort((x, y) => x - y)[a.length >> 1] * 100) / 100;
  const p95 = (a) => Math.round(a.slice().sort((x, y) => x - y)[Math.floor(a.length * 0.95)] * 100) / 100;
  return { threads: Object.keys(TH.useThreads.getState().threads).length, setStateMs: { p50: med(sync), p95: p95(sync) }, thenRenderMs: { p50: med(render), p95: p95(render) } };
})()
