// Live computer-use steps through the demo engine (JSON over the wire, then the app's own handling:
// captureLive keeps the screenshot as a blob and drops it from the item).
window.__cu = (() => {
  const NL = String.fromCharCode(10);
  const id = 'cuwin001-0000-4000-8000-000000000000';
  const eng = () => window.ret.world.engines.codex;
  const now = () => Math.floor(Date.now() / 1000);
  const surface = (app) => ({ 'codex/toolSurface': { kind: 'computerUse', app: { kind: 'appId', appId: app[0] } } });
  function startTurn(turnId) {
    eng().notify('turn/started', { threadId: id, turn: { id: turnId, items: [], itemsView: 'summary', status: 'inProgress', error: null, startedAt: now(), completedAt: null, durationMs: null } });
    eng().notify('thread/status/changed', { threadId: id, status: { type: 'active', activeFlags: [] } });
  }
  function endTurn(turnId) {
    eng().notify('thread/status/changed', { threadId: id, status: { type: 'idle' } });
    eng().notify('turn/completed', { threadId: id, turn: { id: turnId, items: [], itemsView: 'summary', status: 'completed', error: null, startedAt: now() - 30, completedAt: now(), durationMs: 30000 } });
  }
  /** One step: started (no result yet), then completed with the window's text and a whole screenshot. */
  function step(turnId, k, app, shot) {
    const item = { type: 'mcpToolCall', id: turnId + '-s' + k, server: 'cua_repl', tool: 'exec', status: 'inProgress', arguments: { title: 'Look at ' + app[1] + ' (' + k + ')', code: 'await computer.screenshot();' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
    eng().notify('item/started', { threadId: id, turnId, item });
    const result = { content: [{ type: 'text', text: 'App: ' + app[1] + '.' + NL + 'Window: "' + app[1] + ' window ' + k + '"' }, { type: 'image', data: shot, mimeType: 'image/png' }], structuredContent: null, _meta: surface(app) };
    eng().notify('item/completed', { threadId: id, turnId, item: { ...item, status: 'completed', result, durationMs: 700 } });
  }
  return { id, startTurn, endTurn, step };
})();
'cu ready';
