/**
 * Entry point of Ret's web demo: the real renderer, wired to scripted engines in the page.
 *
 * 1. Installs the demo bridge as `window.ret`, so the app's own bridge.ts picks it up.
 * 2. Overwrites the persisted UI state with the curated starting view (`?mode=` picks the view).
 * 3. Loads the normal app entry.
 * 4. Talks to an embedding page: `{ type: "ret-demo:mode", mode }` switches views; the demo
 *    posts `{ type: "ret-demo:ready", mode }` once it has rendered and
 *    `{ type: "ret-demo:modechange", mode }` whenever the view changes.
 */
import "./demo.css";
import type { ViewMode } from "../state/ui";
import { createDemoBridge } from "./bridge";
import { T } from "./fixtures";

const MODES: ViewMode[] = ["focus", "canvas", "code", "inbox"];
const isMode = (m: unknown): m is ViewMode => MODES.includes(m as ViewMode);

const params = new URLSearchParams(location.search);
const startMode: ViewMode = isMode(params.get("mode")) ? (params.get("mode") as ViewMode) : "canvas";
const theme = params.get("theme") === "light" ? "light" : "dark";
const sidebarPinned = params.get("sidebar") === "pinned";
const embedded = window.parent !== window;

document.documentElement.dataset.theme = theme;
document.documentElement.dataset.retDemo = embedded ? "embedded" : "standalone";
window.ret = createDemoBridge();
if (embedded) guardEmbed();

void start();

async function start() {
  const { seedUI } = await import("./seed");
  seedUI(startMode, theme, sidebarPinned);
  await import("../main");
  const [{ useUI, activeBoard }, { useThreads }, { viewport, boundsOf }] = await Promise.all([
    import("../state/ui"),
    import("../state/threads"),
    import("../components/canvas/viewport"),
  ]);

  // Finished while you were away: what the Inbox calls "Ready to review".
  useThreads.setState((s) => ({ unread: { ...s.unread, [T.notes]: true, [T.redis]: true } }));

  // ---- canvas framing ----------------------------------------------------------
  // Fit the board to whatever size the frame is, until the visitor moves the view themselves.
  let moved = false;
  const fit = () => {
    const el = document.querySelector<HTMLElement>(".canvas-viewport");
    const wins = activeBoard().windows;
    const all = boundsOf(wins);
    if (!el?.clientWidth || !all) return false;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    let vp = viewport.fitRect(all, vw, vh, 36, 1);
    // A small frame: frame the top row (approval, live turn, question) rather than shrink every
    // window to a card. The rest get edge markers pointing at them.
    if (vp.zoom < 0.56) {
      const top = boundsOf(wins.filter((w) => w.y < 200));
      if (top) vp = viewport.fitRect(top, vw, vh, 28, 1);
    }
    viewport.set(vp);
    return true;
  };
  const fitSoon = (tries = 30) => {
    if (moved || useUI.getState().mode !== "canvas") return;
    nextFrame(() => {
      if (!fit() && tries > 0) fitSoon(tries - 1);
    });
  };
  window.addEventListener(
    "pointerdown",
    (e) => {
      if ((e.target as Element | null)?.closest?.(".canvas-viewport")) moved = true;
    },
    true,
  );
  // The canvas claims the wheel (preventDefault) only when it pans or zooms with it.
  window.addEventListener("wheel", (e) => e.defaultPrevented && (moved = true), { passive: true });
  // Refit when the canvas changes size: the frame resizing, or the sidebar pinned or unpinned.
  const sized = new WeakSet<Element>();
  const ro = new ResizeObserver(() => fitSoon());
  const watchCanvas = () => {
    const el = document.querySelector(".canvas-viewport");
    if (el && !sized.has(el)) {
      sized.add(el);
      ro.observe(el);
    }
  };
  nextFrame(watchCanvas);
  fitSoon();

  // Transcripts follow their newest content on their own; while the first view settles (history
  // loading, the approval and question arriving), make sure each starts at its latest turn.
  let touched = false;
  for (const ev of ["pointerdown", "wheel", "keydown"]) window.addEventListener(ev, () => (touched = true), { capture: true, passive: true });
  const settle = () => {
    if (touched) return;
    for (const el of document.querySelectorAll<HTMLElement>(".transcript")) el.scrollTop = el.scrollHeight;
  };
  for (const ms of [300, 900, 1800, 3500]) setTimeout(settle, ms);

  // ---- embedding -----------------------------------------------------------------
  const post = (msg: object) => {
    if (embedded) window.parent.postMessage(msg, "*");
  };
  useUI.subscribe((s, prev) => {
    if (s.mode === prev.mode) return;
    post({ type: "ret-demo:modechange", mode: s.mode });
    if (s.mode === "canvas") {
      nextFrame(watchCanvas);
      fitSoon();
    }
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== "object") return;
    if (e.data.type === "ret-demo:mode" && isMode(e.data.mode)) useUI.setState({ mode: e.data.mode, paletteOpen: false, settingsOpen: false });
  });

  // Ready once both agents' threads are listed and the first view has painted.
  const t0 = performance.now();
  const ready = () => {
    const listed = useThreads.getState().listLoaded && Object.keys(useThreads.getState().threads).length > 0;
    const painted = !!document.querySelector(".app") && (useUI.getState().mode !== "canvas" || !!document.querySelector(".cwin .transcript-inner, .cwin .glance"));
    if ((listed && painted) || performance.now() - t0 > 6000) {
      nextFrame(() => nextFrame(() => post({ type: "ret-demo:ready", mode: useUI.getState().mode })));
      return;
    }
    setTimeout(ready, 50);
  };
  ready();
}

/**
 * The next animation frame, or a short timeout when frames aren't coming (a background tab, or a
 * frame the browser isn't painting yet): the work still happens, and the page hears about it.
 */
function nextFrame(fn: () => void) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

/**
 * Good manners inside someone else's page: don't pull focus (and with it the page's scroll) into
 * the frame before the visitor uses it, and let the mouse wheel scroll the page until they're in
 * the demo (they clicked or typed in it, or the page focused the frame for them), and again once
 * they've left it.
 */
function guardEmbed() {
  let engaged = false;
  let wheel = false;
  const engage = () => {
    engaged = true;
    wheel = true;
  };
  window.addEventListener("pointerdown", engage, true);
  window.addEventListener("keydown", engage, true);
  window.addEventListener("focus", engage);
  window.addEventListener("blur", () => (wheel = false));

  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
    if (engaged) focus.call(this, { preventScroll: true, ...opts });
  };
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    if (engaged) scrollIntoView.call(this, arg);
  };
  // Before a click, the canvas doesn't take the wheel: it scrolls the page (or a transcript under it).
  window.addEventListener(
    "wheel",
    (e) => {
      if (!wheel && (e.target as Element | null)?.closest?.(".canvas-viewport")) e.stopPropagation();
    },
    { capture: true, passive: true },
  );
}
