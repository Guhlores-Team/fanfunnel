// Pure helpers for the spend-awareness guardrail (RM-6) and the engagement
// gate (shared foundation F6). Isomorphic and side-effect free, so the fan
// page, the creator dashboard, the mock store and the Supabase path all decide
// the same way, and the logic is unit-tested.
import {
  BREAK_MAX_MS,
  BREAK_OPTIONS,
  CREATOR_CAN_DISABLE_PLAY_GUARD,
  PLAY_REMINDER_OPTIONS,
  PLAY_TODAY_WINDOW_MS,
  PLAY_VISIBILITY,
  PLAY_WEEK_WINDOW_MS,
  type BreakOptionId,
  type PlayReminder,
} from "./config";

const toMs = (v: string | number | Date): number =>
  typeof v === "number" ? v : v instanceof Date ? v.getTime() : Date.parse(v);

/** True while a break is in force (it ends on its own at `breakUntil`). */
export function isOnBreak(breakUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!breakUntil) return false;
  const end = Date.parse(breakUntil);
  return Number.isFinite(end) && end > now;
}

/** What the engagement gate needs to know about a fan. */
export interface EngagementState {
  /** The creator blocked this fan. */
  blocked?: boolean;
  /** The fan paused (self-excluded) one of their links. */
  selfExcluded?: boolean;
  /** When the fan's break ends (null / past = not on a break). */
  breakUntil?: string | null;
}

/**
 * F6 engagement gate. Every "come back / keep going" surface asks this first:
 * the install nudge, the win-back list, the out-of-spins bell item, Copy DM and
 * top-up in the fan drawer, and later the streak glow and push about a fan.
 * False when the fan is blocked, paused a link, or is on a break.
 */
export function fanEngagementAllowed(fan: EngagementState, now: number = Date.now()): boolean {
  if (fan.blocked || fan.selfExcluded) return false;
  // An unreadable break date fails closed: treat the fan as on a break.
  if (fan.breakUntil && !Number.isFinite(Date.parse(fan.breakUntil))) return false;
  return !isOnBreak(fan.breakUntil, now);
}

/** A reminder the fan may choose: null (off) or one of the offered numbers. */
export function isPlayReminder(v: unknown): v is PlayReminder | null {
  return v === null || (typeof v === "number" && (PLAY_REMINDER_OPTIONS as readonly number[]).includes(v));
}

/** The duration of a break option, or null for an unknown id. */
export function breakDurationMs(id: unknown): number | null {
  const opt = BREAK_OPTIONS.find((o) => o.id === id);
  return opt ? opt.ms : null;
}
export function isBreakOption(id: unknown): id is BreakOptionId {
  return breakDurationMs(id) !== null;
}

/**
 * The break end after asking for one of `durationMs`: never earlier than a
 * break already in force (the same rule as fan_take_break's
 * greatest(coalesce(break_until, now()), new) in migration 0049).
 */
export function lengthenBreak(current: string | null | undefined, durationMs: number, now: number = Date.now()): string {
  const requested = now + Math.min(Math.max(durationMs, 0), BREAK_MAX_MS);
  const held = current ? Date.parse(current) : NaN;
  return new Date(Number.isFinite(held) && held > requested ? held : requested).toISOString();
}

/** Rolling "today" (24h) and "this week" (7d) spin counts from spin times. */
export function countPlay(times: readonly (string | number | Date)[], now: number = Date.now()): { today: number; week: number } {
  let today = 0;
  let week = 0;
  for (const t of times) {
    const at = toMs(t);
    if (!Number.isFinite(at) || at > now) continue;
    const age = now - at;
    if (age < PLAY_WEEK_WINDOW_MS) week++;
    if (age < PLAY_TODAY_WINDOW_MS) today++;
  }
  return { today, week };
}

/** True once today's spins have reached the fan's reminder. */
export function reminderDue(today: number, reminder: number | null | undefined): boolean {
  return typeof reminder === "number" && reminder > 0 && today >= reminder;
}

/** D3: whether the fan sees their spin counts ("12 spins today · 38 this week"). */
export function playCountsVisible(reminder: number | null | undefined): boolean {
  return PLAY_VISIBILITY === "counts" || typeof reminder === "number";
}

/**
 * D4: whether the soft daily reminder is offered. Always, with the default
 * (platform-wide); a creator opt-out only counts if D4 is flipped. Taking a
 * break is the fan's own protection and is never switched off.
 */
export function remindersEnabled(creatorOptedOut = false): boolean {
  return !(CREATOR_CAN_DISABLE_PLAY_GUARD && creatorOptedOut);
}
