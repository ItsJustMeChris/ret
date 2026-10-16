// Runs in the page. Builds a huge synthetic board and measures frames while panning, zooming and streaming.
(() => {
  const { TH, UI, VP } = window.__ret;
  const NL = String.fromCharCode(10);
  const BT = String.fromCharCode(96);
  const FENCE = BT + BT + BT;
  const cwd = 'C:/work/stress';
  const lorem = 'The quick brown fox jumps over the lazy dog while the rate limiter counts tokens per window and the cache warms up. ';
  const code = Array.from({ length: 30 }, (_, i) => '  const value' + i + ' = await fetchSomething(' + i + ', { retries: ' + (i % 4) + ', timeoutMs: ' + i * 100 + ' });').join(NL);
  const md = (k) =>
    ['## Section ' + k, '', lorem.repeat(3), '', '- First point about ' + BT + 'src/server/rate' + k + '.ts:12' + BT, '- Second point with **bold** and *italics*', '- Third point ' + lorem, '',
      FENCE + 'ts', 'export async function handler' + k + '() {', code, '}', FENCE, '', lorem.repeat(4), '', '| a | b | c |', '|---|---|---|', '| 1 | 2 | 3 |', '| 4 | 5 | 6 |', ''].join(NL);
  const out = Array.from({ length: 60 }, (_, i) => 'line ' + i + ': ok  src/module' + i + '.ts  ' + 'x'.repeat(i % 40)).join(NL);

  function mkThread(id, n) {
    const now = Math.floor(Date.now() / 1000);
    return { id, environments: null, extra: null, sessionId: id, forkedFromId: n > 0 && n % 5 === 0 ? 'stress' + String(n - 1).padStart(3, '0') + '-0000-4000-8000-000000000000' : null, parentThreadId: null, preview: 'Stress thread ' + n + ': refactor the rate limiter', ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'full', modelProvider: 'openai', model: 'gpt-5', reasoningEffort: 'medium', createdAt: now - 86400, updatedAt: now - n * 60, recencyAt: now - n * 60, status: { type: 'idle' }, path: null, cwd, cliVersion: '1', originator: null, source: 'cli', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: 'Stress ' + n, daybreakEnabled: null, turns: [] };
  }
  function mkLive(id, turnsN) {
    const lt = { ...TH.emptyLive(), hydrated: true, subscribed: true };
    const now = Math.floor(Date.now() / 1000);
    for (let t = 0; t < turnsN; t++) {
      const tid = id + '-t' + t;
      const ids = [];
      const add = (it) => { lt.items[it.id] = it; ids.push(it.id); };
      add({ type: 'userMessage', id: tid + '-u', clientId: null, content: [{ type: 'text', text: 'Please do task ' + t + '. ' + lorem, text_elements: [] }] });
      add({ type: 'reasoning', id: tid + '-r', summary: ['**Planning step ' + t + '**' + NL + NL + lorem], content: [] });
      for (let c = 0; c < 6; c++) add({ type: 'commandExecution', id: tid + '-c' + c, pluginId: null, scriptPath: null, command: 'rg -n "thing' + c + '" src', cwd, processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: out, exitCode: 0, durationMs: 120 });
      add({ type: 'agentMessage', id: tid + '-m1', text: 'Progress note ' + t + ': ' + lorem, phase: 'commentary', memoryCitation: null, delivery: null, questions: null });
      add({ type: 'agentMessage', id: tid + '-m2', text: md(t) + md(t + 1), phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
      lt.turnOrder.push(tid);
      lt.turns[tid] = { id: tid, status: 'completed', itemIds: ids, error: null, startedAt: now - 3600 + t * 60, completedAt: now - 3600 + t * 60 + 50, durationMs: 50000, diff: null, plan: null };
    }
    return lt;
  }
  function setup(N = 30, cols = 6, turns = 12) {
    const s = TH.useThreads.getState();
    const threads = { ...s.threads }, live = { ...s.live }, owner = { ...s.owner };
    const windows = [];
    for (let n = 0; n < N; n++) {
      const id = 'stress' + String(n).padStart(3, '0') + '-0000-4000-8000-000000000000';
      threads[id] = mkThread(id, n);
      owner[id] = 'codex';
      live[id] = mkLive(id, turns);
      windows.push({ id: 'sw' + n, threadId: id, x: (n % cols) * 584, y: Math.floor(n / cols) * 664, w: 560, h: 640, z: n + 1 });
    }
    TH.useThreads.setState({ threads, live, owner });
    const board = { id: 'stress', name: 'Stress', windows, viewport: { x: 20, y: 20, zoom: 0.8 } };
    UI.useUI.setState((st) => ({ boards: [...st.boards.filter((b) => b.id !== 'stress'), board], activeBoard: 'stress', mode: 'canvas', focusedWindow: null, sidebarOpen: false }));
    // The demo fits the board to the frame until the visitor moves the view: a right press on the canvas counts.
    document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
    setTimeout(() => VP.viewport.load({ x: 20, y: 20, zoom: 0.8 }), 300);
    return windows.length;
  }
  let streamTimer = 0;
  let runs = [];
  /** Threads that look busy (as a real server reports them) without streaming anything. */
  function busy(k = 6) {
    const s = TH.useThreads.getState();
    const threads = { ...s.threads };
    for (const w of UI.activeBoard().windows.slice(0, k)) threads[w.threadId] = { ...threads[w.threadId], status: { type: 'active', activeFlags: [] } };
    TH.useThreads.setState({ threads });
  }
  function stream(k = 5, every = 16, chunk = 6) {
    clearInterval(streamTimer);
    const wins = UI.activeBoard().windows.slice(0, k);
    const now = Math.floor(Date.now() / 1000);
    const stamp = Date.now();
    runs = wins.map((w) => ({ threadId: w.threadId, turnId: w.threadId + '-live' + stamp, itemId: w.threadId + '-lm' + stamp, pos: 0 }));
    const src = md(1) + md(2) + md(3) + md(4) + md(5) + md(6);
    for (const r of runs) TH.enqueueNotification('codex', 'turn/started', { threadId: r.threadId, turn: { id: r.turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: now, completedAt: null, durationMs: null } });
    streamTimer = setInterval(() => {
      for (const r of runs) {
        const d = src.slice(r.pos % src.length, (r.pos % src.length) + chunk);
        r.pos += chunk;
        TH.enqueueNotification('codex', 'item/agentMessage/delta', { threadId: r.threadId, turnId: r.turnId, itemId: r.itemId, delta: d });
      }
    }, every);
    return runs.length;
  }
  function pause() {
    clearInterval(streamTimer);
  }
  function stopStream() {
    clearInterval(streamTimer);
    const now = Math.floor(Date.now() / 1000);
    for (const r of runs) TH.enqueueNotification('codex', 'thread/status/changed', { threadId: r.threadId, status: { type: 'idle' } });
    for (const r of runs) TH.enqueueNotification('codex', 'turn/completed', { threadId: r.threadId, turn: { id: r.turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: now, completedAt: now, durationMs: 1000 } });
    runs = [];
  }
  async function measure(label, ms, drive) {
    const frames = [];
    let last = 0, running = true, i = 0;
    const loafs = [];
    let po;
    try {
      po = new PerformanceObserver((l) => loafs.push(...l.getEntries()));
      po.observe({ type: 'long-animation-frame' });
    } catch {}
    let t0 = 0;
    const step = (t) => {
      frames.push(t - last);
      last = t;
      if (drive) drive(t - t0, i++);
      if (running) requestAnimationFrame(step);
    };
    await new Promise((r) => requestAnimationFrame((t) => { last = t0 = t; requestAnimationFrame(step); r(); }));
    await new Promise((r) => setTimeout(r, ms));
    running = false;
    po && po.disconnect();
    const sorted = frames.slice().sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const over = (x) => frames.filter((f) => f > x).length;
    const r1 = (v) => Math.round(v * 10) / 10;
    return { label, frames: frames.length, fps: Math.round(frames.length / (ms / 1000)), p50: r1(pct(0.5)), p95: r1(pct(0.95)), p99: r1(pct(0.99)), max: r1(sorted.at(-1)), over25: over(25), over50: over(50), loafs: loafs.length, loafMs: Math.round(loafs.reduce((s, e) => s + e.duration, 0)), blockingMs: Math.round(loafs.reduce((s, e) => s + e.blockingDuration, 0)), worst: [...loafs].sort((a, b) => b.duration - a.duration).slice(0, 4).map((e) => ({ dur: Math.round(e.duration), script: Math.round(e.scripts.reduce((s, x) => s + x.duration, 0)), render: Math.round(e.startTime + e.duration - e.renderStart), styleLayout: Math.round(e.startTime + e.duration - e.styleAndLayoutStart), top: [...e.scripts].sort((a, b) => b.duration - a.duration).slice(0, 2).map((x) => `${x.invoker}:${Math.round(x.duration)}`).join(' ') })) };
  }
  // Drives pass a time in ms since the start; each frame sets the view and paints it now (like animateTo).
  function panDrive(amp = 1400) {
    const v0 = { ...VP.viewport.vp };
    return (t) => {
      VP.viewport.set({ ...v0, x: v0.x - amp * (0.5 - 0.5 * Math.cos((t / 1000) * Math.PI)), y: v0.y - amp * 0.5 * (0.5 - 0.5 * Math.cos((t / 1300) * Math.PI)) });
      VP.viewport.flush();
    };
  }
  function zoomDrive(lo = 0.55, hi = 1.2) {
    const cx = VP.viewport.size.w / 2, cy = VP.viewport.size.h / 2;
    return (t) => {
      const z = lo + (hi - lo) * (0.5 - 0.5 * Math.cos((t / 900) * Math.PI));
      VP.viewport.zoomAt(z / VP.viewport.vp.zoom, cx, cy);
      VP.viewport.flush();
    };
  }
  /** Zoom across the card threshold: full windows to cards and back. */
  function zoomCardsDrive() {
    return zoomDrive(0.3, 0.9);
  }
  /** Start a gesture after the view has been still (the first frame re-layers the canvas). */
  async function panStarts(n = 6) {
    const hitches = [];
    for (let k = 0; k < n; k++) {
      await new Promise((r) => setTimeout(r, 400));
      const r = await new Promise((res) => {
        const v0 = { ...VP.viewport.vp };
        const fr = [];
        let last = 0, i = 0;
        const step = (t) => {
          if (last) fr.push(t - last);
          last = t;
          VP.viewport.set({ ...v0, x: v0.x + (k % 2 ? 1 : -1) * 8 * i++ });
          VP.viewport.flush();
          if (i < 12) requestAnimationFrame(step);
          else res(fr);
        };
        requestAnimationFrame(step);
      });
      hitches.push(Math.round(Math.max(...r)));
    }
    return { label: 'pan-start', worstFrames: hitches };
  }
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  async function suite(opts = {}) {
    const res = [];
    const home = { x: 20, y: 20, zoom: 0.8 };
    VP.viewport.load(home);
    await settle(800);
    res.push(await measure('idle', 2000));
    res.push(await measure('pan', 3000, panDrive()));
    VP.viewport.load(home);
    await settle(600);
    res.push(await measure('zoom', 3000, zoomDrive()));
    VP.viewport.load(home);
    await settle(600);
    res.push(await measure('zoom-cards', 3000, zoomCardsDrive()));
    VP.viewport.load(home);
    await settle(800);
    res.push(await panStarts());
    stream(opts.k ?? 6);
    await settle(500);
    res.push(await measure('stream-idle', 3000));
    res.push(await measure('stream-pan', 3000, panDrive()));
    VP.viewport.load(home);
    await settle(300);
    res.push(await measure('stream-zoom', 3000, zoomDrive()));
    stopStream();
    return res;
  }
  window.__stress = { pause, busy, setup, stream, stopStream, measure, panDrive, zoomDrive, zoomCardsDrive, panStarts, suite, settle, md };
})();
