#!/usr/bin/env node
// Ret's performance bench. Builds the web demo of any revision (never into the repo's dist/: the
// installed app may be running from it), runs it in Electron on a 102-window reference board, and
// compares builds. See ../SKILL.md for how a review uses it.
//
//   node bench.mjs build <target>                    build one; prints the dist folder
//   node bench.mjs run <target> <kind>.<steps> [--board real|N|demo] [--warm ms]
//   node bench.mjs ab <base> <head> [--suite canvas|stream|quick|nav|<steps>] [--rounds 2] [--warm ms]
//   node bench.mjs clean                             delete the workspace (builds, extracted trees)
//
// <target>: a commit, branch or tag; pr:<number> (fetched from origin); "worktree" (this checkout as it
// is, uncommitted changes included); a folder holding a checkout; or a folder that is already a build.
// Workspace: $RET_BENCH_DIR, else <tmp>/ret-bench.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
const work = process.env.RET_BENCH_DIR || path.join(os.tmpdir(), 'ret-bench');
const modules = path.join(repoRoot, 'node_modules');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();

const SUITES = {
  canvas: 'rdrag+rpan+rzoom+rcards+rstream+rstreampan+rstreamcards+rstreamdrag+rstreamtype+rstreamscroll+rstreamfocus',
  stream: 'rstream+rstreampan+rstreamcards+rstreamtype+rstreamscroll',
  quick: 'rpan+rstream+rstreamtype+rstreamcards',
};
const NAV = ['js-nav-modes', 'js-nav-board', 'js-nav-load'];

function args(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

// ---- building ----------------------------------------------------------------

/** A checkout's renderer, built as the web demo with its stores exposed on window.__ret. */
async function buildTree(tree, out) {
  const { build } = await import(pathToFileURL(path.join(modules, 'vite/dist/node/index.js')).href);
  const { default: react } = await import(pathToFileURL(path.join(modules, '@vitejs/plugin-react/dist/index.js')).href);
  const exposed = [['UI', 'state/ui'], ['TH', 'state/threads'], ['VP', 'components/canvas/viewport'], ['AC', 'state/actions'], ['CD', 'state/composerDrafts'], ['CU', 'state/computerUse']].filter(([, m]) => ['.ts', '.tsx'].some((x) => fs.existsSync(path.join(tree, 'src/renderer', m + x))));
  const expose = `\nPromise.all([${exposed.map(([, m]) => `import("../${m}")`).join(', ')}]).then(([${exposed.map(([k]) => k).join(', ')}]) => { window.__ret = { ${exposed.map(([k]) => k).join(', ')} }; });\n`;
  await build({
    configFile: false,
    root: path.join(tree, 'src/renderer/demo'),
    publicDir: path.join(tree, 'src/renderer/public'),
    base: './',
    logLevel: 'error',
    mode: 'production',
    plugins: [react(), { name: 'bench-expose', transform: (code, id) => (id.split(path.sep).join('/').endsWith('/demo/boot.ts') ? code + expose : undefined) }],
    resolve: { alias: { '@shared': path.join(tree, 'src/shared') } },
    define: { __RET_VERSION__: JSON.stringify('bench') },
    build: { outDir: out, emptyOutDir: true, sourcemap: false, reportCompressedSize: false, minify: false, chunkSizeWarningLimit: 9000 },
  });
}

/**
 * Unpack a tar (git archive's: ustar, with pax headers for long paths) into `dir`. Done here rather than
 * with tar(1), which isn't the same program everywhere (GNU tar under Git Bash reads C:\ as a host).
 */
function untar(buf, dir) {
  const str = (o, n) => buf.toString('utf8', o, o + n).replace(/\0.*$/s, '');
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break; // the two zero blocks at the end
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = str(off + 345, 155);
    let name = longName ?? (prefix ? prefix + '/' : '') + str(off, 100);
    longName = null;
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === 'x') {
      // pax: "<len> key=value\n" records; path overrides the next entry's name.
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) longName = m[1];
      }
    } else if (type === '5') fs.mkdirSync(path.join(dir, name), { recursive: true });
    else if (type === '0' || type === '7') {
      const f = path.join(dir, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    } // g (global header), symlinks and the rest: nothing the renderer build needs
    off += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Dependencies a tree's package.json names that this checkout's node_modules doesn't have. */
function missingDeps(tree) {
  const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => !fs.existsSync(path.join(modules, d, 'package.json')));
}

function linkModules(tree) {
  const link = path.join(tree, 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(modules, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Resolve a target to a built dist folder, building it if need be. */
async function resolve(target, { rebuild = false } = {}) {
  fs.mkdirSync(work, { recursive: true });
  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  if (isDir && fs.existsSync(path.join(target, 'index.html'))) return { label: path.basename(target), dist: path.resolve(target) };
  let tree, label;
  if (target === 'worktree') {
    tree = repoRoot;
    label = 'worktree';
    rebuild = true;
  } else if (isDir && fs.existsSync(path.join(target, 'src/renderer/demo'))) {
    tree = path.resolve(target);
    label = 'tree-' + path.basename(tree);
    rebuild = true;
  } else {
    let rev = target;
    const pr = /^pr:(\d+)$/.exec(target);
    if (pr) {
      git('fetch', '-q', 'origin', `+pull/${pr[1]}/head:refs/ret-bench/pr-${pr[1]}`);
      rev = `refs/ret-bench/pr-${pr[1]}`;
    }
    const sha = git('rev-parse', '--verify', rev + '^{commit}');
    label = (pr ? `pr${pr[1]}-` : '') + sha.slice(0, 8);
    tree = path.join(work, 'src-' + sha.slice(0, 12));
    if (!fs.existsSync(path.join(tree, 'package.json'))) {
      // The revision's files from git archive, without touching this checkout, its index or worktrees.
      untar(execFileSync('git', ['archive', sha], { cwd: repoRoot, maxBuffer: 1 << 30 }), tree);
    }
    linkModules(tree);
  }
  const dist = path.join(work, 'dist-' + label);
  if (!rebuild && fs.existsSync(path.join(dist, 'index.html'))) return { label, dist };
  const missing = missingDeps(tree);
  if (missing.length) console.error(`warning: ${label} depends on ${missing.join(', ')}, missing from ${modules} (npm install there if the build fails)`);
  process.stderr.write(`building ${label}... `);
  await buildTree(tree, dist);
  process.stderr.write('done\n');
  return { label, dist };
}

// ---- running -----------------------------------------------------------------

const electron = createRequire(path.join(repoRoot, 'package.json'))('electron');

/** One Electron run; resolves to its output lines (JSON ones parsed). */
function run(dist, mode, { board = 'real', warm, quiet = false } = {}) {
  return new Promise((res) => {
    const env = { ...process.env, ...(warm ? { WARM: String(warm) } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = spawn(electron, [path.join(here, 'runner.cjs'), dist, mode, String(board)], { env });
    const lines = [];
    let buf = '';
    const take = (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.trim() || /^\[\d+:\d+\/\d+\.\d+:(ERROR|WARNING)/.test(line)) continue; // Chromium's own log noise
        let v = line;
        try {
          v = JSON.parse(line);
        } catch {}
        lines.push(v);
        if (!quiet) console.log(typeof v === 'string' ? v : JSON.stringify(v));
      }
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const timer = setTimeout(() => p.kill(), Number(process.env.RUN_TIMEOUT || 600000));
    p.on('exit', () => {
      clearTimeout(timer);
      res(lines);
    });
  });
}

// ---- comparing ---------------------------------------------------------------

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

function table(rows, head) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Interleaved runs (A B, then B A, ...) so drift on a busy machine lands on both. */
async function ab(baseT, headT, opt) {
  const rounds = Number(opt.rounds || 2);
  const warm = Number(opt.warm || 70000);
  const base = await resolve(baseT), head = await resolve(headT);
  const suite = opt.suite || 'canvas';
  const results = { base: base.label, head: head.label, suite, rounds, cpu: {}, nav: {} };
  const order = (r) => (r % 2 ? [head, base] : [base, head]);
  for (let r = 0; r < rounds; r++) {
    for (const b of order(r)) {
      const side = b === base ? 'base' : 'head';
      if (suite === 'nav') {
        for (const script of NAV) {
          console.error(`round ${r + 1}: ${b.label} ${script}`);
          const out = await run(b.dist, `run.${script}`, { warm: 20000, quiet: true });
          for (const v of out) {
            const list = Array.isArray(v) ? v : v && typeof v === 'object' && !v.setup ? [v] : [];
            for (const x of list) {
              if (x.label && x.firstPaint != null) (results.nav[x.label] ??= { base: [], head: [] })[side].push(x.firstPaint);
              else if (x.firstPaint != null) (results.nav[script.slice(3)] ??= { base: [], head: [] })[side].push(x.contentShown || x.nearReady || x.firstPaint);
            }
          }
        }
      } else {
        const steps = SUITES[suite] || suite;
        console.error(`round ${r + 1}: ${b.label} cpu.${steps}`);
        const out = await run(b.dist, `cpu.${steps}`, { warm, quiet: true });
        for (const v of out) {
          if (!v || typeof v !== 'object' || !v.step) continue;
          const row = (results.cpu[v.step] ??= { base: [], head: [] });
          row[side].push({ p50: v.p50, p95: v.p95, fps: v.res?.fps, script: v.script, mainCpu: v.mainCpu, frames: v.frames });
        }
      }
    }
  }
  report(results);
  const file = path.join(work, `ab-${base.label}-vs-${head.label}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nraw results: ${file}`);
}

function report(res) {
  console.log(`\n${res.head} vs ${res.base}, ${res.rounds} interleaved rounds (${res.suite})`);
  if (Object.keys(res.cpu).length) {
    console.log('main-thread CPU per frame (ms): p50 per round | mean | best; then p95 mean. "~" = the difference is within the spread between rounds.\n');
    const rows = [];
    for (const [step, { base, head }] of Object.entries(res.cpu)) {
      const b50 = base.map((x) => x.p50), h50 = head.map((x) => x.p50);
      const spread = Math.max(Math.max(...b50) - Math.min(...b50), Math.max(...h50) - Math.min(...h50));
      const d = mean(h50) - mean(b50);
      const verdict = Math.abs(d) <= spread || Math.abs(d) < 0.15 ? '~' : d > 0 ? 'SLOWER' : 'faster';
      rows.push([step, b50.map((x) => fmt(x)).join(' '), h50.map((x) => fmt(x)).join(' '), fmt(mean(b50)), fmt(mean(h50)), fmt(Math.min(...b50)), fmt(Math.min(...h50)), fmt(mean(base.map((x) => x.p95)), 1), fmt(mean(head.map((x) => x.p95)), 1), `${d >= 0 ? '+' : ''}${fmt(d)}`, verdict]);
    }
    console.log(table(rows, ['step', 'base p50s', 'head p50s', 'base', 'head', 'best b', 'best h', 'p95 b', 'p95 h', 'delta', '']));
  }
  if (Object.keys(res.nav).length) {
    console.log('\nclick to first paint (ms), per round; board/load rows: time to content.\n');
    const rows = Object.entries(res.nav).map(([k, { base, head }]) => [k, base.join(' '), head.join(' '), fmt(mean(base), 0), fmt(mean(head), 0)]);
    console.log(table(rows, ['navigation', 'base', 'head', 'mean b', 'mean h']));
  }
}

// ---- cleaning ----------------------------------------------------------------

function clean() {
  if (!fs.existsSync(work)) return console.log('nothing to clean');
  // Unlink the node_modules links first: a recursive delete must never follow one into the real thing.
  for (const d of fs.readdirSync(work)) {
    const link = path.join(work, d, 'node_modules');
    try {
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    } catch {}
  }
  for (const d of fs.readdirSync(work)) {
    const link = path.join(work, d, 'node_modules');
    if (fs.existsSync(link)) throw new Error(`refusing to delete ${work}: ${link} is still there`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log('removed', work);
}

// ---- main --------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = args(rest);
if (cmd === 'build') console.log((await resolve(pos[0] ?? 'worktree', { rebuild: !!opt.rebuild })).dist);
else if (cmd === 'run') {
  const { dist } = await resolve(pos[0]);
  await run(dist, pos[1] ?? 'cpu.rstream', { board: opt.board ?? 'real', warm: opt.warm });
} else if (cmd === 'ab') await ab(pos[0], pos[1] ?? 'worktree', opt);
else if (cmd === 'clean') clean();
else {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
