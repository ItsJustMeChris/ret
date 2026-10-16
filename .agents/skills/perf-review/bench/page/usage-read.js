// A first usage read that takes a while (Ret reading gigabytes of transcripts): for 20 s each engine
// answers `ret/usage/activity` with running totals every 120 ms, newest days first, as the main
// process's reader does. Started from here, after usage-home, so the home screen that shows them is
// built but hidden. Follow with the steps to measure while it runs (rstream, still, anims).
(() => {
  const { AC } = window.__ret;
  const world = window.ret.world;
  const MS = 20000, EVERY = 120;
  for (const p of ['codex', 'claude']) {
    const eng = world.engines[p];
    const full = world.usage[p];
    if (!eng || !full) continue;
    const days = Object.keys(full.days).sort().reverse();
    const call = eng.call.bind(eng);
    eng.call = (method, params) => {
      if (method !== 'ret/usage/activity') return call(method, params);
      return new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setInterval(() => {
          const f = Math.min(1, (performance.now() - t0) / MS);
          if (f >= 1) {
            clearInterval(timer);
            eng.call = call;
            return resolve(full);
          }
          // What's been read so far: the newest days, and of them a growing part of each.
          const part = {};
          for (const d of days.slice(0, Math.ceil(days.length * f))) {
            const x = full.days[d];
            const k = 0.5 + f / 2;
            const models = {};
            for (const [m, n] of Object.entries(x.models)) models[m] = Math.round(n * k);
            part[d] = { tokens: Math.round(x.tokens * k), models, prompts: Math.round(x.prompts * k), hours: x.hours.map((n) => Math.round(n * k)) };
          }
          eng.notify('account/usage/updated', { activity: { days: Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : 1))) } });
        }, EVERY);
      });
    };
    void AC.loadTokenUsage(p, 0);
  }
  return 'usage reads running for ' + MS / 1000 + ' s';
})()
