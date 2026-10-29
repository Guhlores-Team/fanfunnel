// A4: what a fan sees when the creator has blocked them. The server refuses
// chat, wishlist edits and leaderboard opt-in for a blocked fan with 403
// `blocked`; the fan page hides those widgets and says why, kindly.
export const BLOCKED_FAN_MESSAGE =
  "This link isn't active right now, so chat and wishlists are off. Reach out to your creator if you think this is a mistake.";

/** The fan-facing text for an error code from a fan endpoint, when it has one. */
export function blockedFanMessage(error: unknown): string | null {
  return error === "blocked" ? BLOCKED_FAN_MESSAGE : null;
}
