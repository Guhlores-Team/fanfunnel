/**
 * Pure helpers for the Boosts panel (Command Center redesign). Kept free of
 * React so the status/bar math is unit-testable.
 */

export type HappyHourStatus = "live" | "scheduled" | "ended";

/** Live while `now` is inside [startsAt, endsAt]; scheduled before; ended after. */
export function happyHourStatus(
  startsAt: string,
  endsAt: string,
  now: number = Date.now(),
): HappyHourStatus {
  const s = new Date(startsAt).getTime();
  const e = new Date(endsAt).getTime();
  if (isNaN(s) || isNaN(e)) return "scheduled";
  if (now < s) return "scheduled";
  if (now > e) return "ended";
  return "live";
}

/**
 * Bar width (0–100) for a demand count relative to the largest count in the
 * list. The top item is always a full bar; a list of zeros renders empty bars.
 */
export function demandPct(count: number, counts: number[]): number {
  const max = Math.max(0, ...counts);
  if (max <= 0 || count <= 0) return 0;
  return Math.round((count / max) * 100);
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * "Fri 21 Mar · 8:00–10:00 PM" when a window starts and ends on the same day,
 * otherwise "Fri 21 Mar, 8:00 PM → Sat 22 Mar, 1:00 AM". Falls back to the raw
 * strings if either date is unparseable.
 */
export function formatWindow(startsAt: string, endsAt: string, locale?: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return `${startsAt} → ${endsAt}`;
  const day: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (sameDay(s, e)) {
    return `${s.toLocaleDateString(locale, day)} · ${s.toLocaleTimeString(locale, time)}–${e.toLocaleTimeString(locale, time)}`;
  }
  return `${s.toLocaleDateString(locale, day)}, ${s.toLocaleTimeString(locale, time)} → ${e.toLocaleDateString(locale, day)}, ${e.toLocaleTimeString(locale, time)}`;
}
