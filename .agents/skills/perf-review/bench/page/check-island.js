// Functional check: the Dynamic Island (the box on top of a composer) reshapes without jumps. Run in
// Focus mode on the demo board. The widest pane's thread gets a goal, queued messages and subagents,
// then loses them, one change at a time; a few changes land mid-animation, and one with the transcript
// scrolled up. Each change is checked at its first frame (everything still where it was: the island's
// edge, its parts, the transcript's content) and at its last (just where it all is once it settles).
// `worst` is the largest jump seen, in px (healthy: < 1), with each change's own under `changes`.
// Leaves `window.__isl` (pane, set(), snap…) for scripts run after it (screenshots mid-animation).
(async () => {
  const { TH } = window.__ret;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const panes = [...document.querySelectorAll('.thread-pane')].filter((p) => p.checkVisibility({ contentVisibilityAuto: true }) && p.querySelector('.transcript-inner'));
  const pane = panes.sort((a, b) => b.offsetWidth - a.offsetWidth)[0];
  if (!pane) return 'no pane with a transcript on screen (run mode-focus first)';
  const P = pane.dataset.thread;
  const island = pane.querySelector('.dynamic-island');
  const inner = pane.querySelector('.transcript-inner');
  const scroller = pane.querySelector('.transcript');
  const S = () => TH.useThreads.getState();
  const set = (patch) => TH.useThreads.setState(patch);
  let n = 0;
  const api = {
    pane,
    goal(objective) {
      const now = Date.now() / 1000;
      const goals = { ...S().goals };
      if (objective) goals[P] = { threadId: P, objective, status: 'active', tokenBudget: 200000, tokensUsed: 41000, timeUsedSeconds: 380, createdAt: now - 600, updatedAt: now };
      else delete goals[P];
      set({ goals });
    },
    queue(texts) {
      set({ queued: { ...S().queued, [P]: texts.map((text) => ({ id: 'q-' + text, text, attachments: [], prefs: {} })) } });
    },
    agent(name) {
      const base = S().threads[P];
      const id = 'isl-agent-' + ++n;
      set({ threads: { ...S().threads, [id]: { ...base, id, name, parentThreadId: P, agentNickname: name, status: { type: 'active', activeFlags: [] }, createdAt: base.createdAt + n, turns: [] } } });
      return id;
    },
    done(id) {
      set({ threads: { ...S().threads, [id]: { ...S().threads[id], status: { type: 'idle' } } } });
    },
    // The island's and transcript's animations still going (not the ones that never end: spinners, shimmers).
    anims: () => [...island.getAnimations({ subtree: true }), ...inner.getAnimations()].filter((a) => a.effect.getComputedTiming().endTime !== Infinity && a.playState !== 'finished'),
    seek(ms, list = api.anims()) {
      for (const a of list) {
        a.pause();
        a.currentTime = Math.min(ms, a.effect.getComputedTiming().endTime);
      }
    },
    // Where things show (rects include the animations' transforms): sections by what they are, rows by what they say.
    snap() {
      const parts = {};
      for (const p of island.querySelectorAll('.island-part')) {
        if (p.classList.contains('arrive') && p.getAnimations().some((a) => a.playState === 'paused' && a.currentTime === 0)) continue; // not in yet
        const what = p.parentElement.classList.contains('island-body') ? p.firstElementChild?.classList[0] : (p.querySelector('.queue-text') ?? p).textContent.trim();
        parts[(p.classList.contains('leaving') ? '-' : '') + what] = Math.round(p.getBoundingClientRect().top * 10) / 10;
      }
      // Empty, the island isn't laid out: its edge is the composer's top.
      const edge = (island.getClientRects().length ? island : island.nextElementSibling).getBoundingClientRect().top;
      return { edge, content: inner.getBoundingClientRect().bottom, parts };
    },
  };
  window.__isl = api;

  const diff = (a, b) => {
    let worst = Math.max(Math.abs(a.edge - b.edge), Math.abs(a.content - b.content));
    const off = {};
    for (const k in a.parts) {
      const k2 = k.startsWith('-') ? k : k in b.parts ? k : '-' + k;
      if (!(k2 in b.parts)) continue;
      const d = Math.abs(a.parts[k] - b.parts[k2]);
      if (d >= 0.5) off[k] = d;
      worst = Math.max(worst, d);
    }
    return { worst: Math.round(worst * 10) / 10, edge: Math.round((b.edge - a.edge) * 10) / 10, content: Math.round((b.content - a.content) * 10) / 10, ...(Object.keys(off).length ? { off } : {}) };
  };
  // Done moving and back to plain layout (or 2.5 s gone by: `left` then says what's still set).
  const settle = async () => {
    for (let i = 0; i < 50 && (api.anims().length || island.style.length); i++) await wait(50);
    await frame();
  };
  const changes = [];
  // A change, checked at its first frame and its last. `mid`: it lands this far into the last one's.
  const change = async (label, act, mid) => {
    if (mid == null) await settle();
    else api.seek(mid);
    const old = new Set(api.anims());
    const before = api.snap();
    act();
    await frame();
    api.seek(0, api.anims().filter((a) => !old.has(a)));
    const start = api.snap();
    api.seek(1e6);
    const end = api.snap();
    for (const a of api.anims()) a.finish();
    await settle();
    const after = api.snap();
    const res = { label, height: island.offsetHeight, start: diff(before, start), end: diff(end, after), left: island.getAttribute('style') || '' };
    changes.push(res);
    return res;
  };

  await change('goal', () => api.goal('Get the Redis-backed limiter passing the load test at 2k rps'));
  await change('queue 1', () => api.queue(['Then write it up for the PR']));
  await change('queue 2', () => api.queue(['Then write it up for the PR', 'And bump the version']));
  let a, b, c;
  await change('agent a', () => (a = api.agent('explorer')));
  await change('agent b', () => (b = api.agent('worker')));
  await change('agent c', () => (c = api.agent('tester')));
  await change('b done (middle row)', () => api.done(b));
  await change('first queued sent (top row)', () => api.queue(['And bump the version']));
  // Mid-animation: a change lands while the last one's still going.
  const midway = async (label, first, then, ms) => {
    await settle();
    first();
    await frame();
    await change(label, then, ms);
  };
  const q = ['And bump the version', 'One more thing', 'And another', 'Last one'];
  await midway('grow, then grow 120ms in', () => api.queue(q.slice(0, 2)), () => api.queue(q.slice(0, 3)), 120);
  await midway('grow, then shrink 100ms in', () => api.queue(q), () => api.queue(q.slice(0, 1)), 100);
  await change('queue 3', () => api.queue(q.slice(0, 3)));
  await midway('shrink, then grow 100ms in', () => api.queue(q.slice(0, 1)), () => api.queue([q[0], 'Back again', 'And again']), 100);
  await midway('leaving, then back 60ms in', () => api.queue(q.slice(0, 1)), () => api.queue([q[0], 'Back again']), 60);
  await change('queue back to one', () => api.queue(q.slice(0, 1)));
  // Scrolled up in the transcript.
  await settle();
  scroller.scrollTop = -240;
  await frame();
  await change('scrolled up: goal cleared', () => api.goal(null));
  scroller.scrollTop = 0;
  await frame();
  await change('goal again', () => api.goal('Ship it'));
  await change('goal unfolded', () => pane.querySelector('.goal-text').click());
  await change('goal folded', () => pane.querySelector('.goal-text').click());
  await change('agents folded', () => pane.querySelector('.agent-tray-head').click());
  await change('agents unfolded', () => pane.querySelector('.agent-tray-head').click());
  await change('a, c done (section leaves)', () => {
    api.done(a);
    api.done(c);
  });
  await change('goal cleared', () => api.goal(null));
  await change('queue emptied (island empties)', () => api.queue([]));
  await settle();
  return {
    worst: Math.max(...changes.flatMap((c) => [c.start.worst, c.end.worst])),
    empty: { laidOut: island.getClientRects().length > 0, style: island.getAttribute('style'), parts: island.querySelectorAll('.island-part').length },
    changes,
  };
})()
