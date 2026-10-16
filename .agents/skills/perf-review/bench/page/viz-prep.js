// Codex visualizations in the windows on screen: the last reply in each ends with a `visualize`
// content reference, shown in a sandboxed frame. The frame document stands in for the skill's
// runtime (its host bridge reports the height over the MessagePort, as the real one does) around an
// SVG chart and a table. Set window.__vizDoc in an earlier step to use another document (the real
// runtime, say); window.__vizAnim = true (js-viz-anim) adds an always-running animation, as a
// fragment the model wrote can have; window.__vizCount sets how many windows get one (8), and
// window.__vizStyle adds CSS to the page (to try a fix). Load events are counted in window.__vizLoads.
(async () => {
  const { TH, UI, VP } = window.__ret;
  const N = window.__nav;
  const K = window.__vizCount || 8;
  const NL = String.fromCharCode(10);
  const rows = Array.from({ length: 8 }, (_, i) => '<tr><td>worker-' + i + '</td><td>' + (120 + i * 17) + ' req/h</td><td>' + (i % 3 ? 'ok' : 'slow') + '</td></tr>').join('');
  const bars = Array.from({ length: 48 }, (_, i) => {
    const h = 20 + ((i * 37) % 100);
    return '<rect x="' + (i * 12 + 30) + '" y="' + (140 - h) + '" width="9" height="' + h + '" rx="2" fill="#4c8dff"/>';
  }).join('');
  const doc =
    window.__vizDoc ||
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{margin:0;font:13px system-ui;color:#ddd;background:transparent}.card{padding:12px 14px;border:1px solid #333;border-radius:10px}' +
      '.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3c3;' + (window.__vizAnim ? 'animation:p 1.2s ease-in-out infinite alternate;' : '') + '}' +
      '@keyframes p{from{transform:scale(.6);opacity:.5}to{transform:scale(1.2);opacity:1}}table{border-collapse:collapse;width:100%}td{padding:3px 6px;border-top:1px solid #333}' +
      '</style></head><body><div class="card"><h3>Requests per hour <span class="pulse"></span></h3><svg viewBox="0 0 620 160" width="100%">' + bars +
      '<line x1="30" y1="140" x2="610" y2="140" stroke="#666"/></svg><table>' + rows + '</table></div><script>' +
      'addEventListener("message",(e)=>{if(e.data&&e.data.type==="codex-visualization-initialize"&&e.ports[0]){const port=e.ports[0];' +
      'const send=()=>port.postMessage({type:"height",height:document.documentElement.scrollHeight});new ResizeObserver(send).observe(document.body);send();}});' +
      '</scr' + 'ipt></body></html>';
  window.ret.files.visualization = async () => ({ html: doc });
  if (window.__vizStyle) document.head.appendChild(Object.assign(document.createElement('style'), { textContent: window.__vizStyle }));

  const RB = window.__board.viewport;
  const { w: W, h: H } = VP.viewport.size;
  const onScreen = (w) => {
    const x = w.x * RB.zoom + RB.x, y = w.y * RB.zoom + RB.y;
    return x < W && x + w.w * RB.zoom > 0 && y < H && y + w.h * RB.zoom > 0;
  };
  const s = TH.useThreads.getState();
  const live = {};
  const picked = [];
  for (const w of UI.activeBoard().windows.filter(onScreen)) {
    if (picked.length >= K) break;
    const lt = s.live[w.threadId];
    const turn = lt && lt.turns[lt.turnOrder[lt.turnOrder.length - 1]];
    const last = turn && [...turn.itemIds].reverse().map((id) => lt.items[id]).find((it) => it && it.type === 'agentMessage');
    if (!last) continue;
    const ref = String.fromCharCode(0xe200) + 'visualize' + String.fromCharCode(0xe202) + JSON.stringify({ path: 'C:/work/viz/chart-' + picked.length + '.html', title: 'Requests per hour ' + picked.length }) + String.fromCharCode(0xe201);
    live[w.threadId] = { ...lt, items: { ...lt.items, [last.id]: { ...last, text: last.text + NL + NL + ref } } };
    picked.push(w.threadId);
  }
  TH.useThreads.setState({ live: { ...s.live, ...live } });
  window.__vizLoads = 0;
  const counted = new WeakSet();
  let frames = [];
  for (let i = 0; i < 100; i++) {
    await N.wait(100);
    frames = [...document.querySelectorAll('.viz-frame')];
    for (const f of frames) {
      if (counted.has(f)) continue;
      counted.add(f);
      window.__vizLoads++;
      f.addEventListener('load', () => window.__vizLoads++);
    }
    if (frames.length >= picked.length && frames.every((f) => f.style.height)) break;
  }
  await N.wait(1500);
  return { windows: picked.length, frames: frames.length, sized: frames.filter((f) => f.style.height).length, heights: frames.map((f) => f.style.height), errors: document.querySelectorAll('.viz-error').length };
})()
