import type { ProviderId } from "@shared/bridge";
import type { TokenUsage } from "../state/conn";
import { localDay } from "./format";

/** Weeks the activity grid spans: a year, ending with this one. */
export const WEEKS = 53;

export interface DayUsage {
  tokens: number;
  prompts: number;
  /** Tokens by provider, in the order the providers came. */
  providers: { p: ProviderId; tokens: number }[];
}

/** Who makes a model, for its mark: not the agent that ran it (Codex can route to Claude). */
export type ModelMaker = "anthropic" | "openai" | null;

export interface ModelShare {
  name: string;
  maker: ModelMaker;
  tokens: number;
}

export interface UsageStats {
  /** The grid's days, a column per week from Sunday, oldest first; null for days still to come. */
  weeks: (string | null)[][];
  /** Days in the grid with anything on them. */
  days: Record<string, DayUsage>;
  tokens: number;
  /** Of `tokens`, what providers counted beyond this computer's transcripts (Codex's server counts every device). */
  elsewhere: number;
  prompts: number;
  /** Whether any provider read its transcripts (models and prompts come only from those). */
  hasActivity: boolean;
  /** Days in a row with any use, up to today (or yesterday, while today has none yet); the most there's been. */
  current: number;
  longest: number;
  /** Tokens by model, most first. */
  models: ModelShare[];
  /** Prompts by local hour, 0–23. */
  hours: number[];
}

/**
 * The past year as the home screen shows it, all providers together. A day's tokens are the
 * larger of what the provider's own count says (Codex's server, which counts every device but
 * lags a day) and what its transcripts on this computer add up to.
 */
export function usageStats(usage: { p: ProviderId; u: TokenUsage | null | undefined }[], modelName: (p: ProviderId, id: string) => string, now = new Date()): UsageStats {
  const today = localDay(now);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (WEEKS - 1) * 7 - now.getDay());
  const weeks: (string | null)[][] = [];
  const order: string[] = [];
  for (let w = 0; w < WEEKS; w++) {
    const col: (string | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const day = localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d));
      const past = day <= today;
      col.push(past ? day : null);
      if (past) order.push(day);
    }
    weeks.push(col);
  }

  const days: Record<string, DayUsage> = {};
  const models = new Map<string, ModelShare>();
  const hours = new Array<number>(24).fill(0);
  let tokens = 0;
  let elsewhere = 0;
  let prompts = 0;
  for (const day of order) {
    for (const { p, u } of usage) {
      const a = u?.activity?.days[day];
      const t = Math.max(u?.days[day] ?? 0, a?.tokens ?? 0);
      const n = a?.prompts ?? 0;
      if (!t && !n) continue;
      const d = (days[day] ??= { tokens: 0, prompts: 0, providers: [] });
      d.tokens += t;
      d.prompts += n;
      if (t) d.providers.push({ p, tokens: t });
      tokens += t;
      prompts += n;
      if (u?.activity) elsewhere += t - (a?.tokens ?? 0);
      if (!a) continue;
      for (const [id, mt] of Object.entries(a.models)) {
        // Names, not ids: one model reached two ways (by Claude Code, and routed through Codex) is one entry.
        const name = modelName(p, id);
        const m = models.get(name);
        if (m) m.tokens += mt;
        else models.set(name, { name, maker: modelMaker(id), tokens: mt });
      }
      a.hours.forEach((h, i) => (hours[i] += h));
    }
  }

  let longest = 0;
  let run = 0;
  for (const day of order) {
    run = days[day] ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today isn't over: no use yet doesn't end the streak.
  let current = 0;
  for (let i = order.length - (days[today] ? 1 : 2); i >= 0 && days[order[i]]; i--) current++;
  // A provider's own streaks can reach back before the grid.
  for (const { u } of usage) {
    if (!u?.streaks) continue;
    longest = Math.max(longest, u.streaks.longest);
    current = Math.max(current, u.streaks.current);
  }

  return {
    weeks,
    days,
    tokens,
    elsewhere,
    prompts,
    hasActivity: usage.some(({ u }) => u?.activity),
    current,
    longest: Math.max(longest, current),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    hours,
  };
}

const title = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

/**
 * A model id as people say it, for the families Ret knows: `claude-opus-5-5` → "Claude Opus 5.5",
 * `gpt-6-astra` → "GPT-6 Astra", `gpt-5.1-codex-max` → "GPT-5.1 Codex Max". A routed id is named
 * by its last part (`antseed/claude-opus-5.5`). Null for anything else, which keeps the name its
 * provider lists it by.
 */
export function prettyModel(id: string): string | null {
  const base = id.slice(id.lastIndexOf("/") + 1);
  let m = /^claude-([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/.exec(base);
  if (m) return `Claude ${title(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = /^claude-(\d+)(?:-(\d))?-([a-z]+)/.exec(base);
  if (m) return `Claude ${title(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
  m = /^gpt-([\d.]+)((?:-[a-z0-9]+)*)$/i.exec(base);
  if (m) return [`GPT-${m[1]}`, ...m[2].split("-").filter(Boolean).map(title)].join(" ");
  return null;
}

/** A model id as a last resort: its last part, or a word for none. */
export function bareModel(id: string): string {
  const base = id.slice(id.lastIndexOf("/") + 1);
  return base === "unknown" ? "Unknown model" : base;
}

export function modelMaker(id: string): ModelMaker {
  const base = id.slice(id.lastIndexOf("/") + 1);
  return base.startsWith("claude-") ? "anthropic" : /^(gpt-|o\d)/.test(base) ? "openai" : null;
}
