import { useEffect, useState, type KeyboardEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { shallowEqual } from "../lib/shallow";
import { PROVIDERS } from "../agents";
import { loadTokenUsage } from "../state/actions";
import { useConn, useEnabledProviders } from "../state/conn";
import { useGatedStore } from "../state/useThread";
import { compactNumber, localDay } from "../lib/format";

const DAYS = 30;

/** Axis ticks are round numbers: "200M", not "200.0M". */
const tickLabel = (n: number) => compactNumber(n).replace(/\.0(?=[kMB])/, "");

/** The smallest of 1, 2 or 5 × a power of ten that's at least `n`: a step that gives clean ticks. */
function niceStep(n: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, n)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= n)!;
}

/** The last `DAYS` local days, oldest first. */
function lastDays(): string[] {
  const d = new Date();
  d.setDate(d.getDate() - (DAYS - 1));
  return Array.from({ length: DAYS }, () => {
    const day = localDay(d);
    d.setDate(d.getDate() + 1);
    return day;
  });
}

export function dayLabel(day: string, opts: Intl.DateTimeFormatOptions) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/** The enabled providers' usage for the home screen, read when it's shown (again once a minute old). */
export function useTokenUsage() {
  const enabled = useEnabledProviders();
  // Held still while the home screen is hidden behind another mode: a first read sends running totals for a while.
  const usage = useGatedStore(useConn, (s) => enabled.map((p) => s.providers[p].tokenUsage), shallowEqual);
  const key = enabled.join();
  useEffect(() => {
    for (const p of enabled) void loadTokenUsage(p, 60_000);
  }, [key]);
  return { enabled, usage, loading: usage.some((u) => u?.loading) };
}

/**
 * Tokens per day over the last 30 days, stacked by provider (input with cache, plus output, as
 * each provider counts them). The header holds each provider's total for the period; pointing at
 * a day, or arrowing through them, swaps in that day's numbers. While a provider is still reading
 * (Claude's first pass over its transcripts), the frame holds its place and the bars grow as
 * running totals arrive.
 */
export function TokenUsageChart() {
  const { enabled, usage, loading } = useTokenUsage();
  const [hover, setHover] = useState<number | null>(null);

  const days = lastDays();
  const series = enabled.map((p, i) => ({ p, days: usage[i]?.days })).filter((s) => days.some((d) => s.days?.[d]));
  if (!series.length && !loading) return null;

  const cols = days.map((d) => series.map((s) => s.days?.[d] ?? 0));
  const totals = cols.map((c) => c.reduce((a, b) => a + b, 0));
  const max = Math.max(...totals);
  // Nothing read yet: an unlabeled grid of the usual shape.
  const step = max ? niceStep(max / 3) : 1;
  const top = max ? Math.ceil(max / step) * step : 3;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const period = series.map((_, j) => cols.reduce((a, c) => a + c[j], 0));
  const shown = hover == null ? period : cols[hover];
  const when = hover == null ? `last ${DAYS} days` : hover === DAYS - 1 ? "today" : dayLabel(days[hover], { weekday: "short", month: "short", day: "numeric" });
  const summary = `Tokens per day, last ${DAYS} days: ${series.map((s, j) => `${PROVIDERS[s.p].short} ${compactNumber(period[j])}`).join(", ")}`;

  const onKey = (e: KeyboardEvent) => {
    const last = DAYS - 1;
    const next =
      e.key === "ArrowLeft" ? Math.max(0, (hover ?? DAYS) - 1) : e.key === "ArrowRight" ? Math.min(last, (hover ?? -1) + 1) : e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setHover(next);
  };

  return (
    <section className="tok">
      <div className="tok-head">
        <h4>
          Token usage
          {loading && <LoaderCircle size={11} className="spin" aria-label="Reading usage" />}
        </h4>
        {series.length > 0 && (
          <div className="tok-readout" aria-live="polite">
            {series.length > 1 &&
              series.map((s, j) => (
                <span key={s.p} className="tok-key">
                  <i style={{ background: `var(--series-${s.p})` }} />
                  <b>{compactNumber(shown[j])}</b> {PROVIDERS[s.p].short}
                </span>
              ))}
            <span className="tok-key">
              <b>{compactNumber(shown.reduce((a, b) => a + b, 0))}</b> {when}
            </span>
          </div>
        )}
      </div>
      <div className="tok-plot" tabIndex={0} role="img" aria-label={summary} onKeyDown={onKey} onBlur={() => setHover(null)} onPointerLeave={() => setHover(null)}>
        {/* Keyed by position, so a rescale slides the lines and relabels them rather than swapping them out. */}
        {ticks.map((t, i) => (
          <div key={i} className={`tok-gridline${t ? "" : " base"}`} style={{ bottom: `${(t / top) * 100}%` }}>
            {max > 0 && <span>{tickLabel(t)}</span>}
          </div>
        ))}
        <div className="tok-cols">
          {cols.map((c, i) => (
            <div key={days[i]} className={`tok-col${hover === i ? " on" : ""}`} onPointerEnter={() => setHover(i)}>
              {totals[i] > 0 && (
                <div className="tok-stack" style={{ height: `${(totals[i] / top) * 100}%`, animationDelay: `${i * 12}ms` }}>
                  {series.map((s, j) => c[j] > 0 && <div key={s.p} style={{ flexGrow: c[j], background: `var(--series-${s.p})` }} />)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="tok-axis">
        {days.map((d, i) =>
          (DAYS - 1 - i) % 7 === 0 ? (
            <span key={d} className={i === DAYS - 1 ? "end" : undefined} style={i === DAYS - 1 ? undefined : { left: `${((i + 0.5) / DAYS) * 100}%` }}>
              {i === DAYS - 1 ? "Today" : dayLabel(d, { month: "short", day: "numeric" })}
            </span>
          ) : null,
        )}
      </div>
    </section>
  );
}
