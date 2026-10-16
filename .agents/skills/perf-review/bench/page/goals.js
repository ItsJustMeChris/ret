// Goals: 10 windows with an active goal and a running turn. All shown first (so each GoalTime renders),
// then 8 moved far off (culled, then out of the document), then the canvas hidden (Focus mode).
// Each GoalTime span is watched for text changes (attached or not), and the 1 s intervals counted.
(async () => {
  const { UI, TH, VP } = window.__ret;
  const N = window.__nav;
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  // Count 1 s intervals and their calls.
  const iv = (window.__iv = { live: new Set(), calls: 0 });
  const origSet = window.setInterval.bind(window), origClear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => {
    if (ms !== 1000) return origSet(fn, ms, ...a);
    const id = origSet((...x) => { iv.calls++; return fn(...x); }, ms, ...a);
    iv.live.add(id);
    return id;
  };
  window.clearInterval = (id) => { iv.live.delete(id); return origClear(id); };
  // Ten board windows in a 5 x 2 grid in front of the view, at zoom 0.55 (full windows, not cards).
  const wins = UI.activeBoard().windows.filter((w) => w.threadId.startsWith('real')).slice(0, 10);
  const ids = wins.map((w) => w.id);
  const place = (far) => UI.updateBoard((b) => ({ ...b, windows: b.windows.map((x) => { const i = ids.indexOf(x.id); if (i < 0) return x; const off = far && i >= 2 ? 40000 : 0; return { ...x, x: 100000 + (i % 5) * 600 + off, y: 100000 + Math.floor(i / 5) * 520, w: 560, h: 480, z: 90000 + i }; }) }));
  place(false);
  const zoom = 0.55;
  const { w: W, h: H } = VP.viewport.size;
  VP.viewport.load({ zoom, x: W / 2 - (100000 + 1490) * zoom, y: H / 2 - (100000 + 500) * zoom });
  // Goals, and a running turn for each (a goal's clock runs while a turn works on it).
  const now = Math.floor(Date.now() / 1000);
  const goals = {};
  for (const w of wins) goals[w.threadId] = { threadId: w.threadId, objective: 'Keep the build green and the tests passing', status: 'active', tokenBudget: null, tokensUsed: 1200, timeUsedSeconds: 3, createdAt: now - 100, updatedAt: now };
  TH.useThreads.setState((s) => ({ goals: { ...s.goals, ...goals } }));
  for (const w of wins) {
    TH.enqueueNotification('codex', 'turn/started', { threadId: w.threadId, turn: { id: w.threadId + '-goal', items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: now, completedAt: null, durationMs: null } });
    TH.enqueueNotification('codex', 'thread/status/changed', { threadId: w.threadId, status: { type: 'active', activeFlags: [] } });
  }
  await N.wait(3500);
  const spans = wins.map((w) => document.querySelector('.cwin[data-win="' + w.id + '"] .goal-time'));
  const found = spans.filter(Boolean).length;
  const watch = async (ms) => {
    const counts = spans.map(() => 0);
    const obs = spans.map((s, i) => { if (!s) return null; const o = new MutationObserver((l) => (counts[i] += l.length)); o.observe(s, { characterData: true, childList: true, subtree: true }); return o; });
    const calls0 = iv.calls;
    await N.wait(ms);
    obs.forEach((o) => o && o.disconnect());
    return { changes: counts, attached: spans.map((s) => !!s && s.isConnected), intervals: iv.live.size, intervalCalls: iv.calls - calls0 };
  };
  const allShown = await watch(4000);
  place(true); // 8 go far away: culled, then (after the linger) out of the document
  await N.wait(4000);
  const twoShown = await watch(5000);
  N.mode('focus')();
  await N.wait(500);
  const canvasHidden = await watch(5000);
  N.mode('canvas')();
  await N.wait(500);
  const back = await watch(4000);
  for (const w of wins) TH.enqueueNotification('codex', 'thread/status/changed', { threadId: w.threadId, status: { type: 'idle' } });
  return { spansFound: found, allShown, twoShown, canvasHidden, back };
})()
