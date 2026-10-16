import { memo, useContext, useLayoutEffect, useRef, useState } from "react";
import { FreezeContext, useThread } from "../../state/useThread";
import { useVisibility } from "../ui/Kept";
import { IslandContext, IslandList } from "./IslandList";
import { GoalBar } from "./GoalBar";
import { AgentTray, useActiveAgents } from "./Subagents";
import { ScreenDock, useLiveScreen } from "./ComputerUse";
import { QueueTray } from "./QueueTray";

/**
 * The Dynamic Island, on top of the composer: what the thread has going on right now. The goal it's
 * after, the agents it has out that are working or need you, the app it's using, the messages
 * waiting for its turn to end; each only while it's current, longest-lived first and the next
 * message nearest the box. It reshapes as they come and go (IslandMotion); with none, it's gone.
 */
export const DynamicIsland = memo(function DynamicIsland({ threadId, compact, agentsListed }: { threadId: string; compact?: boolean; agentsListed?: boolean }) {
  const goal = useThread(threadId, (s) => !!s.goals[threadId]);
  const agents = useActiveAgents(threadId);
  const screen = useLiveScreen(threadId) != null;
  const queued = useThread(threadId, (s) => !!s.queued[threadId]?.length);
  const ref = useRef<HTMLDivElement>(null);
  const motion = useIslandMotion(ref);
  return (
    <IslandContext.Provider value={motion}>
      <div ref={ref} className="dynamic-island">
        <IslandList className="island-body" freeze bottom>
          {goal && <GoalBar key="goal" threadId={threadId} />}
          {/* The details panel lists them while it's open. */}
          {agents.length > 0 && !agentsListed && <AgentTray key="agents" threadId={threadId} ids={agents} />}
          {screen && <ScreenDock key="screen" threadId={threadId} compact={compact} />}
          {queued && <QueueTray key="queue" threadId={threadId} />}
        </IslandList>
      </div>
    </IslandContext.Provider>
  );
});

/** The island's motion: it moves while its view is on screen and not held still, unless motion's unwelcome (it just changes then). */
function useIslandMotion(ref: React.RefObject<HTMLDivElement | null>) {
  const visibility = useVisibility();
  const gate = useContext(FreezeContext);
  const [motion] = useState(() => ({
    current: null as IslandMotion | null,
    changed() {
      this.current?.changed();
    },
  }));
  useLayoutEffect(() => {
    const m = new IslandMotion(ref.current!, () => visibility.shown && !gate?.frozen && !reducedMotion.matches);
    motion.current = m;
    return () => {
      m.stop();
      motion.current = null;
    };
  }, [ref, motion, visibility, gate]);
  return motion;
}

/** Everything in the island moves together, for as long and with Ret's --ease. */
const MOVE: KeyframeAnimationOptions = { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
const HOLD: KeyframeAnimationOptions = { ...MOVE, fill: "forwards" };
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const down = (y: number): Keyframe => ({ transform: `translateY(${y}px)` });
/** How far along an animation is, eased (1 once it's over). */
const progress = (a: Animation) => a.effect?.getComputedTiming().progress ?? 1;

/**
 * The island's motion, all on the compositor: nothing's sized or placed by script per frame.
 *
 * The island stands on the composer and grows up from it. When what's in it changes, it's laid out
 * the new way at once and then shown going there from where it was:
 * - The island itself (its edge, corners and clip) slides down behind the composer by the height it
 *   hasn't reached yet, its contents back up by as much so they hold still. Meanwhile it takes up
 *   only the smaller of its two heights in the flow (`--pull` takes the rest back out), so the
 *   transcript never has less room than what shows.
 * - Its sections go to their new place by their top edge (with the rule above them), measured up
 *   from the composer; the rows in a section by their place under its top.
 * - The transcript's content, when it's at its end, moves with the island's edge to where it will sit
 *   once it's done. (Scrolled up, it holds still by itself.)
 * At the end the transcript gets the room that's left and everything drops its offsets, which
 * leaves it all just where it shows.
 */
class IslandMotion {
  private readonly body: HTMLElement;
  private readonly ro: ResizeObserver;
  /** The island's height and width when last seen (-1: not seen since it was put in the document). */
  private height = -1;
  private width = -1;
  private morph: { from: number; to: number; pull: number; anims: Animation[] } | null = null;
  /** Each part's place when last seen: a section's top, down from the island's bottom; a row's, down from its section's top. */
  private readonly spots = new WeakMap<HTMLElement, number>();
  private readonly moves = new WeakMap<HTMLElement, { anim: Animation; from: number }>();
  private queued = false;

  constructor(
    private readonly island: HTMLElement,
    private readonly live: () => boolean,
  ) {
    this.body = island.firstElementChild as HTMLElement;
    this.tidy();
    // Sizes that change by themselves: a screenshot loading, a goal unfolding.
    this.ro = new ResizeObserver(() => this.look());
    this.ro.observe(this.body);
  }

  /** A part came or went: look once this change is all in, before it's drawn. */
  changed() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.look();
    });
  }

  stop() {
    this.ro.disconnect();
    this.settle();
  }

  private look() {
    if (!this.island.isConnected) {
      // Out of the document (a canvas window off screen): what it shows when it's back is where it starts.
      this.settle();
      this.height = -1;
      return;
    }
    this.tidy();
    this.move();
    this.tidy();
  }

  private move() {
    const { island, body } = this;
    // Everything's read before anything's written (starting a transform animation doesn't count).
    const h = body.offsetHeight;
    const w = body.offsetWidth;
    const places = new Map<HTMLElement, number>();
    for (const s of body.children as HTMLCollectionOf<HTMLElement>) {
      if (s.classList.contains("leaving")) continue;
      places.set(s, s.offsetTop - h);
      // From the section's outer top: the rule above it comes and goes with the section above.
      for (const r of s.querySelectorAll<HTMLElement>(".island-part:not(.leaving)")) places.set(r, s.clientTop + offsetIn(r, s));
    }

    // Seen for the first time, resized with its window, or with nothing to watch it move: it's just where it is.
    const still = this.height < 0 || (this.width > 0 && w !== this.width) || !this.live();
    if (w) this.width = w;
    for (const [el, at] of places) {
      const was = this.spots.get(el);
      this.spots.set(el, at);
      if (still || was === undefined || Math.abs(at - was) < 0.5) continue;
      const m = this.moves.get(el);
      const from = was - at + (m ? m.from * (1 - progress(m.anim)) : 0);
      m?.anim.cancel();
      this.moves.set(el, { anim: el.animate([down(from), down(0)], MOVE), from });
    }

    const v = this.morph ? this.morph.from + (this.morph.to - this.morph.from) * progress(this.morph.anims[0]) : this.height;
    this.height = h;
    if (still || Math.abs(v - h) < 0.5) return this.settle();
    if (this.morph?.to === h) return;
    const big = Math.max(v, h);
    const pull = big - Math.min(v, h);
    const flow = island.offsetHeight - (this.morph?.pull ?? 0);
    const scroller = island.parentElement?.querySelector<HTMLElement>(":scope > .transcript-wrap > .transcript");
    const content = scroller?.firstElementChild as HTMLElement | null | undefined;
    // The transcript's laid out from its end (column-reverse), so at the end its content moves with
    // the island's edge. Scrolled up from there (scrollTop < 0), scroll anchoring holds it still.
    const room = scroller && content && scroller.scrollTop > -0.5 ? { s: scroller.clientHeight, c: content.offsetHeight } : null;
    // Where the transcript's content ends with the island taking up `f`: at the bottom of the room it
    // has then, or at its own height when it's shorter than that room.
    const end = (f: number) => (room ? Math.min(room.c, room.s + flow - f) : 0);
    const t0 = end(v) - end(big - pull);
    const t1 = end(h) - end(big - pull);
    for (const a of this.morph?.anims ?? []) a.cancel();
    island.style.setProperty("--pull", `${pull}px`);
    island.style.minHeight = big > h ? `${big}px` : "";
    const anims = [island.animate([down(big - v), down(big - h)], HOLD), body.animate([down(v - big), down(h - big)], HOLD)];
    if (content && (Math.abs(t0) >= 0.5 || Math.abs(t1) >= 0.5)) anims.push(content.animate([down(t0), down(t1)], HOLD));
    const morph = (this.morph = { from: v, to: h, pull, anims });
    anims[0].onfinish = () => {
      if (this.morph === morph) this.settle();
    };
  }

  /** Done (or cut short): back to plain layout. */
  private settle() {
    const m = this.morph;
    if (m) {
      this.morph = null;
      this.island.style.removeProperty("--pull");
      this.island.style.minHeight = "";
      for (const a of m.anims) a.cancel();
    }
    this.tidy();
  }

  /** Empty and still, it isn't laid out at all: there's one on every composer, and most are empty. */
  private tidy() {
    const empty = !this.morph && !this.body.firstElementChild;
    if (empty === "empty" in this.island.dataset) return;
    if (!empty) delete this.island.dataset.empty;
    else {
      this.island.dataset.empty = "";
      // What it next shows at is its width, not a resize.
      this.width = -1;
    }
  }
}

/** `el`'s top, down from `root`'s (through the positioned boxes between them). */
function offsetIn(el: HTMLElement, root: HTMLElement): number {
  let y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return y;
}
