// Visit glow (RM-3): pure rules shared by the fan page, the check-in route, the
// Supabase data layer and the mock store, so every path computes the same glow.
// Days are calendar dates as "YYYY-MM-DD" strings (the fan's own local date,
// clamped on write), so all date math here is UTC-on-dates, never wall clock.
import {
  CHECKIN_DATE_SKEW_DAYS,
  GLOW_GRACE_DAYS,
  GLOW_LEVEL_MIN,
  GLOW_MILESTONES,
  GLOW_MODE,
  GLOW_WINDOW_DAYS,
  REGULAR_MIN_VISITS,
  type GlowMilestoneId,
  type GlowMode,
} from "./config";

export type GlowLevel = 0 | 1 | 2 | 3;

/** What the fan page shows. `visits` is the count the glow mode produced. */
export interface FanGlow {
  visits: number;
  level: GlowLevel;
}

/** POST /api/fan/checkin's body on success. */
export interface CheckinResult {
  glow: FanGlow;
  /** Set only on the check-in that first recorded today and reached one. */
  milestone: GlowMilestoneId | null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC calendar date of an instant. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `day` shifted by `n` calendar days. */
export function addDays(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

/** True for a real calendar date in "YYYY-MM-DD" form (2026-02-30 is not). */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/**
 * The day a check-in is recorded on: the fan's own date when it is within
 * CHECKIN_DATE_SKEW_DAYS of the server's UTC date, else the nearest edge.
 * Anything malformed falls back to the server's UTC date.
 */
export function clampCheckinDay(localDate: unknown, now: Date): string {
  const today = utcDay(now);
  if (!isDay(localDate)) return today;
  const lo = addDays(today, -CHECKIN_DATE_SKEW_DAYS);
  const hi = addDays(today, CHECKIN_DATE_SKEW_DAYS);
  if (localDate < lo) return lo;
  if (localDate > hi) return hi;
  return localDate;
}

/**
 * The "today" a read anchors on when the fan's own date isn't known (page
 * render, creator views): the server's UTC date, or the latest stored day when
 * a fan ahead of UTC already checked in on their tomorrow.
 */
export function glowAnchor(days: Iterable<string>, now: Date): string {
  const today = utcDay(now);
  const hi = addDays(today, CHECKIN_DATE_SKEW_DAYS);
  let anchor = today;
  for (const d of days) if (d > anchor && d <= hi) anchor = d;
  return anchor;
}

/** Visits on [end - windowDays + 1, end]. */
export function visitsInWindow(days: ReadonlySet<string>, end: string, windowDays: number): number {
  let n = 0;
  for (let i = 0; i < windowDays; i++) if (days.has(addDays(end, -i))) n++;
  return n;
}

/** Consecutive visited days ending `end` (or the day before, if `end` has none yet). */
function streakLength(days: ReadonlySet<string>, end: string, grace: number): number {
  let d = days.has(end) ? end : addDays(end, -1);
  let n = 0;
  let forgiven = 0;
  for (;;) {
    if (days.has(d)) n++;
    else if (forgiven < grace && n > 0 && days.has(addDays(d, -1))) forgiven++;
    else break;
    d = addDays(d, -1);
  }
  return n;
}

/** The count the glow is drawn from, in the given mode. */
export function glowVisits(days: ReadonlySet<string>, today: string, mode: GlowMode = GLOW_MODE): number {
  switch (mode) {
    case "streak":
      return streakLength(days, today, 0);
    case "streakGrace":
      return streakLength(days, today, GLOW_GRACE_DAYS);
    default:
      return visitsInWindow(days, today, GLOW_WINDOW_DAYS);
  }
}

export function glowLevel(visits: number): GlowLevel {
  if (visits >= GLOW_LEVEL_MIN.full) return 3;
  if (visits >= GLOW_LEVEL_MIN.warm) return 2;
  if (visits >= GLOW_LEVEL_MIN.faint) return 1;
  return 0;
}

/** The creator's "Regulars": visited on REGULAR_MIN_VISITS+ of the last 7 days. */
export function isRegular(visitsLast7: number): boolean {
  return visitsLast7 >= REGULAR_MIN_VISITS;
}

export function computeGlow(days: ReadonlySet<string>, today: string, mode: GlowMode = GLOW_MODE): FanGlow {
  const visits = glowVisits(days, today, mode);
  return { visits, level: glowLevel(visits) };
}

/**
 * The milestone `today`'s visit reaches, if it should be celebrated: today was
 * visited, the window ending today holds enough visits, and no visited day in
 * the window before today had already reached it (so a fan who keeps coming
 * gets it once, and again only after a full window without it). Needs days
 * back to today - (2 × windowDays - 2): see CHECKIN_READ_DAYS.
 */
export function dueMilestone(days: ReadonlySet<string>, today: string): GlowMilestoneId | null {
  if (!days.has(today)) return null;
  const reached = (d: string, visits: number, w: number) => days.has(d) && visitsInWindow(days, d, w) >= visits;
  for (const m of GLOW_MILESTONES) {
    if (!reached(today, m.visits, m.windowDays)) continue;
    let earlier = false;
    for (let i = 1; i < m.windowDays && !earlier; i++) earlier = reached(addDays(today, -i), m.visits, m.windowDays);
    if (!earlier) return m.id;
  }
  return null;
}

/**
 * A check-in's response. `day` is the day just recorded, `fresh` = this request
 * recorded it (not a repeat visit). The glow anchors exactly as the page render
 * does (glowAnchor), so the two never disagree about the same visits.
 */
export function checkinResult(days: ReadonlySet<string>, day: string, fresh: boolean, now: Date): CheckinResult {
  return { glow: computeGlow(days, glowAnchor(days, now)), milestone: fresh ? dueMilestone(days, day) : null };
}

/** The newest day a check-in read needs: the latest day a check-in may record. */
export function latestCheckinDay(now: Date): string {
  return addDays(utcDay(now), CHECKIN_DATE_SKEW_DAYS);
}

/** Rolling visits in the last GLOW_WINDOW_DAYS, for creator views (mode-independent). */
export function visitsLast7(days: Iterable<string>, now: Date): number {
  const set = new Set(days);
  return visitsInWindow(set, glowAnchor(set, now), GLOW_WINDOW_DAYS);
}
