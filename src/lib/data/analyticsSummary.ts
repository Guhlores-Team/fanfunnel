import type { CreatorMetricsExtra, EngagementHeatmap } from "./types";
import { bucketByDay, bucketCentsByDay, clampDays } from "./metrics";

// PA-03: creator_analytics_summary (0073) aggregates the dashboard's numbers
// in SQL. These pure mappers turn its JSON into the shapes the panels already
// use; anything that is not the expected shape answers null, and the caller
// falls back to the complete row read.

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function metricsFromSummary(summary: unknown, days: number, now: Date = new Date()): CreatorMetricsExtra | null {
  if (!obj(summary) || !Array.isArray(summary.spinsByDay) || !Array.isArray(summary.revenueByDay) || !obj(summary.funnel) || !obj(summary.activeFans)) return null;
  const n = clampDays(days);
  const trend = bucketByDay([], n, now);
  const spins = new Map<string, number>();
  for (const row of summary.spinsByDay) {
    const value = obj(row) ? count(row.count) : null;
    if (!obj(row) || typeof row.day !== "string" || !DAY.test(row.day) || value === null) return null;
    spins.set(row.day, value);
  }
  const revenueTrend = bucketCentsByDay([], n, now);
  const cents = new Map<string, number>();
  for (const row of summary.revenueByDay) {
    const value = obj(row) ? count(row.cents) : null;
    if (!obj(row) || typeof row.day !== "string" || !DAY.test(row.day) || value === null) return null;
    cents.set(row.day, value);
  }
  const fans = count(summary.funnel.fans), spun = count(summary.funnel.spun), fulfilled = count(summary.funnel.fulfilled);
  const thisWeek = count(summary.activeFans.thisWeek), lastWeek = count(summary.activeFans.lastWeek);
  if (fans === null || spun === null || fulfilled === null || thisWeek === null || lastWeek === null) return null;
  return {
    dataStatus: "complete",
    trend: trend.map((d) => ({ ...d, spins: spins.get(d.date) ?? 0 })),
    funnel: { fans, spun, fulfilled },
    revenueTrend: revenueTrend.map((d) => ({ ...d, cents: cents.get(d.date) ?? 0 })),
    activeFans: { thisWeek, lastWeek },
  };
}

export function heatmapFromSummary(summary: unknown): EngagementHeatmap | null {
  if (!obj(summary) || !Array.isArray(summary.heatmap)) return null;
  const counts = new Array<number>(7 * 24).fill(0);
  for (const row of summary.heatmap) {
    if (!obj(row)) return null;
    const weekday = count(row.weekday), hour = count(row.hour), value = count(row.count);
    if (weekday === null || hour === null || value === null || !Number.isInteger(weekday) || !Number.isInteger(hour) || weekday > 6 || hour > 23) return null;
    counts[weekday * 24 + hour] = value;
  }
  const cells: EngagementHeatmap["cells"] = [];
  let max = 0;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const value = counts[weekday * 24 + hour];
      if (value > max) max = value;
      cells.push({ weekday, hour, count: value });
    }
  }
  return { cells, max, dataStatus: "complete" };
}
