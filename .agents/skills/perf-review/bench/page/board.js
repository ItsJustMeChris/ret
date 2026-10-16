// Runs in the page after harness.js and board-data.js: sets up the reference board (102 windows, the
// geometry and thread shapes of a real board), streams agent turns into it (reasoning, commands with
// output, replies), and drives the interactions the suite measures (drag, focus, scroll, type, fly).
// (The "real" in names here means that board, as opposed to harness.js's uniform synthetic one.)
(() => {
  const { TH, UI, VP } = window.__ret;
  const S = window.__stress;
  const NL = String.fromCharCode(10);
  const BT = String.fromCharCode(96);
  const FENCE = BT + BT + BT;
  const cwd = 'C:/work/real';
  const lorem = 'The quick brown fox jumps over the lazy dog while the rate limiter counts tokens per window and the cache warms up. ';
  const codeLines = Array.from({ length: 14 }, (_, i) => '  const value' + i + ' = await fetchSomething(' + i + ', { retries: ' + (i % 4) + ' });');
  const blocks = [
    (k) => '## Findings ' + k + NL + NL + lorem.repeat(3),
    (k) => '- First point about ' + BT + 'src/server/rate' + k + '.ts:12' + BT + NL + '- Second point with **bold** and *italics*' + NL + '- Third point ' + lorem,
    (k) => FENCE + 'ts' + NL + 'export async function handler' + k + '() {' + NL + codeLines.join(NL) + NL + '}' + NL + FENCE,
    (k) => lorem.repeat(4),
    (k) => '| file | before | after |' + NL + '|---|---|---|' + NL + '| a' + k + '.ts | 12 | 9 |' + NL + '| b' + k + '.ts | 4 | 4 |' + NL + '| c.ts | 1 | 0 |',
    (k) => '1. Step one ' + lorem + NL + '2. Step two ' + BT + 'npm test' + BT + NL + '3. Step three',
  ];
  /** Markdown about `n` characters long, built of whole blocks. */
  function mdOf(n, seed) {
    let out = '';
    let i = seed;
    while (out.length < n) out += (out ? NL + NL : '') + blocks[i++ % blocks.length](i);
    return out;
  }
  const outText = Array.from({ length: 24 }, (_, i) => 'line ' + i + ': ok  src/module' + i + '.ts  ' + 'x'.repeat(i % 40)).join(NL);
  const cmd = (id, i) => ({ type: 'commandExecution', id, pluginId: null, scriptPath: null, command: 'rg -n "thing' + i + '" src', cwd, processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: outText, exitCode: 0, durationMs: 120 });

  function mkThread(id, n) {
    const now = Math.floor(Date.now() / 1000);
    return { id, environments: null, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: 'Real-shaped thread ' + n, ephemeral: false, section: null, sectionEnteredAt: null, projectId: null, historyMode: 'full', modelProvider: 'openai', model: 'gpt-5', reasoningEffort: 'medium', createdAt: now - 86400, updatedAt: now - n * 60, recencyAt: now - n * 60, status: { type: 'idle' }, path: null, cwd, cliVersion: '1', originator: null, source: 'cli', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: 'Thread ' + n, daybreakEnabled: null, turns: [] };
  }
  function mkLive(id, shape) {
    const lt = { ...TH.emptyLive(), hydrated: true, subscribed: true };
    const now = Math.floor(Date.now() / 1000);
    shape.forEach(([userChars, seq], t) => {
      const tid = id + '-t' + t;
      const ids = [];
      const add = (it) => { lt.items[it.id] = it; ids.push(it.id); };
      add({ type: 'userMessage', id: tid + '-u', clientId: null, content: [{ type: 'text', text: lorem.repeat(Math.max(1, Math.round(userChars / lorem.length))).slice(0, Math.max(40, userChars)), text_elements: [] }] });
      add({ type: 'reasoning', id: tid + '-r', summary: ['**Planning step ' + t + '**' + NL + NL + lorem], content: [] });
      let c = 0, m = 0;
      for (const s of seq) {
        if (s < 0) for (let k = 0; k < -s; k++) add(cmd(tid + '-c' + c++, c));
        else add({ type: 'agentMessage', id: tid + '-m' + m++, text: mdOf(s, t + m), phase: 'commentary', memoryCitation: null, delivery: null, questions: null });
      }
      const last = lt.items[ids[ids.length - 1]];
      if (last.type === 'agentMessage') last.phase = 'final_answer';
      lt.turnOrder.push(tid);
      lt.turns[tid] = { id: tid, status: 'completed', itemIds: ids, error: null, startedAt: now - 3600 + t * 60, completedAt: now - 3600 + t * 60 + 50, durationMs: 50000, diff: null, plan: null };
    });
    return lt;
  }
  function fileText(path, i) {
    const lines = [];
    for (let k = 0; k < 400; k++) lines.push(path.endsWith('.h') ? 'struct Field' + k + ' { uint32_t a; uint16_t b; }; // ' + lorem.slice(0, (k * 7) % 80) : k % 9 === 0 ? '## Heading ' + k : lorem.slice(0, 40 + ((k * 13) % 70)));
    return lines.join(NL);
  }

  function setupReal() {
    const RB = window.__board;
    const shapes = window.__boardShapes;
    const shapeList = Object.values(shapes);
    const s = TH.useThreads.getState();
    const threads = { ...s.threads }, live = { ...s.live }, owner = { ...s.owner };
    const drafts = { ...UI.useUI.getState().drafts };
    const windows = [];
    let n = 0;
    for (const w of RB.windows) {
      let threadId = w.threadId;
      if (threadId.startsWith('file:')) {
        const path = 'C:/work/real/' + threadId.slice(5).split(/[\\/]/).slice(-3).join('/');
        window.ret.world.fs.write(path, fileText(path, n));
        threadId = 'file:' + path;
      } else if (threadId.startsWith('draft:')) {
        drafts[threadId] = { projectKey: cwd.toLowerCase(), cwd, createdAt: Date.now() };
      } else {
        const shape = shapes[threadId] ?? shapeList[n % shapeList.length];
        threadId = 'real' + String(n).padStart(4, '0') + '-0000-4000-8000-000000000000';
        threads[threadId] = mkThread(threadId, n);
        owner[threadId] = 'codex';
        live[threadId] = mkLive(threadId, shape);
        n++;
      }
      windows.push({ ...w, threadId });
    }
    TH.useThreads.setState({ threads, live, owner });
    const board = { id: 'real', name: 'Real', windows, viewport: { ...RB.viewport } };
    UI.useUI.setState((st) => ({ drafts, boards: [...st.boards.filter((b) => b.id !== 'real' && b.id !== 'stress'), board], activeBoard: 'real', mode: 'canvas', focusedWindow: RB.focused, sidebarOpen: false, showLinks: false }));
    document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
    setTimeout(() => VP.viewport.load({ ...RB.viewport }), 300);
    return windows.length;
  }

  /** Threads nearest the view (on screen first), then far ones: `k` of them. */
  function streamTargets(k) {
    const vp = VP.viewport.vp;
    const { w, h } = VP.viewport.size;
    const cx = (w / 2 - vp.x) / vp.zoom, cy = (h / 2 - vp.y) / vp.zoom;
    const wins = UI.activeBoard().windows.filter((x) => x.threadId.startsWith('real'));
    const byDist = wins.slice().sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
    const near = Math.ceil(k / 2);
    return [...byDist.slice(0, near), ...byDist.slice(-(k - near))];
  }

  let timer = 0;
  let runs = [];
  /** Real-ish agent turns in `k` threads: reasoning, commands with output, commentary, a long reply. */
  function streamReal(k = 8, every = 16) {
    clearInterval(timer);
    const now = Math.floor(Date.now() / 1000);
    const stamp = Date.now();
    runs = streamTargets(k).map((w, i) => ({ threadId: w.threadId, turnId: w.threadId + '-live' + stamp, step: 0, seq: 0, pos: 0, phase: 'reason', item: null, src: mdOf(6000, i), n: 0 }));
    for (const r of runs) {
      TH.enqueueNotification('codex', 'turn/started', { threadId: r.threadId, turn: { id: r.turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: now, completedAt: null, durationMs: null } });
      TH.enqueueNotification('codex', 'thread/status/changed', { threadId: r.threadId, status: { type: 'active', activeFlags: [] } });
      TH.enqueueNotification('codex', 'item/started', { threadId: r.threadId, turnId: r.turnId, item: { type: 'userMessage', id: r.turnId + '-u', clientId: null, content: [{ type: 'text', text: 'Keep going: ' + lorem, text_elements: [] }] } });
    }
    timer = setInterval(() => {
      for (const r of runs) {
        r.n++;
        const id = r.turnId + '-' + r.seq;
        const send = (m, p) => TH.enqueueNotification('codex', m, { threadId: r.threadId, turnId: r.turnId, ...p });
        if (r.phase === 'reason') {
          send('item/reasoning/summaryTextDelta', { itemId: id, summaryIndex: 0, delta: lorem.slice(r.pos % 100, (r.pos % 100) + 8) });
          r.pos += 8;
          if (r.pos > 240) { r.phase = 'cmd'; r.pos = 0; r.seq++; }
        } else if (r.phase === 'cmd') {
          const c = cmd(id, r.seq);
          if (r.pos === 0) send('item/started', { item: { ...c, status: 'inProgress', aggregatedOutput: '', exitCode: null, durationMs: null } });
          else send('item/commandExecution/outputDelta', { itemId: id, delta: 'line ' + r.pos + ': ok src/module.ts' + NL });
          r.pos++;
          if (r.pos > 12) {
            send('item/completed', { item: c });
            r.pos = 0;
            r.seq++;
            if (r.seq % 5 === 0) r.phase = 'say';
          }
        } else {
          send('item/agentMessage/delta', { itemId: id, delta: r.src.slice(r.pos % r.src.length, (r.pos % r.src.length) + 6) });
          r.pos += 6;
          if (r.pos > 900) { r.phase = 'reason'; r.pos = 0; r.seq++; }
        }
        if (r.n % 60 === 0) TH.enqueueNotification('codex', 'thread/tokenUsage/updated', { threadId: r.threadId, tokenUsage: { total: { totalTokens: r.n * 100, inputTokens: r.n * 80, cachedInputTokens: r.n * 40, outputTokens: r.n * 20, reasoningOutputTokens: r.n * 5 }, last: { totalTokens: 1000, inputTokens: 50000 + r.n * 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 272000 } });
      }
    }, every);
    return runs.length;
  }
  function stopReal() {
    clearInterval(timer);
    const now = Math.floor(Date.now() / 1000);
    for (const r of runs) {
      TH.enqueueNotification('codex', 'thread/status/changed', { threadId: r.threadId, status: { type: 'idle' } });
      TH.enqueueNotification('codex', 'turn/completed', { threadId: r.threadId, turn: { id: r.turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: now, completedAt: now, durationMs: 1000 } });
    }
    runs = [];
  }

  // ---- interactions beyond pan/zoom ----------------------------------------------------------
  const el = (sel) => document.querySelector(sel);
  const center = (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  /** A visible window of the reference board (one of its threads, not a file); falls back to any drawn one. */
  function visibleWin() {
    const vp = VP.viewport.vp;
    const { w, h } = VP.viewport.size;
    const cx = (w / 2 - vp.x) / vp.zoom, cy = (h / 2 - vp.y) / vp.zoom;
    const wins = UI.activeBoard().windows.slice().sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
    for (const x of wins) {
      const e = document.querySelector('.cwin[data-win="' + x.id + '"]');
      if (e && !e.hasAttribute('data-culled') && x.threadId.startsWith('real')) return { win: x, el: e };
    }
    return null;
  }
  /** Drag a window by its title bar in a slow circle, with real pointer events. */
  function dragDrive() {
    const v = visibleWin();
    const head = v.el.querySelector('.pane-header');
    const r = head.getBoundingClientRect();
    const sx = r.left + 60, sy = r.top + r.height / 2;
    head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sx, clientY: sy, pointerId: 1, isPrimary: true }));
    let done = false;
    const drive = (t) => {
      if (done) return;
      const a = (t / 1000) * Math.PI;
      head.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sx + 300 * Math.sin(a), clientY: sy + 120 * (1 - Math.cos(a)), pointerId: 1, isPrimary: true }));
    };
    drive.end = () => { done = true; head.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: sx, clientY: sy, pointerId: 1, isPrimary: true })); };
    return drive;
  }
  function resizeDrive() {
    const v = visibleWin();
    const h = v.el.querySelector('.rz-se');
    const { x: sx, y: sy } = center(h);
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sx, clientY: sy, pointerId: 1, isPrimary: true }));
    let done = false;
    const drive = (t) => {
      if (done) return;
      const a = (t / 1200) * Math.PI;
      h.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sx + 200 * Math.sin(a), clientY: sy + 140 * Math.sin(a * 0.7), pointerId: 1, isPrimary: true }));
    };
    drive.end = () => { done = true; h.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: sx, clientY: sy, pointerId: 1, isPrimary: true })); };
    return drive;
  }
  /** Scroll a visible transcript up and down. */
  function scrollDrive() {
    const v = visibleWin();
    const tr = v.el.querySelector('.transcript');
    const top = tr.scrollTop;
    return (t) => { tr.scrollTop = Math.max(0, top - 1500 * (0.5 - 0.5 * Math.cos((t / 1000) * Math.PI))); };
  }
  /** Click through windows on screen, one focus change every ~250ms. */
  function focusDrive() {
    const vp = VP.viewport.vp;
    const { w, h } = VP.viewport.size;
    const onScreen = UI.activeBoard().windows.filter((x) => { const sx = x.x * vp.zoom + vp.x, sy = x.y * vp.zoom + vp.y; return sx < w && sy < h && sx + x.w * vp.zoom > 0 && sy + x.h * vp.zoom > 0; });
    let last = -1;
    return (t) => {
      const i = Math.floor(t / 250);
      if (i === last || !onScreen.length) return;
      last = i;
      const x = onScreen[i % onScreen.length];
      const e = document.querySelector('.cwin[data-win="' + x.id + '"]');
      const head = e && e.querySelector('.pane-header, .tcard');
      if (!head) return;
      const r = head.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: r.left + 40, clientY: r.top + 10, pointerId: 1, isPrimary: true };
      head.dispatchEvent(new PointerEvent('pointerdown', o));
      head.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    };
  }
  /** Type into the focused window's composer, a character every frame. */
  function typeDrive() {
    const v = visibleWin();
    UI.useUI.setState({ focusedWindow: v.win.id });
    const ta = v.el.querySelector('.composer textarea');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    let text = '';
    return (t, i) => {
      text = i % 120 === 119 ? '' : text + 'abcdefghij '[i % 11];
      setter.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    };
  }
  /** Fly across the board (a beacon click or fit-all), the way animateTo does. */
  function flyDrive() {
    const wins = UI.activeBoard().windows;
    const { w, h } = VP.viewport.size;
    let k = 0, last = -1;
    return (t) => {
      const i = Math.floor(t / 700);
      if (i === last) return;
      last = i;
      const x = wins[(k += 37) % wins.length];
      VP.viewport.animateTo(VP.viewport.fitRect(x, w, h, 40, 1));
    };
  }

  async function measureDrive(label, ms, make) {
    const drive = make();
    const r = await S.measure(label, ms, drive);
    if (drive.end) drive.end();
    return r;
  }

  async function realSuite(opts = {}) {
    const res = [];
    const home = { ...window.__board.viewport };
    const go = async (ms = 800) => { VP.viewport.load(home); await S.settle(ms); };
    const k = opts.k ?? 8;
    await go(1500);
    res.push(await S.measure('idle', 2000));
    res.push(await S.measure('pan', 3000, S.panDrive()));
    await go(600);
    res.push(await S.measure('zoom', 3000, S.zoomDrive()));
    await go(600);
    res.push(await S.measure('zoom-cards', 3000, S.zoomCardsDrive()));
    await go(600);
    res.push(await measureDrive('drag', 2500, dragDrive));
    await go(600);
    res.push(await measureDrive('resize', 2500, resizeDrive));
    await go(600);
    res.push(await measureDrive('focus', 2500, focusDrive));
    await go(600);
    res.push(await measureDrive('fly', 3500, flyDrive));
    await go(1500);
    streamReal(k);
    await S.settle(1500);
    res.push(await S.measure('stream-idle', 3000));
    res.push(await S.measure('stream-pan', 3000, S.panDrive()));
    await go(400);
    res.push(await S.measure('stream-zoom', 3000, S.zoomDrive()));
    await go(400);
    res.push(await S.measure('stream-cards', 3000, S.zoomCardsDrive()));
    await go(400);
    res.push(await measureDrive('stream-drag', 2500, dragDrive));
    await go(400);
    res.push(await measureDrive('stream-focus', 2500, focusDrive));
    await go(400);
    res.push(await measureDrive('stream-scroll', 2500, scrollDrive));
    await go(400);
    res.push(await measureDrive('stream-type', 2500, typeDrive));
    await go(400);
    res.push(await measureDrive('stream-fly', 3500, flyDrive));
    stopReal();
    return res;
  }

  function pauseReal() { clearInterval(timer); }
  Object.assign(S, { mkLive, mkThread, pauseReal, setupReal, streamReal, stopReal, realSuite, dragDrive, resizeDrive, scrollDrive, focusDrive, typeDrive, flyDrive, measureDrive, visibleWin });
})();
