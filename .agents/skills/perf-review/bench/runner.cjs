// Electron side of the bench (bench.mjs starts it): serves a demo build of Ret, opens it in a window off
// screen, sets up a board, and runs a measurement. Usage:
//   electron runner.cjs <dist> <kind>.<step>[+<step>...] [real|<N>|demo]
// Board: "real" (default) is the reference board (page/board-data.js, 102 windows); a number builds a
// uniform synthetic board of that many windows; "demo" leaves the demo's own small board.
// A step is a scenario below, or js-<name> for page/<name>.js. Kinds:
//   cpu      each step traced on its own: main-thread CPU per frame (p50/p95/p99), stage totals.
//   trace    the last step traced (the others run first); WORST=<n> breaks down the n longest tasks,
//            EVENTS=a,b sums those trace events per thread (main, worker, compositor, gpu);
//            KEEP_TRACE=1 keeps the trace file (in OUT) to open in DevTools.
//   profile  the last step under the JS sampling profiler: self time by function.
//   hang     starts the last step, then pauses the page with the debugger and prints the stack.
//   run      the steps in order, printing what each returns; also shot<name> (screenshot),
//            wait<ms>, mode-<focus|canvas|code|inbox>.
// Env: WARM (ms after setup before measuring, default 20000), OUT (where traces and shots go),
// W/H (window size, 1600x1000), BOOST=0 (don't raise process priority), SHOW=1 (on screen, for
// machines that don't render off-screen windows).
const { app, BrowserWindow, contentTracing } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.resolve(process.argv[2]);
const mode = process.argv[3] || 'cpu.rstream';
const boardArg = process.argv[4] || 'real';
const REAL = boardArg === 'real';
const N = REAL ? 0 : boardArg === 'demo' ? 0 : Number(boardArg);
const W = Number(process.env.W || 1600), H = Number(process.env.H || 1000);
const OUT = process.env.OUT || path.join(os.tmpdir(), 'ret-bench', 'out');
const PAGE = path.join(__dirname, 'page');
fs.mkdirSync(OUT, { recursive: true });
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.setPath('userData', path.join(os.tmpdir(), 'ret-bench', 'userdata'));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(dist, u === '/' ? 'index.html' : u);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (name) => fs.readFileSync(path.join(PAGE, name + '.js'), 'utf8');

// Steps that put the view back where the board keeps it.
const home = REAL ? 'window.__ret.VP.viewport.load({ ...window.__board.viewport })' : N > 0 ? 'window.__ret.VP.viewport.load({ x: 20, y: 20, zoom: 0.8 })' : '0';

// Each measures 2.5–3.5 s with the harness's rAF loop and returns { fps, p50, p95, ... } (frame
// intervals); the cpu kind reads the trace instead. "stream" ones run 8 agents' turns into the board.
const S = 'window.__stress';
const streaming = (inner) => `(${S}.streamReal(8), ${S}.settle(1500).then(() => ${inner}).then((r) => (${S}.stopReal(), r)))`;
const scenarios = {
  // Canvas, nothing streaming.
  rpan: `${S}.measure("pan", 3000, ${S}.panDrive())`,
  rzoom: `${S}.measure("zoom", 3000, ${S}.zoomDrive())`,
  rcards: `${S}.measure("zoom-cards", 3000, ${S}.zoomCardsDrive())`,
  rdrag: `${S}.measureDrive("drag", 2500, ${S}.dragDrive)`,
  rresize: `${S}.measureDrive("resize", 2500, ${S}.resizeDrive)`,
  rfocus: `${S}.measureDrive("focus", 2500, ${S}.focusDrive)`,
  rfly: `${S}.measureDrive("fly", 3500, ${S}.flyDrive)`,
  // The same with 8 agents streaming (reasoning, commands, replies) into the board.
  rstream: streaming(`${S}.measure("stream-idle", 3000)`),
  rstreampan: streaming(`${S}.measure("stream-pan", 3000, ${S}.panDrive())`),
  rstreamzoom: streaming(`${S}.measure("stream-zoom", 3000, ${S}.zoomDrive())`),
  rstreamcards: streaming(`${S}.measure("stream-cards", 3000, ${S}.zoomCardsDrive())`),
  rstreamdrag: streaming(`${S}.measureDrive("stream-drag", 2500, ${S}.dragDrive)`),
  rstreamfocus: streaming(`${S}.measureDrive("stream-focus", 2500, ${S}.focusDrive)`),
  rstreamtype: streaming(`${S}.measureDrive("stream-type", 2500, ${S}.typeDrive)`),
  rstreamscroll: streaming(`${S}.measureDrive("stream-scroll", 2500, ${S}.scrollDrive)`),
  rstreamfly: streaming(`${S}.measureDrive("stream-fly", 3500, ${S}.flyDrive)`),
  // 8 turns running (shimmers, pings, timers) but no text arriving: what animations cost at rest.
  rlive: `(${S}.streamReal(8), ${S}.settle(2500).then(() => (${S}.pauseReal(), ${S}.settle(1200))).then(() => ${S}.measure("live-still", 3000)).then((r) => (${S}.stopReal(), r)))`,
  // Nothing happening at all: should be ~0 frames and ~0 script.
  still: `${S}.settle(3000).then(() => "still 3s")`,
  // The demo fits the board to the window until the view is touched: a right press counts.
  touch: '(document.querySelector(".canvas-viewport").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 })), "touched")',
  // What's animating right now, by animation and element.
  anims: '(() => { const out = {}; for (const a of document.getAnimations()) { const t = a.effect && a.effect.target; const pe = (a.effect && a.effect.pseudoElement) || ""; const cls = t ? String(t.className && t.className.baseVal !== undefined ? t.className.baseVal : t.className).split(" ").slice(0, 2).join(".") : "?"; const k = (a.animationName || a.transitionProperty || a.constructor.name) + " @ " + cls + pe + " " + a.playState; out[k] = (out[k] || 0) + 1; } return out; })()',
  // Windows: how many, culled, with their full view built.
  layers: '(() => { const all = [...document.querySelectorAll(".cwin")]; return { windows: all.length, culled: all.filter((e) => e.hasAttribute("data-culled")).length, built: all.filter((e) => e.querySelector(".thread-pane")).length }; })()',
};
const stepCode = (sc) => (sc.startsWith('js-') ? page(sc.slice(3)) : scenarios[sc] ?? (() => { throw new Error('unknown step ' + sc); })());

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const show = process.env.SHOW === '1';
  const win = new BrowserWindow({ x: show ? 0 : -6000, y: show ? 0 : -6000, width: W, height: H, show: false, focusable: false, skipTaskbar: true, frame: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  if (!show) win.setPosition(-6000, -6000);
  win.webContents.on('console-message', (e) => {
    const m = e.message ?? e;
    if (typeof m === 'string' && /error/i.test(m)) console.error('[page]', m.slice(0, 300));
  });
  await win.loadURL(`http://127.0.0.1:${port}/index.html?mode=canvas&theme=dark`);
  const js = (s) => win.webContents.executeJavaScript(s, true);
  // A busy machine: give this run's own processes (browser, renderer, GPU) a head start.
  const boost = () => {
    for (const m of app.getAppMetrics()) {
      try {
        os.setPriority(m.pid, os.constants.priority.PRIORITY_HIGH);
      } catch {}
    }
  };
  if (process.env.BOOST !== '0') {
    boost();
    setTimeout(boost, 3000);
  }
  for (let i = 0; i < 150 && !(await js('!!window.__ret && !!document.querySelector(".canvas-viewport")')); i++) await sleep(100);
  for (const f of ['harness', 'board-data', 'board', 'nav']) await js(page(f));
  if (REAL) await js(`${S}.setupReal()`);
  else if (N > 0) await js(`${S}.setup(${N}, 6, 12)`);
  // Windows keep being built in idle time for a while after setup: measuring early measures that too.
  await sleep(Number(process.env.WARM || 20000));
  const gpu = await js('(() => { const c = document.createElement("canvas").getContext("webgl"); const d = c && c.getExtension("WEBGL_debug_renderer_info"); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : "?"; })()');
  const dom = await js('document.getElementsByTagName("*").length');
  console.log(JSON.stringify({ setup: true, gpu, dom, board: boardArg }));

  const [kind, ...rest] = mode.split('.');
  const steps = rest.join('.').split('+');
  const last = steps[steps.length - 1];
  const resetView = async () => {
    await js(`${S}.settle(400).then(() => ${home})`);
    await sleep(800);
  };
  // Every kind but run and cpu: the steps before the last one first, as setup.
  if (kind !== 'run' && kind !== 'cpu') {
    for (const sc of steps.slice(0, -1)) {
      console.log(JSON.stringify(await js(stepCode(sc))));
      if (!sc.startsWith('js-')) await resetView();
    }
  }

  if (kind === 'run') {
    for (const sc of steps) {
      if (sc.startsWith('shot')) {
        await sleep(300);
        const img = await win.webContents.capturePage();
        const f = path.join(OUT, sc + '.png');
        fs.writeFileSync(f, img.toPNG());
        console.log(JSON.stringify({ saved: f }));
      } else if (sc.startsWith('wait')) await sleep(Number(sc.slice(4)) || 1000);
      else if (sc.startsWith('mode-')) {
        await js(`window.__ret.UI.useUI.setState({ mode: '${sc.slice(5)}' })`);
        await sleep(1200);
      } else {
        console.log(JSON.stringify(await js(stepCode(sc))));
        if (!sc.startsWith('js-') && !process.env.NORESET) await resetView();
      }
    }
  } else if (kind === 'cpu') {
    // Each step traced on its own. CPU time (tdur, not wall time) per produced frame, which holds up on a
    // busy machine far better than frame rates; stage totals say where it went.
    for (const sc of steps) {
      if (!sc.startsWith('js-')) await resetView();
      await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'v8.execute'] });
      const res = await js(stepCode(sc));
      const file = await contentTracing.stopRecording(path.join(OUT, 'cpu-' + process.pid + '.json'));
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file);
      const events = data.traceEvents || data;
      const tn = new Map();
      for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') tn.set(`${e.pid}:${e.tid}`, e.args.name);
      const thread = (e) => tn.get(`${e.pid}:${e.tid}`) || '?';
      // The measured window: from the renderer's first BeginMainFrame to its last.
      const main = events.filter((e) => e.ph === 'X' && thread(e) === 'CrRendererMain');
      const bmf = main.filter((e) => e.name === 'ProxyMain::BeginMainFrame').sort((a, b) => a.ts - b.ts);
      const t0 = bmf.length ? bmf[0].ts : 0, t1 = bmf.length ? bmf[bmf.length - 1].ts + bmf[bmf.length - 1].dur : 0;
      const inWin = (e) => e.ts >= t0 && e.ts <= t1;
      const sumT = (arr) => arr.reduce((s, e) => s + (e.tdur ?? e.dur), 0) / 1000;
      const tasks = main.filter((e) => e.name === 'RunTask' && inWin(e));
      const by = (name) => sumT(main.filter((e) => e.name === name && inWin(e)));
      const gpuTasks = events.filter((e) => e.ph === 'X' && thread(e) === 'CrGpuMain' && e.name === 'RunTask' && inWin(e));
      // Main-thread CPU between consecutive frames.
      const iv = [];
      for (let i = 1; i < bmf.length; i++) iv.push(sumT(tasks.filter((e) => e.ts >= bmf[i - 1].ts && e.ts < bmf[i].ts)));
      iv.sort((a, b) => a - b);
      const q = (p) => (iv.length ? Math.round(iv[Math.min(iv.length - 1, Math.floor(iv.length * p))] * 100) / 100 : 0);
      const r2 = (v) => Math.round(v * 100) / 100;
      const out = typeof res === 'object' && res && res.fps ? { fps: res.fps, frameP95: res.p95, longFrames: res.loafs } : res;
      console.log(JSON.stringify({ step: sc, res: out, frames: bmf.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), secs: r2((t1 - t0) / 1e6), mainCpu: r2(sumT(tasks)), gpuCpu: r2(sumT(gpuTasks)), script: r2(by('FunctionCall')), style: r2(by('UpdateLayoutTree')), layout: r2(by('Layout')), layerize: r2(by('Layerize')), paint: r2(by('Paint')), walk: r2(by('LocalFrameView::performPostLayoutTasks')), ro: r2(by('LocalFrameView::NotifyResizeObservers')) }));
    }
  } else if (kind === 'trace') {
    await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'v8.execute', 'blink.user_timing', ...(process.env.EXTRA ? process.env.EXTRA.split(',') : [])] });
    console.log(JSON.stringify(await js(stepCode(last))));
    const file = await contentTracing.stopRecording(path.join(OUT, `trace-${Date.now()}.json`));
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const events = data.traceEvents || data;
    const names = new Map();
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args.name);
    const threadOf = (e) => names.get(`${e.pid}:${e.tid}`) || '?';
    const group = (n) => (n === 'CrRendererMain' ? 'main' : /Worker/.test(n) ? 'worker' : /Compositor/.test(n) ? 'compositor' : /CrGpuMain/.test(n) ? 'gpu' : /Raster/.test(n) ? 'raster' : null);
    // Traces run to hundreds of MB: kept only when asked for (KEEP_TRACE=1, e.g. to open in DevTools).
    if (process.env.KEEP_TRACE === '1') console.log(JSON.stringify({ trace: file }));
    else fs.unlinkSync(file);
    if (process.env.WORST) {
      // The longest main-thread tasks, and what took the time inside each.
      const main = events.filter((e) => e.ph === 'X' && e.dur && threadOf(e) === 'CrRendererMain');
      const longest = main.filter((e) => e.name === 'RunTask').sort((a, b) => b.dur - a.dur).slice(0, Number(process.env.WORST));
      for (const t of longest) {
        const inner = new Map();
        for (const e of main) if (e !== t && e.ts >= t.ts && e.ts + e.dur <= t.ts + t.dur) inner.set(e.name, (inner.get(e.name) || 0) + e.dur / 1000);
        console.log(`--- task ${(t.dur / 1000).toFixed(1)} ms`);
        for (const [n, v] of [...inner.entries()].sort((a, b) => b[1] - a[1]).filter(([n]) => !/RunTask|BeginMainFrame|UpdateLifecycle|ProxyMain/.test(n)).slice(0, 14)) console.log('   ', v.toFixed(1).padStart(7), n);
      }
    }
    if (process.env.EVENTS) {
      // Named events, summed per thread group: e.g. where image decoding happens.
      const want = process.env.EVENTS.split(',');
      const sums = new Map();
      for (const e of events) {
        if (e.ph !== 'X' || !want.some((w) => e.name.includes(w))) continue;
        const g = group(threadOf(e));
        if (!g) continue;
        const k = `${g.padEnd(10)} ${e.name}`;
        const c = sums.get(k) || { n: 0, ms: 0 };
        c.n++;
        c.ms += (e.dur || 0) / 1000;
        sums.set(k, c);
      }
      for (const [k, v] of [...sums.entries()].sort()) console.log(`  ${k.padEnd(64)} ${String(v.n).padStart(6)} x ${v.ms.toFixed(1).padStart(9)} ms`);
    }
    // Totals by thread group and event.
    const sums = new Map();
    for (const e of events) {
      if (e.ph !== 'X' || !e.dur) continue;
      const g = group(threadOf(e));
      if (!g) continue;
      const k = `${g} ${e.name}`;
      const c = sums.get(k) || { n: 0, ms: 0 };
      c.n++;
      c.ms += e.dur / 1000;
      sums.set(k, c);
    }
    for (const [k, v] of [...sums.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 40)) console.log(v.ms.toFixed(1).padStart(9), 'ms ', String(v.n).padStart(6), 'x ', k);
  } else if (kind === 'profile') {
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Profiler.enable');
    await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    await dbg.sendCommand('Profiler.start');
    console.log(JSON.stringify(await js(stepCode(last))));
    const { profile } = await dbg.sendCommand('Profiler.stop');
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    for (const s of profile.samples) counts.set(s, (counts.get(s) || 0) + 1);
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    for (const [id, c] of counts) {
      const cf = byId.get(id).callFrame;
      const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + c * dt);
    }
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log(v.toFixed(1).padStart(8), 'ms ', k);
  } else if (kind === 'hang') {
    // Start the step without waiting for it, then pause the page and print where it is.
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const paused = new Promise((res) => dbg.on('message', (_e, method, params) => method === 'Debugger.paused' && res(params)));
    await dbg.sendCommand('Debugger.enable');
    js(stepCode(last)).then((r) => console.log('step returned', JSON.stringify(r))).catch((e) => console.log('step failed', String(e)));
    await sleep(Number(process.env.HANG_MS || 8000));
    dbg.sendCommand('Debugger.pause').catch((e) => console.log('pause failed', String(e)));
    const p = await Promise.race([paused, sleep(15000).then(() => null)]);
    if (!p) console.log('never paused (stuck outside JavaScript?)');
    else for (const f of p.callFrames.slice(0, 40)) console.log('   ', f.functionName || '(anon)', (f.url || '').split('/').pop() + ':' + (f.location.lineNumber + 1) + ':' + (f.location.columnNumber + 1));
    process.exit(0); // a stuck page can hold up a normal quit
  } else {
    console.error('unknown kind ' + kind);
  }
  app.quit();
});
