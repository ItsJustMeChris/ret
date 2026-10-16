# Ret's performance rules

What a change to Ret must not break, why (with what it cost when it was broken), how to spot it in a
diff, and the fix. The numbers come from the reference board (102 windows, 8 agents streaming) on an
RTX 4090 / 144 Hz machine: a frame is 6.9 ms there. "Main thread" is the renderer's unless it says
the main process.

## 1. Subscribing to the stores

**1.1 Per-thread data comes from `useThread`, not `useThreads`.**
`useThreads(selector)` runs its selector on every store update: about 30 times a second while
anything streams, in every mounted component, including ~100 built canvas windows and the views Kept
holds hidden, and it never freezes. `useThread(threadId, selector, equal?)` (state/useThread.ts) runs
only when that thread's own entries change, and holds still while its view is frozen (culled, under its
card, mid-gesture, hidden).
- Cost when broken: a subagent tray scanning `Object.values(s.threads)` from every composer took
  5.6 ms per store update at 700 threads × 92 composers, ~170 ms of every second while streaming.
- Spot it: `useThreads(` in anything rendered inside a thread pane, transcript, composer, window or
  card; `Object.values(s.threads)` / `Object.values(s.requests)` inside a selector.
- Fix: `useThread(id, …)`; several threads: `useThreadGroup(ids, …)`; another zustand store:
  `useGatedStore(store, …)` (computer use has `useScreen`).

**1.2 A new per-thread map in `ThreadsState` goes into `KEYED`** (state/useThread.ts), or `useThread`
subscribers never hear its changes (goals and agents are there).

**1.3 No O(threads) work per update.** Derive indexes once per `threads` identity and keep unchanged
entries' arrays (the `agents` index in threads.ts; `threadStateOf` caches per store snapshot). Selectors
return primitives or stable references; arrays and objects only with `shallowEqual` or a cache.

**1.4 Store writes stay batched and in place.** Notifications are applied about 30 times a second
(`enqueueNotification`); `flushNow()` defeats that, so not on hot paths. Items are updated in place
(`putItem`/`mutItem`), not by copying the items map per token.

## 2. Views that aren't on screen

**2.1 Off-screen canvas windows are out of the document, not just hidden.** With a draggable title
bar, Chromium walks every layout object after each layout and scroll (UpdateDocumentDraggableRegions),
so a culled window's pane is detached (CanvasWindow's portal host), never left under
`content-visibility`. Keep the layout tree small: anything per window that stays in the document costs
on every frame of every window.

**2.2 Hidden kept views do nothing.** Modes, the last Focus tabs, Inbox picks and boards stay built
while hidden (components/ui/Kept.tsx). What only matters on screen checks
`useVisibility().shown` / `useShown()`: key handlers, marking things read, taking a composer's events.
Timers (`setInterval`) skip their tick while not shown or while the view's `FreezeContext` gate is
frozen, as GoalTime does.
- Spot it: a new `setInterval`/`requestAnimationFrame` loop, window/document listener, or "seen"/
  "attended" effect in a pane component without a visibility or gate check.

**2.3 A hidden view lingers under `content-visibility: hidden` for 60 s**, its animations paused. An
animation or transition that *starts* in there never finishes, and Chrome then renders a frame every
vsync. Gated subscriptions (1.1) keep hidden views from re-rendering into new animations.

**2.4 A child's layout effects run before its parent's.** A container that portals its children must
be in the document before they measure or set scroll offsets (Kept attaches its host from a sibling
ref rendered before the portal).

## 3. Drawing the canvas

**3.1 Nothing moves by a style set from script each frame.** A transform/translate set from script on
a composited element re-layerizes the whole canvas (~2–3 ms a frame). Pans are scroll offsets, zooms,
drags and edge beacons are WAAPI animations whose keyframes are set as they go
(`effect.setKeyframes`), flights are one compositor animation, the minimap frame follows the scroll
through ScrollTimeline. Animations used that way settle back to plain styles once still (Beacons).
- Spot it: `.style.transform`, `.style.translate`, `.style.left/top` in a pointer, wheel, viewport or
  rAF handler.

**3.2 Animations are compositor-only, and never gated on focus.** Keyframes animate `transform` and
`opacity` only; no `background-position`, `stroke-dashoffset`, `box-shadow`, `filter`, sizes or colors
(those repaint the window, on the main thread, every frame). Make an animation cheap rather than
hiding it: limiting animations to the focused window was tried and rejected; every window animates.

**3.3 No layout reads on streaming, scroll or gesture paths.** `getBoundingClientRect`, `offset*`,
`client*`, `scroll*` reads force a layout (and the draggable-region walk). Measure in ResizeObserver
callbacks and keep the numbers (`viewport.size`); transcripts stick to their end by CSS
(column-reverse), not by setting `scrollTop` per token.

**3.4 Icons in repeated transcript rows are drawn at their own size.** Each lucide SVG adds a
transform node (viewBox scaling) and paint-chunk breaks: about half the re-layerize cost of busy panes
was icons. Rows that repeat per item use a size-native SVG (components/ui/Chevron.tsx); one-off icons
(headers, menus, the sidebar) are fine.

**3.5 Smaller rules.** Scroll offsets and transforms stay under ~2^18 px (float32 in the compositor;
the canvas rebases its origin). A scroller the app scrolls itself is `overflow: scroll` with hidden
scrollbars, not `overflow: hidden` (not composited: it repaints). Cursor changes during a drag use the
cursor shield (lib/cursorShield.ts), not a `body` class that restyles the document. Monaco keeps
`disableLayerHinting`.

## 4. Big data

**4.1 Long transcripts draw from their end.** The newest turns first (about 120 items), older ones in
idle-time transitions (Transcript.tsx). A new list over a thread's turns or items keeps to that: never
everything in one render.

**4.2 Boards mount the windows near the view first**, the rest a few per idle moment
(`useMountedWindows`); per-window work that isn't needed to draw it (fetches, heavy derivations) waits
until the window is built or shown.

**4.3 History comes in pages of megabytes.** A long Codex thread's 12-turn page is ~8 MB (65 MB seen).
Anything that walks it is linear and runs once: parse once, cache derived data by item id (computer
use caches finished steps, sized past a page), never re-scan per chunk.
- Cost when broken: the main process re-searched a growing stdout buffer per 64 KB chunk: 127 ms for
  8 MB, 10.5 s for 65 MB, with every other thread's events stuck behind it.

**4.4 Images never pass through the main thread at full size.** No `data:` URLs in the DOM (each
`<img>` copies and decodes the string): decode, resize and encode in a Worker (state/shotWorker.ts),
show blob URLs, thumbnails for anything small, revoke on eviction.
- Cost when broken: 8–14 ms of main thread per 1600×900 screenshot (canvas snapshot and decode).

**4.5 Text derived from messages is computed once.** Parse per text in `useMemo`, with a cheap fast
path for the common case and a bounded cache for what every render asks (titles: `requestText`).

## 5. Talking to the engines

**5.1 Polls ask little.** The external poll runs every 3 s while focused: per-thread requests in a pass
are capped (`AGENT_ASKS`) and only for threads that changed since they were last asked.

**5.2 Loading a board doesn't fan out per window.** One request per window when a board of 100 loads is
100 requests, each parsed on the renderer's main thread: load lazily from what's shown, or ride on
events and requests that happen anyway.

## Known costs (already there: not a change's regression)

- After any change to `threads` the sidebar takes ~10 ms to render with ~420 threads: `buildProjects`
  makes all-new nodes (every row re-renders), SidebarFooter's `Meter` calls `toLocaleString` per
  render, `useAggregate` is a whole-store selector per project row. Each `useProjectTree()` caller
  builds its own tree.
- The Working, BackgroundWork and Sleep timers in transcripts tick in hidden and culled views.
