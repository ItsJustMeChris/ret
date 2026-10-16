// Open a chat whose history isn't loaded yet, shaped like the user's longest (its newest 12 turns
// come to ~3,800 items, ~8 MB), through the demo engine: request, JSON over the wire, parse, store, render.
(async () => {
  const { UI, TH, AC } = window.__ret;
  const N = window.__nav;
  const world = window.ret.world;
  const NL = String.fromCharCode(10);
  const lorem = 'The quick brown fox jumps over the lazy dog while the rate limiter counts tokens per window and the cache warms up. ';
  const text = (n) => { let s = ''; let i = 0; while (s.length < n) s += (i++ % 9 === 8 ? NL : '') + lorem; return s.slice(0, n); };
  const cwd = 'C:/work/real';
  const base = [...world.threads.values()].find((t) => t.provider === 'codex');
  const now = Math.floor(Date.now() / 1000);
  function bigThread(id, nTurns) {
    const turns = [];
    for (let t = 0; t < nTurns; t++) {
      const p = id.slice(0, 8) + '-t' + t;
      const items = [{ type: 'userMessage', id: p + '-u', clientId: null, content: [{ type: 'text', text: 'Turn ' + t + ': ' + lorem, text_elements: [] }] }];
      let k = 0;
      for (let g = 0; g < 11; g++) {
        for (let r = 0; r < 13; r++) items.push({ type: 'reasoning', id: p + '-r' + k++, summary: ['**Step ' + k + '**' + NL + NL + text(300)], content: [] });
        for (let c = 0; c < 6; c++) items.push({ type: 'commandExecution', id: p + '-c' + k++, pluginId: null, scriptPath: null, command: 'rg -n "thing' + k + '" src', cwd, processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: text(6500), exitCode: 0, durationMs: 120 });
        if (g % 2 === 0 || g === 10) items.push({ type: 'fileChange', id: p + '-f' + k++, changes: [{ path: cwd + '/src/mod' + k + '.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,40 +1,40 @@' + NL + text(5000).split(NL).map((l, i) => (i % 2 ? '+' : '-') + l).join(NL) }], status: 'completed' });
        items.push({ type: 'agentMessage', id: p + '-m' + k++, text: g === 10 ? '## Findings ' + t + NL + NL + text(2500) : text(700), phase: g === 10 ? 'final_answer' : 'commentary', memoryCitation: null, delivery: null, questions: null });
      }
      turns.push({ id: p, rootTurnId: null, items, itemsView: 'full', status: 'completed', error: null, startedAt: now - 7200 + t * 300, completedAt: now - 7200 + t * 300 + 250, durationMs: 250000 });
    }
    const meta = { ...base.meta, id, sessionId: id, name: 'Big thread ' + id.slice(3, 8), preview: 'Big thread', updatedAt: now, recencyAt: now, cwd };
    world.threads.set(id, { ...base, meta, turns, plans: {}, run: null, subscribed: false, failed: false, next: null, away: false });
    TH.useThreads.setState((s) => ({ threads: { ...s.threads, [id]: { ...meta, turns: [] } }, owner: { ...s.owner, [id]: 'codex' } }));
    const page = turns.slice(-12);
    return { items: page.reduce((n, t) => n + t.items.length, 0), mb: Math.round(JSON.stringify(page).length / 1e5) / 10 };
  }
  const id1 = 'big00001-0000-4000-8000-000000000000';
  const size = bigThread(id1, 19);
  if (UI.useUI.getState().mode !== 'focus') { N.mode('focus')(); await N.wait(2000); }
  // Time to the first painted frame, to the transcript's first turn on screen, and what blocked meanwhile.
  await N.wait(700);
  const loaf = [];
  const po = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
  po.observe({ type: 'long-animation-frame' });
  const t0 = performance.now();
  AC.openThread(id1, { mode: 'focus' });
  await N.painted();
  const first = performance.now() - t0;
  let content = 0;
  for (let i = 0; i < 400 && !content; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (document.querySelector('.focus-body .thread-pane[data-thread="' + id1 + '"] section.turn')) content = performance.now() - t0;
  }
  await N.painted();
  const contentPainted = performance.now() - t0;
  await N.wait(3000);
  po.disconnect();
  const mine = loaf.filter((e) => e.startTime + e.duration >= t0);
  const r = Math.round;
  return { size, firstPaint: r(first), contentShown: r(content), contentPainted: r(contentPainted), longFrames: mine.length, blocked: r(mine.reduce((s, e) => s + Math.max(0, e.duration - 50), 0)), worst: r(Math.max(0, ...mine.map((e) => e.duration))), turnsDrawn: document.querySelectorAll('.thread-pane[data-thread="' + id1 + '"] section.turn').length };
})()
