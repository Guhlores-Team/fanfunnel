// Visit glow (RM-3): the knobs, in one place. Isomorphic (no server imports) so
// the fan page, the check-in route, the data layer and the dashboard read the
// same values.
//
// Absolute rule: a visit NEVER grants spins or changes odds. Nothing here is
// read by the spin engine, claim_spin or any balance write.

/**
 * How the glow counts visits (owner decision D5).
 *  - "rolling":     days visited out of the last GLOW_WINDOW_DAYS. No reset cliff.
 *  - "streak":      consecutive days ending today (or yesterday); resets to 0.
 *  - "streakGrace": a consecutive-day streak that forgives GLOW_GRACE_DAYS missed day(s).
 */
export type GlowMode = "rolling" | "streak" | "streakGrace";

/**
 * D5 default: rolling. A classic streak (and the grace-day variant) creates the
 * "don't break the chain" pressure the research warns against; the rolling
 * glow gives the momentum without a loss moment. Flip here.
 */
export const GLOW_MODE: GlowMode = "rolling";

/** The rolling window the glow and the creator's "Visited N of last 7 days" use. */
export const GLOW_WINDOW_DAYS = 7;

/** Missed days a "streakGrace" streak forgives (unused in the default mode). */
export const GLOW_GRACE_DAYS = 1;

/**
 * Glow levels by visit count: 1–2 faint ring, 3–4 warm, 5+ full brand glow
 * with the "Regular ✨" tag. Each entry is the minimum count for that level.
 */
export const GLOW_LEVEL_MIN = { faint: 1, warm: 3, full: 5 } as const;

/** A "Regular": full glow for the fan, and the creator's "Regulars" filter. */
export const REGULAR_MIN_VISITS = GLOW_LEVEL_MIN.full;

export type GlowMilestoneId = "week" | "month";
export interface GlowMilestone {
  id: GlowMilestoneId;
  visits: number;
  windowDays: number;
}

/**
 * One-time celebrations (no reward, ever). Listed biggest first: when two land
 * on the same day only the first is shown. A milestone celebrates once and
 * comes back only after a full window in which it was not reached.
 */
export const GLOW_MILESTONES: readonly GlowMilestone[] = [
  { id: "month", visits: 20, windowDays: 30 },
  { id: "week", visits: 7, windowDays: 7 },
];

/** Toast copy. `{creator}` is the creator's display name. Never loss-framed. */
export const GLOW_MILESTONE_COPY: Record<GlowMilestoneId, string> = {
  week: "You've stopped by every day this week — {creator} sees you 💖",
  month: "You've stopped by 20 days this month — {creator} sees you 💖",
};

/** How long the milestone toast stays before it tucks itself away. */
export const GLOW_TOAST_MS = 8000;

/**
 * The fan sends their own calendar date so a visit lands on THEIR day. It is
 * clamped to the server's UTC date ± this many days, so it can't be backfilled.
 */
export const CHECKIN_DATE_SKEW_DAYS = 1;

/** Days of check-ins a check-in reads back: enough to decide every milestone. */
export const CHECKIN_READ_DAYS =
  2 * Math.max(GLOW_WINDOW_DAYS, ...GLOW_MILESTONES.map((m) => m.windowDays)) - 1;

/** POST /api/fan/checkin: per IP + link token. A page load sends one. */
export const CHECKIN_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;
