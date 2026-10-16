// Measured: 8 agents streaming (reasoning, commands, replies, like the canvas streaming runs) for 5 s,
// while other agents' names change every 250 ms (each a change to `threads`: the agents index and the
// sidebar's project tree are rebuilt), with the parent's tray open and the external poll running.
(async () => {
  const { TH } = window.__ret;
  const N = window.__nav;
  const NL = String.fromCharCode(10);
  const agents = window.__agents;
  const lorem = 'The quick brown fox jumps over the lazy dog while the rate limiter counts tokens per window. ';
  const send = (m, p) => TH.enqueueNotification('codex', m, p);
  const nowS = () => Math.floor(Date.now() / 1000);
  const runs = agents.slice(0, 8).map((id, i) => ({ id, turn: id.slice(0, 8) + '-live', seq: 0, pos: 0, phase: i % 3 }));
  for (const r of runs) {
    send('turn/started', { threadId: r.id, turn: { id: r.turn, items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: nowS(), completedAt: null, durationMs: null } });
    send('thread/status/changed', { threadId: r.id, status: { type: 'active', activeFlags: [] } });
  }
  const calls0 = { ...window.__agCalls };
  const loaf = [];
  const po = new PerformanceObserver((l) => loaf.push(...l.getEntries()));
  po.observe({ type: 'long-animation-frame' });
  const timer = setInterval(() => {
    for (const r of runs) {
      const item = r.turn + '-' + r.seq;
      const at = { threadId: r.id, turnId: r.turn };
      if (r.phase === 0) {
        send('item/reasoning/summaryTextDelta', { ...at, itemId: item, summaryIndex: 0, delta: lorem.slice(r.pos % 80, (r.pos % 80) + 8) });
        if ((r.pos += 8) > 200) { r.phase = 1; r.pos = 0; r.seq++; }
      } else if (r.phase === 1) {
        if (r.pos === 0) send('item/started', { ...at, item: { type: 'commandExecution', id: item, pluginId: null, scriptPath: null, command: 'rg -n thing src', cwd: 'C:/work/real', processId: null, source: 'agent', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: '', exitCode: null, durationMs: null } });
        else send('item/commandExecution/outputDelta', { ...at, itemId: item, delta: 'line ' + r.pos + ': ok' + NL });
        if (++r.pos > 12) { send('item/completed', { ...at, item: { type: 'commandExecution', id: item, pluginId: null, scriptPath: null, command: 'rg -n thing src', cwd: 'C:/work/real', processId: null, source: 'agent', status: 'completed', commandActions: [{ type: 'unknown', command: 'rg' }], aggregatedOutput: 'ok', exitCode: 0, durationMs: 120 } }); r.pos = 0; r.seq++; r.phase = 2; }
      } else {
        send('item/agentMessage/delta', { ...at, itemId: item, delta: lorem.slice(r.pos % 80, (r.pos % 80) + 6) });
        if ((r.pos += 6) > 600) { r.phase = 0; r.pos = 0; r.seq++; }
      }
    }
  }, 16);
  let n = 0;
  const churn = setInterval(() => {
    const id = agents[8 + (n % 12)];
    send('thread/name/updated', { threadId: id, threadName: n % 2 ? null : 'renamed ' + n });
    n++;
  }, 250);
  await N.wait(5000);
  clearInterval(timer);
  clearInterval(churn);
  po.disconnect();
  for (const r of runs) {
    send('thread/status/changed', { threadId: r.id, status: { type: 'idle' } });
    send('turn/completed', { threadId: r.id, turn: { id: r.turn, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: nowS() - 5, completedAt: nowS(), durationMs: 5000 } });
  }
  const calls = {};
  for (const [k, v] of Object.entries(window.__agCalls)) if (v - (calls0[k] || 0)) calls[k] = v - (calls0[k] || 0);
  const pane = document.querySelector('.thread-pane[data-thread="' + window.__agParent + '"]');
  return { threadChanges: n, rpcDuring5s: calls, trayHead: pane?.querySelector('.agent-tray-head')?.textContent ?? null, trayRows: pane?.querySelectorAll('.agent-row').length ?? 0, longFrames: loaf.length, worst: Math.round(Math.max(0, ...loaf.map((e) => e.duration))) };
})()
