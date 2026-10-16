// Switch to a board like the user's (102 windows) whose chats aren't loaded yet: each loads its newest
// 12 turns through the demo engine (shaped like the real ones, outputs ~6.5 KB) as its window comes up.
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
  const shapes = Object.values(window.__boardShapes);
  const RB = window.__board;
  const threads = {}, owner = {};
  const windows = [];
  let n = 0, bytes = 0;
  for (const w of RB.windows) {
    if (w.threadId.startsWith('file:') || w.threadId.startsWith('draft:') || w.threadId.startsWith('app:')) continue;
    const id = 'cold' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000';
    const shape = window.__boardShapes[w.threadId] ?? shapes[n % shapes.length];
    const turns = shape.map(([userChars, seq], t) => {
      const p = id.slice(0, 8) + '-t' + t;
      const items = [{ type: 'userMessage', id: p + '-u', clientId: null, content: [{ type: 'text', text: text(Math.max(40, userChars)), text_elements: [] }] }, { type: 'reasoning', id: p + '-r', summary: ['**Planning ' + t + '**' + NL + NL + text(300)], content: [] }];
      let k = 0;
      for (const s of seq) {
        if (s < 0) for (let c = 0; c < -s; c++) items.push({ type: 'commandExecution', id: p + '-c' + k++, pluginId: null, scriptPath: null, command: 'rg -n "thing' + k + '" src', cwd, processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: text(6500), exitCode: 0, durationMs: 120 });
        else items.push({ type: 'agentMessage', id: p + '-m' + k++, text: '## Notes ' + k + NL + NL + text(s), phase: 'commentary', memoryCitation: null, delivery: null, questions: null });
      }
      const last = items[items.length - 1];
      if (last.type === 'agentMessage') last.phase = 'final_answer';
      return { id: p, rootTurnId: null, items, itemsView: 'full', status: 'completed', error: null, startedAt: now - 7200 + t * 300, completedAt: now - 7200 + t * 300 + 250, durationMs: 250000 };
    });
    bytes += JSON.stringify(turns.slice(-12)).length;
    const meta = { ...base.meta, id, sessionId: id, name: 'Cold ' + n, preview: 'Cold thread ' + n, updatedAt: now - n * 60, recencyAt: now - n * 60, cwd };
    world.threads.set(id, { ...base, meta, turns, plans: {}, run: null, subscribed: false, failed: false, next: null, away: false });
    threads[id] = { ...meta, turns: [] };
    owner[id] = 'codex';
    windows.push({ ...w, threadId: id });
    n++;
  }
  TH.useThreads.setState((s) => ({ threads: { ...s.threads, ...threads }, owner: { ...s.owner, ...owner } }));
  UI.useUI.setState((s) => ({ boards: [...s.boards.filter((b) => b.id !== 'cold'), { id: 'cold', name: 'Cold', windows, viewport: { ...RB.viewport } }] }));
  await N.wait(1500);
  // Switch to it, as clicking its tab does.
  await N.wait(700);
  const loaf = [];
  const po = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
  po.observe({ type: 'long-animation-frame' });
  const gaps = [];
  let last = performance.now(), run = true;
  const tick = (t) => { gaps.push([t, t - last]); last = t; if (run) requestAnimationFrame(tick); };
  const t0 = performance.now();
  UI.useUI.setState({ activeBoard: 'cold', focusedWindow: null });
  window.__ret.VP.viewport.load({ ...RB.viewport }, 'cold');
  await N.painted();
  const first = performance.now() - t0;
  requestAnimationFrame(tick);
  // Until every window near the view shows its transcript.
  let ready = 0;
  const near = () => [...document.querySelectorAll('.cwin:not([data-culled]):not([data-lod])')].filter((w) => !w.closest('.kept[data-away]'));
  for (let i = 0; i < 3000 && !ready; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const ws = near();
    if (ws.length && ws.every((w) => w.querySelector('section.turn, .glance, .tcard-body'))) ready = performance.now() - t0;
  }
  await N.wait(8000);
  run = false;
  po.disconnect();
  const mine = loaf.filter((e) => e.startTime + e.duration >= t0);
  const r = Math.round;
  const hydrated = Object.keys(TH.useThreads.getState().live).filter((k) => k.startsWith('cold') && TH.useThreads.getState().live[k].hydrated).length;
  const bad = gaps.filter(([, g]) => g > 34);
  return { windows: n, pageMB: Math.round(bytes / 1e5) / 10, firstPaint: r(first), nearReady: r(ready), longFrames: mine.length, blocked: r(mine.reduce((s, e) => s + Math.max(0, e.duration - 50), 0)), worst: r(Math.max(0, ...mine.map((e) => e.duration))), framesOver34ms: bad.length, worstGap: r(Math.max(0, ...gaps.map(([, g]) => g))), hydrated };
})()
