---
name: perf-review
description: Review a change to Ret (a PR, branch, commit or the working tree) for runtime performance. Checks the diff against Ret's performance rules, then measures it against its base on a 102-window reference board (canvas gestures, streaming, typing, mode and board switches, feature probes) and reports numbers, regressions with file:line and their fixes. Use before merging a PR, after changes to rendering, stores, transcripts, the canvas, polling or main-process engine traffic, or when asked how fast something is.
---

# Ret performance review

Ret has to stay smooth on a board of a hundred windows with several agents streaming. A review here
has two halves, and both are needed: **reading the diff against `rules.md`** (what has bitten before,
and how it's done instead) and **measuring the change against its base** with the bench in `bench/`.
Reading finds causes; measuring finds what reading misses and shows whether a suspicion costs anything.

The skill lives in `.agents/skills/perf-review/` (`rules.md` and `bench/` here mean the ones there).
This file is also at `.claude/skills/perf-review/SKILL.md`, for Claude Code: the two are kept the same.

## Ground rules

- Never build into the repo's `dist/` (the user's installed Ret may run from it) and never switch
  branches in the user's checkout: the bench builds every revision into its own workspace
  (`$RET_BENCH_DIR`, else `<tmp>/ret-bench`), from `git archive`, linking this checkout's
  `node_modules`.
- Don't push, comment on GitHub or merge unless asked. Fixes go in a worktree or on the branch under
  review, and get measured again.
- Machines are noisy (other jobs). Compare **CPU time per frame** (the `cpu` kind, from traces), not fps,
  over **at least 2 interleaved rounds**, and say when a difference is within the spread.

## Workflow

Commands run from the repo root; `B=.agents/skills/perf-review/bench/bench.mjs`. Targets are a commit,
branch or tag, `pr:<number>` (fetched from origin), `worktree` (this checkout with its uncommitted
changes), a folder with a checkout, or a folder that is already a build. Builds are cached by commit.

1. **Scope.** Find head and base: for a PR, `gh pr view <n> --json headRefOid,baseRefName` and the
   merge base with `origin/main`; for a branch, `git merge-base origin/main <branch>`. Read the diff
   (`git diff <base>...<head> --stat`, then every changed file under `src/renderer` and `src/main`).

2. **Read it against the rules.** Go through `rules.md` for each changed file. Quick greps
   on the diff's added lines:
   `useThreads(`, `Object.values(s.`, `setInterval(`, `requestAnimationFrame(`,
   `getBoundingClientRect`/`offsetHeight`/`scrollHeight`, `.style.transform`/`.style.translate`,
   `animation:`/`@keyframes`/`transition:` (and what they animate), `data:image`, `JSON.parse(`,
   `flushNow(`, new lucide icons in per-item rows, new requests in polls or per-window hydration.
   Note each suspect with file:line; measuring decides which matter.

3. **Measure the whole app, base against head** (each about 25 min for 2 rounds; run them in the
   background and keep reading meanwhile):
   ```bash
   node $B ab <base> <head> --suite canvas --rounds 2
   node $B ab <base> <head> --suite nav --rounds 2
   ```
   `canvas` = drag, pan, zoom, zoom across the card threshold, then with 8 agents streaming: idle,
   pan, cards, drag, typing, scrolling a transcript, clicking between windows. `stream` and `quick`
   are subsets; any `+`-joined list of steps works too (see "Steps"). `nav` = mode and tab switches
   (incl. a 40-turn thread), switching to a cold 89-thread board, opening an unloaded 6.6 MB thread.

4. **Probe what the change adds.** The suite's board has plain threads, so a feature (computer use,
   subagents, goals, a new message format, a new pane) needs its own data: use or adapt a probe
   (below), or write one. For a new pure function (a parser, a formatter) bundle it and time it with
   realistic and huge inputs:
   ```bash
   node_modules/.bin/esbuild src/renderer/lib/x.ts --bundle --format=cjs --platform=node --outfile=$TMP/x.cjs
   node $TMP/time-x.cjs   # require('./x.cjs'), call it in a loop with performance.now() around it
   ```

5. **Check behavior** if the change touches the canvas, transcripts, composer or kept views (the
   checks below): performance work breaks scroll positions, drafts and focus before anything else.

6. **Attribute what's slower.** For a step that regressed, see where the time goes on head:
   ```bash
   WORST=3 node $B run <head> trace.<setup steps>+<step>     # the 3 longest tasks, broken down
   EVENTS=FinalizeFrame,DecodeImage node $B run <head> trace.<steps>   # which thread does that work
   node $B run <head> profile.<setup steps>+<step>           # JS self time by function
   node $B run <head> hang.<steps>                           # page stuck: where (debugger pause)
   ```
   Builds aren't minified, so profile lines point at readable code in the dist's assets.

7. **Report** (format below). If asked to fix: fix on the branch or in a worktree, re-run what
   regressed, and report before and after.

## Reading the numbers

- `ab` prints, per step, main-thread CPU per frame: each round's p50, the mean and best of rounds,
  and mean p95. `~` marks a difference within the spread between rounds (or under 0.15 ms). Raw
  results land in the workspace as JSON.
- **Contention or code?** When a run is slow in every stage at once (script, style, layout, layerize,
  paint, the draggable walk), including stages the change can't touch, it's the machine: run more
  rounds of the affected steps (`--suite rpan+rstream --rounds 4`). A real regression shows in the
  stages the change touches and keeps its sign across rounds.
- **Idle must be idle**: `run <target> cpu.still` should show ~0 frames and ~0 script. Anything else
  is a timer, an animation in hidden content, or a poll.
- **Sandboxed frames run in a process of their own** (Codex visualizations: `sandbox="allow-scripts"`,
  an opaque origin). `cpu` counts only the page's renderer and reports theirs as `framesCpu`; `trace`
  groups their main threads as `frames`.
- Reference values (8d5576d on an RTX 4090 / 144 Hz Windows machine, quiet), p50 ms: drag 0.8–1.1,
  pan 1.3–2, zoom 2.5–3.5, cards 2.5–3.5; streaming: idle 1.2–1.5, pan 4–5, cards 3–3.5, drag 1.5–2,
  typing 4.2–5, scrolling 1.2–1.6, clicking windows 2.8–3.2. Mode/tab switches 10–40 ms, a cold
  board 40–120 ms, opening a 6.6 MB thread 25–60 ms. Other machines differ: compare base to head,
  not to these.

## Steps

Built-in steps (bench/runner.cjs), on the reference board: `rpan rzoom rcards rdrag rresize rfocus
rfly`, the same streaming: `rstream rstreampan rstreamzoom rstreamcards rstreamdrag rstreamfocus
rstreamtype rstreamscroll rstreamfly`, `rlive` (8 turns running, no text: animations at rest), `still`,
`anims` (what's animating), `layers` (windows culled/built), `touch`. `js-<name>` runs
`bench/page/<name>.js`. Kinds: `cpu` (each step traced), `trace`, `profile`, `hang`, `run` (also
`shot<name>`, `wait<ms>`, `mode-<focus|canvas|code|inbox>`). `--board demo` keeps the demo's own
small board; `--board <N>` builds a uniform one of N windows. Env: `WARM` (ms after setup, default
20000; `ab` uses 70000 so lingering views are gone), `SHOW=1` if the off-screen window doesn't render
(seen on some macOS setups).

## Probes (bench/page)

Each is a page script returning what it measured; run with `node $B run <target> cpu.<steps>` (or
`run.` for the ones that report by themselves). Expected results are for a healthy build.

| Steps | Measures | Healthy |
|---|---|---|
| `js-cu-lib+js-cu-prep+js-cu-history+js-cu-open+js-cu-live-apps+js-cu-live+js-cu-sizes` | Computer use: an 804-step history merge, re-merges, opening it, 30 live 1600×900 screenshots with the dock open and 3 thumbnails shown, blob and thumbnail sizes | first merge < ~15 ms, re-merge < 5 ms, live: 0 long frames, `640x360 blob` thumbnails; with `trace` and `EVENTS=FinalizeFrame,DecodeImage`, none of it on `main` |
| `js-agents-prep+js-agents-stream+js-agents-index` (prefix `js-agents-control+` for the same load as plain threads) | Subagents: a parent with 20 agents (8 streaming), its tray open, ~420 threads in the sidebar, the external poll at 3 s | tray "8 subagents working" (the 12 done ones aren't in it), stream p50 like the control, index update < 1 ms |
| `run.js-goals` | Goal timers in 10 windows: shown, culled, canvas hidden | only shown windows' spans change; all 0 with the canvas hidden |
| `js-codex-app-messages+rstream+rstreamtype+rstreamscroll+rcards` | Every user message in the Codex app's wrapped format (files, a referenced chat, a mention), then streaming | head no slower than base |
| `js-viz-prep+rpan+rcards+rstream+rstreamscroll+still` (prefix `js-viz-anim+` for frames that always animate; set `__vizCount`, `__vizStyle` or `__vizDoc` in an earlier step to vary them) | Codex visualizations: the last reply in up to 8 windows on screen ends with a `visualize` reference, shown in a sandboxed frame (a stand-in for the skill's runtime) | frames sized (`sized` = `frames`); with frames on screen pan and cards cost more (see rules 3.5), stream, scroll and still don't |
| `run.js-viz-statedoc+js-viz-prep+js-viz-cull` | Frames whose widget saves state, culled out of the document and back | `loads` > 0 (they reload), each culled frame's height one more after than before (state kept) |
| `js-usage-home+js-usage-read+rstream+still` | A first usage read that takes 20 s (running totals every 120 ms) while the home screen is built but hidden behind the canvas | `still` script near 0 (~50 ms per 3 s is the probe's own engine), stream like without the read |
| `run.js-nav-modes`, `run.js-nav-board`, `run.js-nav-load` | What `--suite nav` runs, one at a time | see reference values |

Writing one: a page script is an expression (usually an async IIFE) returning a JSON-able value.
Globals: `window.__ret` (`UI`, `TH`, `VP`, `AC`, `CD`, and `CU` when the revision has computer use:
the app's stores and actions), `window.__stress` (bench/page/harness.js and board.js: `measure`,
drives, `streamReal`/`stopReal`, `mkThread`/`mkLive` to make threads), `window.__nav` (nav.js:
`measure(label, act)`, `painted`, `mode`, `longThread`), and `window.ret.world` (the demo engine:
`world.threads` for engine-backed threads, `world.engines.codex.notify(method, params)` to send live
events through the app's real client path). Split setup and the measured part into two steps so the
`cpu` kind traces only the latter. Put windows you measure in the board's saved view: `cpu` resets the
view to it before every built-in step (cu-open shows how).

Gotchas found the hard way: dispatching a window `focus` event reloads the thread list and drops
threads the harness made (set `document.hasFocus = () => true` and wait ≤ 12 s for the poll's 3 s
pace instead); the demo engine's `thread/list` ignores `ancestorThreadId` (agents-prep patches it);
an optional chain with a side effect inside (`turns?.[order[--i]]`) skips it and can hang the page
(`hang.` finds it).

## Checks (bench/page/check-*)

| Command | Healthy result |
|---|---|
| `run <t> run.wait3000+js-check-canvas --board demo` | wheel pans by its delta and is prevented; over a transcript that can scroll it isn't (canvas still); zoom keeps its anchor |
| `run <t> run.wait3000+js-check-transcripts --board demo` | a culled window's transcript keeps its scroll (`back.sameNode`, same `scrollTop`); the composer grows and shrinks back |
| `run <t> run.mode-focus+js-check-island --board demo` | the Dynamic Island (goal, subagents, queue on a composer) reshapes without jumps as parts come and go, mid-animation too: `worst` < 1 px, every change's `left` empty |
| `run <t> run.wait3000+js-check-flights --board demo` | flight lands (`flight: false`), a pan interrupts it (`anims: 0`) |
| `run <t> run.wait3000+js-check-rail --board demo` | rail jumps put the first/last turn near the top (`…FromView` small) |
| `run <t> run.js-check-kept-views` | drafts follow a thread between views, a send goes out once, scroll kept, rail jump reaches undrawn turns (`isFirst`, small offset), hidden views ignore keys, boards switch back intact |
| `run <t> run.js-check-linger` (~70 s) | after the canvas leaves the document and comes back: same window positions, same transcript scroll |

## Report

```
## Performance review: <PR #/branch> (<head> vs <base>)

**Verdict:** no regression / regression in <what> / faster in <what>.

**Measured** (<machine>, <n> interleaved rounds, CPU per frame p50/p95 ms):
| scenario | base | head |
...and navigation, probes, micro-benchmarks as they apply.

**Findings** (most costly first): <file:line>: what it does, what it costs (the number), the fix.

**Not covered:** e.g. main-process engine traffic (the bench runs the renderer with the demo engine),
the real Codex backend, other platforms.
```

Say plainly when something wasn't measured, and keep reading-only suspicions apart from measured
costs. When the review turns up a cost that predates the change, list it under the known costs in
rules.md instead of blaming the change.

## Maintaining this skill

When a review finds a new kind of cost, add it to rules.md (what, the number, how to spot it, the fix).
Edit this file in `.agents/skills/perf-review/` and copy it over the one in `.claude/skills/perf-review/`
(`cmp` the two to check).
When a feature needs data the probes don't make, add a probe. bench/page/board-data.js is the board
everything is measured on: it's shared, so keep it free of real ids, paths and text (it was made from
a real board by replacing all of them).
