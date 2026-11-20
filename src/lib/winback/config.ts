// Win-back DM automation (RM-5): the knobs, in one place. Isomorphic (no
// server imports) so the data layer, the routes and the dashboard read the
// same values.

/**
 * Owner decision D6, "what does automation mean?":
 *   "copy"  — (a) a one-tap Copy DM per fan on the win-back list;
 *   "queue" — (b) (a) plus "Start win-back": a queue that copies the filled
 *             message, marks the fan contacted and moves to the next one.
 * Default (b). Option (c), auto-sending an in-app chat message, is deliberately
 * not built: FanFunnel never sends anything to a fan on the creator's behalf.
 */
export type WinbackMode = "copy" | "queue";
export const WINBACK_MODE: WinbackMode = "queue";

/** A paying fan is "quiet" once their last spin is this many days old. */
export const WINBACK_QUIET_DAYS = 14;

/**
 * Spend safety: after a fan is contacted they stay off the list for at least
 * this long. Hard-coded on purpose (proposal RM-5): not a creator setting.
 */
export const WINBACK_CONTACT_COOLDOWN_DAYS = 14;

/** The queue's "Snooze" hides a fan for this long without contacting them. */
export const WINBACK_SNOOZE_DAYS = 30;

/** "6 contacted · 2 came back" counts contacts from this many days back. */
export const WINBACK_RESULTS_WINDOW_DAYS = 30;

/** How many quiet fans the list (and so the queue) holds, highest spend first. */
export const WINBACK_LIST_LIMIT = 20;

/** How many "Recently contacted" rows the card shows. */
export const WINBACK_RECENT_LIMIT = 5;

/**
 * The message used when the creator has no saved template (or picks this one).
 * Tokens are filled by fillTemplate; see TEMPLATE_TOKENS.
 */
export const DEFAULT_WINBACK_TEMPLATE = {
  id: "winback-default",
  title: "Win-back (default)",
  body: "Hey {name}! It's been {days} days since your {lastWin} — I saved you a fresh spin: {link}",
} as const;

/** What an outreach row records. */
export type OutreachAction = "contacted" | "snoozed";
export const OUTREACH_ACTIONS: readonly OutreachAction[] = ["contacted", "snoozed"];
