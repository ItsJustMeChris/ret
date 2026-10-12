// ---------------------------------------------------------------------------
// Intent model. Edges are "infinite" targets: people heading for one don't need to
// brake, while people aiming at something near it do. So we open early for a fast
// leftward stroke whose predicted endpoint is past the edge, at once when the pointer
// arrives at the edge at speed, and after a short dwell for slow, deliberate approaches.
// Mostly vertical motion along the edge is treated as passing by.
//
// Endpoint prediction: an aimed pointer movement has a roughly symmetric, bell-shaped
// speed profile, so it ends about as far past the point of peak speed as that point is
// from the start (landing ≈ 2·peak − start). Real movements brake for longer than they
// accelerate, which makes this estimate fall short: it errs toward not opening. Before
// the peak, the latest position stands in for it, which can only make the stroke look
// shorter than it will be. Velocity is measured over a short window of raw samples
// rather than smoothed, since smoothing lags exactly when the pointer brakes.
// ---------------------------------------------------------------------------
export const REACH = 72; // px from the edge where intent is measured
export const FLING_SPEED = 0.45; // px/ms leftward (~450 px/s)
export const LAND_MARGIN = 8; // px a stroke must be predicted to overshoot the edge by,
export const LAND_SLACK = 0.04; // plus this share of its length (long strokes predict less precisely)
export const EDGE = 2; // px: touching the window edge
export const EDGE_DWELL_MS = 70; // ignores flick-throughs
export const NEAR = 18; // px: hovering close to the edge
export const NEAR_DWELL_MS = 220;
export const STILL_SPEED = 0.12; // px/ms
export const GRACE_BAND = 90; // px outside the open panel where drifting doesn't close it yet

const WINDOW_MS = 24; // velocity is measured across about this much time
const PAUSE_MS = 120; // a gap this long between samples means the pointer stopped
const SPACING_MS = 6; // minimum spacing of the speed samples used to locate the peak
const MOVING = 0.05; // px/ms: slower than this isn't a stroke
const JUMP = 32; // px: farther than this from where it rested, the pointer didn't get there by moving

export interface Motion {
  x: number;
  y: number;
  /** Velocity over the last few samples, px/ms. */
  vx: number;
  vy: number;
  /** Predicted resting x of the current leftward stroke; NaN when there isn't one. */
  landing: number;
  /** Where that stroke started. */
  from: number;
}

export interface Tracker {
  readonly m: Motion;
  /** Add a pointer sample (timestamps in ms, from the event). */
  push(t: number, x: number, y: number): Motion;
  /** No samples for a while: the pointer is at rest where it last was. */
  rest(): void;
  /** The pointer left; forget where it was. */
  reset(): void;
}

export function createTracker(): Tracker {
  const m: Motion = { x: NaN, y: NaN, vx: 0, vy: 0, landing: NaN, from: NaN };
  let buf: { t: number; x: number; y: number }[] = [];
  let anchor = NaN; // where the current (or next) leftward stroke starts
  let speeds: { t: number; x: number; v: number; w: number }[] = []; // the stroke's speed profile (w: fit weight)

  /**
   * x at the stroke's peak speed. The top of a speed profile is flat, so the fastest
   * sample is at the mercy of noise; instead fit a parabola (least squares) to the
   * upper half of the profile and take its vertex. While the pointer is still at its
   * top speed, the latest position stands in (the real peak can only come later).
   */
  const peakX = () => {
    const last = speeds[speeds.length - 1];
    let pk = speeds[0];
    for (const p of speeds) if (p.v > pk.v) pk = p;
    const top = pk.v;
    // Still speeding up per the fit, or no usable fit: only trust that near the top.
    const fallback = () => (last.v >= 0.9 * top ? last.x : pk.x);
    let k = 0, n = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, y0 = 0, y1 = 0, y2 = 0;
    for (const p of speeds) {
      if (p.v < top / 2) continue;
      const u = (p.t - last.t) / 100; // scaled for conditioning
      const w = p.w;
      k++, n += w, s1 += w * u, s2 += w * u * u, s3 += w * u * u * u, s4 += w * u * u * u * u;
      y0 += w * p.v, y1 += w * p.v * u, y2 += w * p.v * u * u;
    }
    if (k < 4) return fallback();
    // Weighted normal equations for v ≈ c0 + c1·u + c2·u², solved by Cramer's rule.
    const det3 = (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) =>
      a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const D = det3(n, s1, s2, s1, s2, s3, s2, s3, s4);
    if (!D) return fallback();
    const c1 = det3(n, y0, s2, s1, y1, s3, s2, y2, s4) / D;
    const c2 = det3(n, s1, y0, s1, s2, y1, s2, s3, y2) / D;
    if (c2 >= 0) return fallback(); // not curving over yet
    const tPeak = last.t + (-c1 / (2 * c2)) * 100;
    if (tPeak >= last.t) return fallback();
    // Interpolate the stroke's position at that moment.
    for (let i = speeds.length - 1; i > 0; i--) {
      const [q, r] = [speeds[i - 1], speeds[i]];
      if (q.t <= tPeak) return q.x + ((r.x - q.x) * (tPeak - q.t)) / (r.t - q.t || 1);
    }
    return speeds[0].x;
  };

  const rest = () => {
    buf = [];
    speeds = [];
    anchor = m.x;
    m.vx = m.vy = 0;
    m.landing = NaN;
  };

  return {
    m,
    push(t, x, y) {
      const last = buf[buf.length - 1];
      if (!last || t - last.t >= PAUSE_MS) {
        // Starting from rest: a stroke begins where the pointer was resting, unless it
        // reappeared somewhere else (it left the window, or came back from another app).
        anchor = Math.abs(x - m.x) <= JUMP ? m.x : x;
        buf = [{ t, x, y }];
        speeds = [];
        Object.assign(m, { x, y, vx: 0, vy: 0, landing: NaN });
        return m;
      }
      buf.push({ t, x, y });
      while (t - buf[0].t > PAUSE_MS) buf.shift();
      // Reference: the sample closest to WINDOW_MS ago (at least 4ms, so bursts of
      // near-simultaneous samples don't divide rounding noise by nothing).
      let ref = buf[0];
      for (let i = buf.length - 2; i >= 0; i--) {
        if (t - buf[i].t < 4) continue;
        if (Math.abs(t - buf[i].t - WINDOW_MS) < Math.abs(t - ref.t - WINDOW_MS)) ref = buf[i];
        if (t - buf[i].t >= WINDOW_MS) break;
      }
      const dt = t - ref.t;
      if (dt >= 4) {
        m.vx = (x - ref.x) / dt;
        m.vy = (y - ref.y) / dt;
      } // else: a burst of near-simultaneous samples; keep the last estimate
      m.x = x;
      m.y = y;

      if (m.vx < -MOVING) {
        if (dt >= 4) {
          // A window stretched over a stall averages the speed away; trust it less.
          const mid = { t: (t + ref.t) / 2, x: (x + ref.x) / 2, v: -m.vx, w: Math.min(1, (WINDOW_MS / dt) ** 2) };
          const prev = speeds[speeds.length - 1];
          if (!prev || mid.t - prev.t >= SPACING_MS) speeds.push(mid);
        }
        m.landing = speeds.length >= 4 ? 2 * peakX() - anchor : NaN; // too little to go on otherwise
        m.from = anchor;
      } else {
        anchor = x;
        speeds = [];
        m.landing = NaN;
      }
      return m;
    },
    rest,
    reset() {
      rest();
      Object.assign(m, { x: NaN, y: NaN, from: NaN });
    },
  };
}

/** Pure: how strongly the motion says "show me the sidebar" (0..1) and whether to open now. */
export function edgeIntent(m: Motion, edgeDwell: number, nearDwell: number, cooling: boolean): { score: number; open: boolean } {
  const left = Math.max(0, -m.vx);
  const speed = Math.hypot(m.vx, m.vy);
  const scrubbing = Math.abs(m.vy) > 2.5 * Math.abs(m.vx) && Math.abs(m.vy) > 0.15;
  const proximity = Math.max(0, Math.min(1, 1 - m.x / REACH));
  const heading = Math.min(1, left / FLING_SPEED);
  const leaving = m.vx > 0.2; // heading away from the edge
  let score = proximity * (0.3 + 0.7 * heading) * (scrubbing ? 0.35 : 1) * (leaving ? 0.35 : 1);

  const atEdge = m.x <= EDGE;
  if (atEdge) score = Math.max(score, 0.7 + 0.3 * Math.min(1, edgeDwell / EDGE_DWELL_MS));

  const slammed = atEdge && left >= FLING_SPEED; // arrived at speed: unmistakable
  const touched = atEdge && edgeDwell >= EDGE_DWELL_MS;
  const fling = !cooling && !scrubbing && m.x < REACH && left >= FLING_SPEED && m.landing <= -(LAND_MARGIN + LAND_SLACK * (m.from - m.landing));
  const lingered = !cooling && m.x < NEAR && nearDwell >= NEAR_DWELL_MS && speed < STILL_SPEED;
  return { score: Math.min(1, score), open: slammed || touched || fling || lingered };
}

