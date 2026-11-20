import type { DailyCount, RevenueDaily } from "./types";

/** Clamp a day-window count into the supported 1..90 range. */
export function clampDays(days: number): number {
  if (!Number.isFinite(days)) return 1;
  return Math.min(90, Math.max(1, Math.floor(days)));
}

// The UTC calendar date ("YYYY-MM-DD") a timestamp falls on.
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket ISO timestamps into per-UTC-day spin counts.
 *
 * Returns exactly `clamp(days, 1, 90)` entries, ascending by date and ending on
 * `now`'s UTC date. Each bucket is zero-filled; timestamps outside the window
 * (or unparseable) are ignored. Pure and deterministic given its inputs.
 */
export function bucketByDay(
  timestamps: string[],
  days: number,
  now: Date = new Date()
): DailyCount[] {
  const n = clampDays(days);

  // Build the ascending list of UTC day keys ending at `now`.
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const keys: string[] = [];
  const index = new Map<string, number>();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = utcDateKey(d);
    index.set(key, keys.length);
    keys.push(key);
  }

  const counts = new Array<number>(n).fill(0);
  for (const ts of timestamps) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const slot = index.get(utcDateKey(d));
    if (slot !== undefined) counts[slot] += 1;
  }

  return keys.map((date, i) => ({ date, spins: counts[i] }));
}

/**
 * Bucket cents-valued events into per-UTC-day sums.
 *
 * Mirrors `bucketByDay`: returns exactly `clamp(days, 1, 90)` entries, ascending
 * by date and ending on `now`'s UTC date. Each bucket is zero-filled; events
 * outside the window (or with unparseable timestamps) are ignored. Sums `cents`
 * rather than counting. Pure and deterministic given its inputs.
 */
export function bucketCentsByDay(
  events: { at: string; cents: number }[],
  days: number,
  now: Date = new Date()
): RevenueDaily[] {
  const n = clampDays(days);

  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const keys: string[] = [];
  const index = new Map<string, number>();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const key = utcDateKey(d);
    index.set(key, keys.length);
    keys.push(key);
  }

  const totals = new Array<number>(n).fill(0);
  for (const ev of events) {
    const d = new Date(ev.at);
    if (Number.isNaN(d.getTime())) continue;
    const slot = index.get(utcDateKey(d));
    if (slot !== undefined) totals[slot] += ev.cents;
  }

  return keys.map((date, i) => ({ date, cents: totals[i] }));
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Weekly-active fans: distinct fans with at least one spin in the rolling 7 days
 * ending at `now`, and in the 7 days before that (for the trend). Future or
 * unparseable timestamps are ignored. Pure and deterministic given its inputs.
 */
export function activeFans(
  events: { fanId: string; at: string }[],
  now: Date = new Date()
): { thisWeek: number; lastWeek: number } {
  const t = now.getTime();
  const thisWeek = new Set<string>();
  const lastWeek = new Set<string>();
  for (const ev of events) {
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at) || at > t) continue;
    const age = t - at;
    if (age < WEEK_MS) thisWeek.add(ev.fanId);
    else if (age < 2 * WEEK_MS) lastWeek.add(ev.fanId);
  }
  return { thisWeek: thisWeek.size, lastWeek: lastWeek.size };
}
