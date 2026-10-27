// Pure helpers for the Today panel's pulse strip and priority cards. Kept free
// of React so they can be unit-tested.

import type { DailyCount, RedemptionItem, RevenueDaily } from "@/lib/data/types";

export type Trend = { dir: "up" | "down" | "flat"; label: string } | null;

/** The last (today, UTC) point of an ascending daily series. */
export function lastValue(series: number[]): number {
  return series.length ? series[series.length - 1] : 0;
}

/** Today vs the mean of the earlier days in the window, as a whole percent.
 *  null when there's no history to compare against. */
export function trendVsAvg(series: number[]): Trend {
  if (series.length < 2) return null;
  const prior = series.slice(0, -1);
  const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
  if (avg <= 0) return null;
  const pct = Math.round(((lastValue(series) - avg) / avg) * 100);
  return { dir: pct > 0 ? "up" : pct < 0 ? "down" : "flat", label: `${Math.abs(pct)}%` };
}

/** Today minus yesterday, as an absolute count. null without two points. */
export function trendVsYesterday(series: number[]): Trend {
  if (series.length < 2) return null;
  const d = series[series.length - 1] - series[series.length - 2];
  return { dir: d > 0 ? "up" : d < 0 ? "down" : "flat", label: String(Math.abs(d)) };
}

export const spinSeries = (t: DailyCount[] | undefined) => (t ?? []).map((d) => d.spins);
export const centSeries = (t: RevenueDaily[] | undefined) => (t ?? []).map((d) => d.cents);

/** "4h", "2d", "15m": time elapsed since an ISO timestamp. null if unparseable. */
export function ageLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "4h", "2d", "15m": how long the oldest still-pending win in a list has waited. */
export function oldestPendingAge(
  redemptions: RedemptionItem[] | undefined,
  now: number = Date.now()
): string | null {
  let oldest = Infinity;
  for (const r of redemptions ?? []) {
    if (r.status !== "pending") continue;
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && t < oldest) oldest = t;
  }
  if (!Number.isFinite(oldest)) return null;
  const mins = Math.max(0, Math.floor((now - oldest) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Polyline points for a 120×40 sparkline. Empty when there's nothing to draw. */
export function sparkPoints(series: number[]): string {
  if (series.length < 2) return "";
  const max = Math.max(...series, 1);
  return series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * 120;
      const y = 38 - (v / max) * 34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export type ImpactTag = { label: string; tone: "brand" | "blue" | "amber" | "green" | "muted" };

/** Impact tag derived from the card's action (the API has no tag field). */
export function impactTag(kind: string): ImpactTag {
  switch (kind) {
    case "open_fulfilment":
      return { label: "Fulfil", tone: "brand" };
    case "dm_fan":
    case "copy_link":
    case "open_winback":
      return { label: "Re-engage", tone: "blue" };
    case "schedule_happy_hour":
      return { label: "Timing", tone: "amber" };
    case "edit_wheel":
      return { label: "Tune", tone: "green" };
    case "open_inbox":
      return { label: "Reply", tone: "brand" };
    default:
      return { label: "Insight", tone: "muted" };
  }
}
