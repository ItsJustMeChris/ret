// Computer use, setup: six 1600x900 window screenshots (PNG), and two threads with ~800 cua_repl steps
// of history each (12 turns), in history's form: results with a screenshot serialized into one text
// block (every 4th twice over), the screenshot cut short.
(async () => {
  const { TH } = window.__ret;
  const world = window.ret.world;
  const NL = String.fromCharCode(10);
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  // A window-like picture: title bar, sidebar, rows of text, a photo-ish area (so it compresses like a real one).
  async function shot(seed) {
    const c = new OffscreenCanvas(1600, 900);
    const g = c.getContext('2d');
    g.fillStyle = '#f4f4f6'; g.fillRect(0, 0, 1600, 900);
    g.fillStyle = '#dcdce2'; g.fillRect(0, 0, 1600, 38);
    g.fillStyle = '#e9e9ee'; g.fillRect(0, 38, 260, 862);
    g.font = '15px sans-serif';
    for (let r = 0; r < 40; r++) {
      g.fillStyle = r % 2 ? '#222' : '#555';
      g.fillText('Item ' + (r + seed * 7) + '   Modified ' + (r * 3 % 28 + 1) + ' Oct 2026   ' + (r * 37 % 900) + ' KB   folder/sub/file-' + r + '.txt', 280, 64 + r * 20);
      if (r < 30) g.fillText('Sidebar entry ' + r, 16, 64 + r * 26);
    }
    const img = g.createImageData(520, 340);
    for (let i = 0; i < img.data.length; i += 4) {
      const p = i / 4, x = p % 520, y = Math.floor(p / 520);
      const v = 128 + 60 * Math.sin((x + seed * 40) / 23) * Math.cos(y / 17) + ((x * 7 + y * 13 + seed) % 23);
      img.data[i] = v; img.data[i + 1] = (v * 0.8 + y / 3) & 255; img.data[i + 2] = (v * 0.6 + x / 4) & 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 1040, 480);
    const b = await c.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const shots = [];
  for (let i = 0; i < 6; i++) shots.push(await shot(i));
  window.__cuShots = shots;
  const APPS = [['com.apple.finder', 'Finder'], ['com.apple.Safari', 'Safari'], ['com.microsoft.VSCode', 'Code']];
  window.__cuApps = APPS;
  const surface = (k) => ({ 'codex/toolSurface': { kind: 'computerUse', app: { kind: 'appId', appId: APPS[k % 3][0] } } });
  const out = (k) => 'App: ' + APPS[k % 3][1] + '.' + NL + 'Window: "Window ' + (k % 17) + '"' + NL + 'Clicked at (412, 233). '.repeat(8);
  function step(tid, k) {
    const base = { type: 'mcpToolCall', id: tid + '-cu' + k, server: 'cua_repl', tool: 'exec', status: 'completed', arguments: { title: 'Step ' + k, code: 'await computer.click(412, 233);' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, error: null, durationMs: 800 };
    if (k % 2) return { ...base, result: { content: [{ type: 'text', text: out(k) }], structuredContent: null, _meta: surface(k) } };
    const s = shots[k % 6];
    const cut = s.slice(0, 1800) + '\u2026<' + (s.length - 1900) + ' chars truncated>\u2026' + s.slice(-100);
    let text = JSON.stringify({ content: [{ type: 'text', text: out(k) }, { type: 'image', data: cut, mimeType: 'image/png' }], _meta: surface(k) });
    if (k % 4 === 0) text = JSON.stringify({ content: [{ type: 'text', text }], _meta: null });
    return { ...base, result: { content: [{ type: 'text', text }], structuredContent: null, _meta: null } };
  }
  const now = Math.floor(Date.now() / 1000);
  function history(id, nTurns, perTurn) {
    const p = id.slice(0, 8);
    const turns = [];
    let k = 0;
    for (let t = 0; t < nTurns; t++) {
      const items = [{ type: 'userMessage', id: p + '-t' + t + '-u', clientId: null, content: [{ type: 'text', text: 'Go through the app and fix the settings, part ' + t, text_elements: [] }] }];
      for (let i = 0; i < perTurn; i++) items.push(step(p + '-t' + t, k++));
      items.push({ type: 'agentMessage', id: p + '-t' + t + '-m', text: 'Done with part ' + t + '.', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
      turns.push({ id: p + '-t' + t, rootTurnId: null, items, itemsView: 'full', status: 'completed', error: null, startedAt: now - 9000 + t * 600, completedAt: now - 9000 + t * 600 + 500, durationMs: 500000 });
    }
    return turns;
  }
  const base = [...world.threads.values()].find((t) => t.provider === 'codex');
  const reg = (id, name) => {
    const turns = history(id, 12, 67);
    const meta = { ...base.meta, id, sessionId: id, name, preview: name, updatedAt: now, recencyAt: now, cwd: 'C:/work/real' };
    world.threads.set(id, { ...base, meta, turns, plans: {}, run: null, subscribed: false, failed: false, next: null, away: false });
    TH.useThreads.setState((s) => ({ threads: { ...s.threads, [id]: { ...meta, turns: [] } }, owner: { ...s.owner, [id]: 'codex' } }));
    return turns;
  };
  const a = reg('cuhist01-0000-4000-8000-000000000000', 'Computer use (history)');
  reg('cuwin001-0000-4000-8000-000000000000', 'Computer use');
  // The page as the engine sends it: newest first.
  window.__cuPage = JSON.stringify(a.slice().reverse());
  const steps = a.reduce((n, t) => n + t.items.filter((i) => i.type === 'mcpToolCall').length, 0);
  return { shotKB: shots.map((s) => Math.round((s.length * 3) / 4 / 1024)), pageMB: Math.round(window.__cuPage.length / 1e5) / 10, steps };
})()
