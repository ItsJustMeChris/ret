import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Box, LoaderCircle } from "lucide-react";
import { PROVIDER_IDS, type ProviderId } from "@shared/bridge";
import { PROVIDERS } from "../agents";
import { useConn } from "../state/conn";
import { useGatedStore } from "../state/useThread";
import { shallowEqual } from "../lib/shallow";
import { compactNumber } from "../lib/format";
import { bareModel, prettyModel, usageStats, WEEKS, type DayUsage, type ModelMaker, type ModelShare, type UsageStats } from "../lib/usageStats";
import { dayLabel, useTokenUsage } from "./TokenUsageChart";

/** Models named, side by side and in the share; the rest are "Other models". */
const TOP_MODELS = 3;

const streak = (n: number) => (n === 1 ? "1 day" : `${n} days`);
/** A part of a whole as a whole percent, or "<1%" for a sliver. */
const share = (n: number, total: number) => {
  const v = (n / (total || 1)) * 100;
  return v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`;
};
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

/**
 * The past year at a glance, every provider together: totals and streaks, a day-by-day grid, the
 * models the tokens went to and the hours prompts are sent at. Tokens are the providers' own
 * counts where they keep them (Codex's server), the rest from transcripts on this computer, which
 * Ret keeps reading as they grow.
 */
export function UsageOverview() {
  const { enabled, usage, loading } = useTokenUsage();
  const lists = useGatedStore(useConn, (s) => enabled.map((p) => s.providers[p].models), shallowEqual);
  const key = enabled.join();
  const stats = useMemo(() => {
    const names = new Map(enabled.flatMap((p, i) => lists[i].map((m) => [`${p}\n${m.id}`, m.displayName] as const)));
    return usageStats(
      enabled.map((p, i) => ({ p, u: usage[i] })),
      (p, id) => prettyModel(id) ?? (names.get(`${p}\n${id}`) || bareModel(id)),
    );
  }, [key, usage, lists]);

  if (!stats.tokens && !stats.prompts && !loading) return null;

  return (
    <section className="stats">
      <div className="tok-head">
        <h4>
          Past year
          {loading && <LoaderCircle size={11} className="spin" aria-label="Reading usage" />}
        </h4>
        {/* Said only once the counts part ways, as when another device does some of the work. */}
        {stats.hasActivity && stats.elsewhere > stats.tokens * 0.05 && (
          <div className="tok-readout">Tokens include other devices; models and prompts are this computer's</div>
        )}
      </div>
      <div className="stats-tiles">
        <Tile label="Tokens" value={compactNumber(stats.tokens)} />
        <Tile label="Prompts" value={stats.hasActivity ? stats.prompts.toLocaleString() : "—"} />
        <Tile label="Current streak" value={streak(stats.current)} />
        <Tile label="Longest streak" value={streak(stats.longest)} />
      </div>
      <ActivityGrid stats={stats} />
      {stats.models.length > 0 && <TopModels models={stats.models} />}
      {(stats.models.length > 0 || stats.prompts > 0) && (
        <div className="stats-pair">
          {stats.models.length > 0 && <TokenShare models={stats.models} />}
          {stats.prompts > 0 && <HourChart hours={stats.hours} by={stats.hoursBy} />}
        </div>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-tile">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** A day's shade, 0–4, by the quartiles of the days with any use: a few huge days don't wash the rest out. */
function levels(stats: UsageStats) {
  const sorted = Object.values(stats.days)
    .map((d) => d.tokens)
    .filter(Boolean)
    .sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => sorted[Math.floor(f * (sorted.length - 1))] ?? 0);
  return (day: string) => {
    const d = stats.days[day];
    if (!d) return 0;
    return !d.tokens ? 1 : d.tokens <= q[0] ? 1 : d.tokens <= q[1] ? 2 : d.tokens <= q[2] ? 3 : 4;
  };
}

/** Where each month starts along the grid, skipping one too close to the next to fit its name. */
function monthLabels(weeks: UsageStats["weeks"]) {
  const out: { week: number; label: string }[] = [];
  weeks.forEach((col, w) => {
    const first = col.find(Boolean);
    if (!first || (w > 0 && first.slice(0, 7) === weeks[w - 1].find(Boolean)?.slice(0, 7))) return;
    if (out.length && w - out[out.length - 1].week < 3) out.pop();
    out.push({ week: w, label: dayLabel(first, { month: "short" }) });
  });
  return out;
}

/** The provider with the most tokens on a day, whose color the day's square takes. */
function lead(d: DayUsage | undefined) {
  if (!d?.providers.length) return undefined;
  return d.providers.reduce((a, b) => (b.tokens > a.tokens ? b : a)).p;
}

/**
 * A square per day, a column per week, shaded by tokens and colored by the provider that did most
 * of that day's work. Pointing at a day, or arrowing through them (left and right by week, up and
 * down by day), puts its numbers in the header.
 */
function ActivityGrid({ stats }: { stats: UsageStats }) {
  const [hover, setHover] = useState<string | null>(null);
  const level = useMemo(() => levels(stats), [stats]);
  const months = useMemo(() => monthLabels(stats.weeks), [stats.weeks]);
  const order = useMemo(() => stats.weeks.flat().filter((d): d is string => !!d), [stats.weeks]);
  const active = Object.keys(stats.days).length;
  const d = hover ? stats.days[hover] : null;
  const who = PROVIDER_IDS.filter((p) => Object.values(stats.days).some((x) => x.providers.some((y) => y.p === p)));
  const multi = who.length > 1;
  const weekdays = [1, 3, 5].map((i) => ({ row: i, label: new Date(2000, 0, 2 + i).toLocaleDateString(undefined, { weekday: "short" }) }));

  const onKey = (e: KeyboardEvent) => {
    const last = order.length - 1;
    const i = hover ? order.indexOf(hover) : -1;
    const step = ({ ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 } as Record<string, number>)[e.key];
    // The first arrow lands on today.
    const next =
      step !== undefined ? order[i < 0 ? last : Math.min(last, Math.max(0, i + step))] : e.key === "Home" ? order[0] : e.key === "End" ? order[last] : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setHover(next);
  };
  const onPointer = (e: PointerEvent) => {
    const day = (e.target as HTMLElement).dataset.day;
    if (day) setHover(day);
  };

  return (
    <div className="heat">
      <div className="tok-head">
        <h4>Activity</h4>
        <div className="tok-readout" aria-live="polite">
          {hover ? (
            <>
              <span className="tok-key">{dayLabel(hover, { weekday: "short", month: "short", day: "numeric" })}</span>
              {multi &&
                d?.providers.map((x) => (
                  <span key={x.p} className="tok-key">
                    <i style={{ background: `var(--series-${x.p})` }} />
                    <b>{compactNumber(x.tokens)}</b> {PROVIDERS[x.p].short}
                  </span>
                ))}
              {/* One provider's count is already the day's. */}
              {(!multi || !d || d.providers.length !== 1) && (
                <span className="tok-key">
                  <b>{compactNumber(d?.tokens ?? 0)}</b> tokens
                </span>
              )}
              {stats.hasActivity && (
                <span className="tok-key">
                  <b>{d?.prompts ?? 0}</b> {d?.prompts === 1 ? "prompt" : "prompts"}
                </span>
              )}
            </>
          ) : (
            <span className="tok-key">
              <b>{active}</b> active {active === 1 ? "day" : "days"}
            </span>
          )}
        </div>
      </div>
      <div className="heat-body">
        <div className="heat-days" aria-hidden>
          {weekdays.map((w) => (
            <span key={w.row} style={{ gridRow: w.row + 1 }}>
              {w.label}
            </span>
          ))}
        </div>
        <div className="heat-main">
          <div className="heat-months" aria-hidden>
            {months.map((m) => (
              <span key={m.week} style={{ left: `${(m.week / WEEKS) * 100}%` }}>
                {m.label}
              </span>
            ))}
          </div>
          <div
            className="heat-grid"
            tabIndex={0}
            role="img"
            aria-label={`Activity over the past year: ${active} active days, ${compactNumber(stats.tokens)} tokens`}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
            onPointerOver={onPointer}
            onPointerLeave={() => setHover(null)}
          >
            {stats.weeks.map((col, w) => (
              <div key={w} className="heat-week">
                {col.map((day, i) => {
                  if (!day) return <div key={i} className="heat-cell later" />;
                  const p = lead(stats.days[day]);
                  return <div key={day} data-day={day} className={`heat-cell l${level(day)}${p ? ` by-${p}` : ""}${hover === day ? " on" : ""}`} />;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* With two providers, the hue says whose day it was and the steps how busy, so the steps go grey. */}
      <div className="heat-key" aria-hidden>
        {multi && (
          <span className="heat-who">
            {who.map((p) => (
              <span key={p} className="tok-key">
                <i className={`heat-cell l4 by-${p}`} />
                {PROVIDERS[p].short}
              </span>
            ))}
          </span>
        )}
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <i key={l} className={`heat-cell l${l} ${multi ? "by-none" : `by-${who[0]}`}`} />
        ))}
        More
      </div>
    </div>
  );
}

/** Twelve rays of two lengths, a little off the axes: the burst Claude's models are marked with. */
const BURST = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2 + 0.26;
  const len = [10, 7.6, 9, 8.2][i % 4];
  return `M12 12L${(12 + Math.cos(a) * len).toFixed(2)} ${(12 + Math.sin(a) * len).toFixed(2)}`;
}).join("");

/** A model's maker as a small mark: a burst for Anthropic's, a six-fold knot for OpenAI's, a box for anyone else's. */
function ModelMark({ maker }: { maker: ModelMaker }) {
  if (maker === "anthropic")
    return (
      <svg className="model-mark claude" viewBox="0 0 24 24" aria-hidden>
        <path d={BURST} />
      </svg>
    );
  if (maker === "openai")
    return (
      <svg className="model-mark openai" viewBox="0 0 24 24" aria-hidden>
        {[0, 60, 120, 180, 240, 300].map((deg) => (
          <rect key={deg} x="9.3" y="2.8" width="5.4" height="11.6" rx="2.7" transform={`rotate(${deg} 12 12)`} />
        ))}
      </svg>
    );
  return <Box className="model-mark" size={18} strokeWidth={1.6} aria-hidden />;
}

/** The models with the most tokens, side by side, ranked. */
function TopModels({ models }: { models: ModelShare[] }) {
  const total = models.reduce((a, m) => a + m.tokens, 0);
  return (
    <div className="stats-models">
      <div className="tok-head">
        <h4>Models</h4>
      </div>
      <div className="top-models">
        {models.slice(0, TOP_MODELS).map((m, i) => (
          <div key={m.name} className="top-model">
            <ModelMark maker={m.maker} />
            <div className="top-model-text">
              <span className="top-model-name" title={m.name}>
                {m.name}
              </span>
              <span className="top-model-sub">
                {share(m.tokens, total)} · {compactNumber(m.tokens)}
              </span>
            </div>
            <span className="top-model-rank">{i + 1}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The donut, in the SVG's units. */
const DONUT = { size: 120, r: 50, width: 13, gap: 2.5 };
const CIRCUMFERENCE = 2 * Math.PI * DONUT.r;
/** Each maker's models in its provider's chart color (Claude's orange, Codex's blue); anyone else's in a light grey. */
const HUES: Record<NonNullable<ModelMaker> | "other", string> = { anthropic: "var(--series-claude)", openai: "var(--series-codex)", other: "var(--text-2)" };
/** How strong a maker's first, second and third model are. */
const STEPS = [100, 60, 36];
const OTHER = "color-mix(in srgb, var(--text-3) 45%, var(--bg-2))";

/** The top models' colors: by maker, then a step back for each further one from the same maker. */
function shades(models: ModelShare[]) {
  const seen: Record<string, number> = {};
  return models.map((m) => {
    const k = m.maker ?? "other";
    const i = (seen[k] = (seen[k] ?? -1) + 1);
    return i ? `color-mix(in srgb, ${HUES[k]} ${STEPS[i]}%, var(--bg-3))` : HUES[k];
  });
}

/**
 * How the tokens split between the top models and the rest, as a ring from the top, clockwise.
 * The middle counts the models, or names the slice pointed at (or arrowed to, or whose row in the
 * key is pointed at) with its share.
 */
function TokenShare({ models }: { models: ModelShare[] }) {
  const [on, setOn] = useState<number | null>(null);
  const total = models.reduce((a, m) => a + m.tokens, 0) || 1;
  const rest = models.slice(TOP_MODELS).reduce((a, m) => a + m.tokens, 0);
  const top = models.slice(0, TOP_MODELS);
  const colors = shades(top);
  const slices = [
    ...top.map((m, i) => ({ name: m.name, tokens: m.tokens, color: colors[i] })),
    ...(rest > 0 ? [{ name: "Other models", tokens: rest, color: OTHER }] : []),
  ];
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((a, s) => a + s.tokens / total, 0));

  const onKey = (e: KeyboardEvent) => {
    const last = slices.length - 1;
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? Math.max(0, (on ?? slices.length) - 1)
        : e.key === "ArrowRight" || e.key === "ArrowDown"
          ? Math.min(last, (on ?? -1) + 1)
          : e.key === "Escape"
            ? null
            : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setOn(next);
  };
  // The slice is the pointer's angle around the middle, so the whole ring (gaps too) points at one.
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width - 0.5;
    const y = (e.clientY - box.top) / box.height - 0.5;
    if (Math.hypot(x, y) < 0.3) return setOn(null);
    const turn = (Math.atan2(x, -y) / (2 * Math.PI) + 1) % 1;
    setOn(starts.findLastIndex((s) => s <= turn));
  };

  return (
    <div className="stats-share">
      <div className="tok-head">
        <h4>Share of tokens</h4>
      </div>
      <div className={`share${on != null ? " dim" : ""}`}>
        <div className="share-donut">
          <svg
            viewBox={`0 0 ${DONUT.size} ${DONUT.size}`}
            tabIndex={0}
            role="img"
            aria-label={`Share of tokens: ${slices.map((s) => `${s.name} ${share(s.tokens, total)}`).join(", ")}`}
            onKeyDown={onKey}
            onBlur={() => setOn(null)}
            onPointerMove={onPointer}
            onPointerLeave={() => setOn(null)}
          >
            {slices.map((s, i) => {
              const len = (s.tokens / total) * CIRCUMFERENCE;
              // A surface gap between slices; a whole ring has none.
              const gap = slices.length > 1 ? Math.min(DONUT.gap, len / 2) : 0;
              const dash = Math.max(0.01, len - gap);
              return (
                <circle
                  key={s.name}
                  className={`share-slice${on === i ? " on" : ""}`}
                  cx={DONUT.size / 2}
                  cy={DONUT.size / 2}
                  r={DONUT.r}
                  strokeWidth={DONUT.width}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={-(starts[i] * CIRCUMFERENCE + gap / 2)}
                  transform={`rotate(-90 ${DONUT.size / 2} ${DONUT.size / 2})`}
                  style={{ stroke: s.color }}
                />
              );
            })}
          </svg>
          <div className="share-center" aria-live="polite">
            <b>{on == null ? models.length : share(slices[on].tokens, total)}</b>
            <span>{on == null ? (models.length === 1 ? "model" : "models") : slices[on].name}</span>
          </div>
        </div>
        <div className="share-legend">
          {slices.map((s, i) => (
            <div key={s.name} className={`share-row${on === i ? " on" : ""}`} onPointerEnter={() => setOn(i)} onPointerLeave={() => setOn(null)}>
              <i style={{ background: s.color }} />
              <span className="share-name" title={s.name}>
                {s.name}
              </span>
              <span className="share-pct">{share(s.tokens, total)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The hours' arc, in the SVG's units: a half circle, its ends on the line through its center. */
const ARC = { w: 300, h: 162, cx: 150, cy: 138, r: 124 };
const hourAt = (h: number) => {
  const a = Math.PI - (h / 23) * Math.PI;
  return { x: ARC.cx + ARC.r * Math.cos(a), y: ARC.cy - ARC.r * Math.sin(a) };
};
const pctX = (x: number) => `${(x / ARC.w) * 100}%`;
const pctY = (y: number) => `${(y / ARC.h) * 100}%`;

/**
 * Prompts by the hour they were sent, as a dot per hour along a half circle: midnight at the
 * left, noon at the top, 11 PM at the right. A dot grows and brightens with its count, in the
 * color of the provider that took most of that hour's prompts. The middle names the busiest
 * hour, or the one pointed at (or arrowed to) with its count, split by provider.
 */
function HourChart({ hours, by }: { hours: number[]; by: UsageStats["hoursBy"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  const shown = hover ?? peak;
  const who = PROVIDER_IDS.filter((p) => by[p]?.some(Boolean));
  const lead = hours.map((_, h) => who.reduce<ProviderId | undefined>((a, p) => (a === undefined || by[p]![h] > by[a]![h] ? p : a), undefined));

  const onKey = (e: KeyboardEvent) => {
    const next =
      e.key === "ArrowLeft" ? Math.max(0, (hover ?? 24) - 1) : e.key === "ArrowRight" ? Math.min(23, (hover ?? -1) + 1) : e.key === "Home" ? 0 : e.key === "End" ? 23 : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setHover(next);
  };
  // The hour is the pointer's angle around the middle, so the whole band along the arc points at one.
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * ARC.w - ARC.cx;
    const y = ARC.cy - ((e.clientY - box.top) / box.height) * ARC.h;
    if (Math.hypot(x, y) < ARC.r * 0.6) return setHover(null);
    const a = Math.atan2(Math.max(0, y), x);
    setHover(Math.min(23, Math.max(0, Math.round(((Math.PI - a) / Math.PI) * 23))));
  };

  return (
    <div className="stats-hours">
      <div className="tok-head">
        <h4>Prompts by hour</h4>
        {who.length > 1 && (
          <div className="tok-readout">
            {who.map((p) => (
              <span key={p} className="tok-key">
                <i style={{ background: `var(--series-${p})` }} />
                {PROVIDERS[p].short}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="hours-arc">
        <svg
          viewBox={`0 0 ${ARC.w} ${ARC.h}`}
          tabIndex={0}
          role="img"
          aria-label={`Prompts by hour of day, busiest at ${hourLabel(peak)}`}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onPointerMove={onPointer}
          onPointerLeave={() => setHover(null)}
        >
          {hours.map((n, h) => {
            const { x, y } = hourAt(h);
            const f = n / max;
            // Quiet hours shrink to specks, the busy ones stand out.
            const r = n ? 2 + 7 * f : 1.5;
            const hue = lead[h] ? `var(--series-${lead[h]})` : "var(--accent)";
            return (
              <g key={h}>
                {hover === h && <circle className="hours-ring" cx={x} cy={y} r={r + 3} />}
                <circle
                  className="hours-dot"
                  cx={x}
                  cy={y}
                  r={r}
                  style={n ? { fill: h === peak ? hue : `color-mix(in srgb, ${hue} ${Math.round(25 + 60 * f)}%, var(--bg-3))` } : undefined}
                />
              </g>
            );
          })}
        </svg>
        <div className="hours-center" style={{ top: pctY(ARC.cy) }} aria-live="polite">
          <b>{hourLabel(shown)}</b>
          <span>{hover == null ? "busiest hour" : `${hours[shown].toLocaleString()} ${hours[shown] === 1 ? "prompt" : "prompts"}`}</span>
          {hover != null && who.length > 1 && <span>{who.map((p) => `${by[p]![hover].toLocaleString()} ${PROVIDERS[p].short}`).join(" · ")}</span>}
        </div>
        {[0, 12, 23].map((h) => (
          <span key={h} className="hours-end" style={{ left: pctX(h === 12 ? ARC.cx : hourAt(h).x), top: pctY(ARC.cy + 12) }}>
            {hourLabel(h)}
          </span>
        ))}
      </div>
    </div>
  );
}
