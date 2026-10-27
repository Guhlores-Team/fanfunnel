// Spend-awareness guardrail for fans (RM-6): the knobs, in one place.
// Isomorphic (no server imports) so the fan page, the API routes and the data
// layer read the same values.

/**
 * Owner decision D3: what a fan sees about their own play.
 *  - "counts"        (default) "12 spins today · 38 this week", always.
 *  - "reminder_only" nothing until the fan sets a reminder.
 * Dollar amounts are deliberately not an option here: they are entered by the
 * creator off-platform, can be wrong, and the research says never to show
 * spend totals to the fan. Adding them would need new fan-facing data.
 */
export type PlayVisibility = "counts" | "reminder_only";
export const PLAY_VISIBILITY: PlayVisibility = "counts";

/**
 * Owner decision D4: can a creator switch the guardrail off? Default false:
 * it is platform-wide. A guardrail the person profiting can turn off doesn't
 * protect the brand or the payment-processor relationship. Breaks are always
 * enforced on the server either way (they are the fan's own choice); this only
 * governs whether a creator opt-out may hide the "Your play" card. No creator
 * setting exists while this is false.
 */
export const CREATOR_CAN_DISABLE_PLAY_GUARD = false;

/** The daily reminder choices offered to the fan ("Off" is null). */
export const PLAY_REMINDER_OPTIONS = [20, 50, 100] as const;
export type PlayReminder = (typeof PLAY_REMINDER_OPTIONS)[number];
/** Bounds of fan_play_reminders.daily (migration 0049's CHECK). */
export const PLAY_REMINDER_MIN = 10;
export const PLAY_REMINDER_MAX = 500;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The break lengths a fan can choose. A break can't be shortened once taken. */
export const BREAK_OPTIONS = [
  { id: "24h", label: "24 hours", ms: DAY_MS },
  { id: "7d", label: "7 days", ms: 7 * DAY_MS },
  { id: "30d", label: "30 days", ms: 30 * DAY_MS },
] as const;
export type BreakOptionId = (typeof BREAK_OPTIONS)[number]["id"];

/** Longest break end the server accepts (fan_take_break's bound, 31 days). */
export const BREAK_MAX_MS = 31 * DAY_MS;

/** Rolling windows for "today" and "this week" (no time-zone games). */
export const PLAY_TODAY_WINDOW_MS = DAY_MS;
export const PLAY_WEEK_WINDOW_MS = 7 * DAY_MS;

/** The reminder card shows once per threshold per this window. */
export const REMINDER_ACK_WINDOW_MS = DAY_MS;
export const REMINDER_ACK_STORAGE_KEY = "ff.playReminder.ack";

/** Per IP + token, for the fan's reminder and break routes. */
export const PLAY_ROUTE_LIMIT = 10;
export const PLAY_ROUTE_WINDOW_MS = 60_000;
