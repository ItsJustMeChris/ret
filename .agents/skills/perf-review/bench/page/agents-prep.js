// Subagents, setup. A parent (a window in the middle of the view, made big) with 20 agents, 8 of them
// running; ~300 more threads in the sidebar (open); the external poll on (the page is told it has
// focus; the window itself isn't focused) against an engine that lists agents by ancestor as Codex does.
// With window.__agControl set, the 20 are plain threads instead (no parent): the same load without
// anything subagent-specific.
(async () => {
  const { UI, TH, VP } = window.__ret;
  const N = window.__nav;
  const world = window.ret.world;
  const control = !!window.__agControl;
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  const now = Math.floor(Date.now() / 1000);
  const base = [...world.threads.values()].find((t) => t.provider === 'codex');
  // The parent: the board window nearest the view's centre, made big there.
  const RB = window.__board.viewport;
  const { w: W, h: H } = VP.viewport.size;
  const cx = (W / 2 - RB.x) / RB.zoom, cy = (H / 2 - RB.y) / RB.zoom;
  const wins = UI.activeBoard().windows.filter((w) => w.threadId.startsWith('real'));
  const pw = wins.slice().sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))[0];
  const parent = pw.threadId;
  const ww = Math.round(Math.min(W * 0.7, 1100) / RB.zoom), wh = Math.round(Math.min(H * 0.85, 900) / RB.zoom);
  UI.updateBoard((b) => ({ ...b, windows: b.windows.map((x) => (x.id === pw.id ? { ...x, x: cx - ww / 2, y: cy - wh / 2, w: ww, h: wh, z: 99999 } : x)) }));
  // ~300 more threads across 12 projects, some forks.
  const threads = {}, owner = {};
  for (let i = 0; i < 300; i++) {
    const id = 'side' + String(i).padStart(4, '0') + '-0000-4000-8000-000000000000';
    threads[id] = { ...base.meta, id, sessionId: id, name: 'Side thread ' + i, preview: 'Side thread ' + i, cwd: 'C:/work/proj' + (i % 12), updatedAt: now - i * 90, recencyAt: now - i * 90, createdAt: now - i * 90 - 3600, forkedFromId: i % 9 === 4 ? 'side' + String(i - 1).padStart(4, '0') + '-0000-4000-8000-000000000000' : null, status: { type: 'notLoaded' }, turns: [] };
    owner[id] = 'codex';
  }
  // The 20 agents.
  const agents = [];
  TH.useThreads.getState().threads[parent] && (TH.useThreads.getState().threads[parent].updatedAt = now);
  for (let i = 0; i < 20; i++) {
    const id = 'agent' + String(i).padStart(3, '0') + '-0000-4000-8000-000000000000';
    const source = control ? 'cli' : { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/agent' + i, agent_nickname: 'agent-' + i, agent_role: i % 2 ? 'explorer' : 'worker' } } };
    const meta = { ...base.meta, id, sessionId: id, name: null, preview: 'Subtask ' + i, cwd: 'C:/work/real', source, agentNickname: control ? null : 'agent-' + i, agentRole: control ? null : i % 2 ? 'explorer' : 'worker', createdAt: now - 600 + i, updatedAt: now, recencyAt: now, status: { type: i < 8 ? 'active' : 'idle', ...(i < 8 ? { activeFlags: [] } : {}) }, turns: [] };
    threads[id] = meta;
    owner[id] = 'codex';
    agents.push(id);
    world.threads.set(id, { ...base, meta: { ...meta }, turns: [], plans: {}, run: null, subscribed: false, failed: false, next: null, away: false });
  }
  TH.useThreads.setState((s) => ({ threads: { ...s.threads, ...threads }, owner: { ...s.owner, ...owner } }));
  window.__agents = agents;
  window.__agParent = parent;
  // The engine lists agents by ancestor, as Codex does (the demo would list everything).
  const eng = world.engines.codex;
  const calls = (window.__agCalls = {});
  if (!eng.__wrapped) {
    const orig = eng.call.bind(eng);
    eng.call = async (method, p) => {
      const k = method + (p?.ancestorThreadId ? ' (by ancestor)' : '');
      calls[k] = (calls[k] || 0) + 1;
      if (method === 'thread/list' && p?.ancestorThreadId) {
        const data = world.owned('codex').filter((t) => t.meta.source?.subAgent?.thread_spawn?.parent_thread_id === p.ancestorThreadId).map((t) => eng.threadOut(t));
        return { data: data.slice(0, p.limit ?? 100), nextCursor: null, backwardsCursor: null };
      }
      return orig(method, p);
    };
    eng.__wrapped = true;
  }
  // The external poll runs every 3 s while the page has focus. (No focus event: that also reloads the
  // thread list, which would drop the threads this harness made up. The poll picks up the faster
  // pace at its next round, within 12 s.)
  document.hasFocus = () => true;
  UI.useUI.setState({ sidebarOpen: true });
  VP.viewport.load({ ...RB });
  await N.wait(13000);
  const pane = document.querySelector('.thread-pane[data-thread="' + parent + '"]');
  return { control, threads: Object.keys(TH.useThreads.getState().threads).length, agentsIndexed: (TH.useThreads.getState().agents?.[parent] ?? []).length, trayRows: pane?.querySelectorAll('.agent-row').length ?? -1, sidebarRows: document.querySelectorAll('.sidebar .thread-row, .sidebar [data-thread]').length };
})()
