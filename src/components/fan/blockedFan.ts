// A4: what a fan sees when the creator has blocked them. The server refuses
// chat, wishlist edits and leaderboard opt-in for a blocked fan with 403
// `blocked`; the fan page hides those widgets and says why, kindly.
export const BLOCKED_FAN_MESSAGE =
  "This link isn't active right now, so chat and wishlists are off. Reach out to your creator if you think this is a mistake.";

// T2: chat, wishlist and leaderboard opt-in sit behind the same age and terms
// gate as the spin; the server answers 403 `needs_ack` until it is confirmed.
export const NEEDS_ACK_MESSAGE =
  "Confirm your age and agree to the terms on this page first.";

/** The fan-facing text for an error code from a fan endpoint, when it has one. */
export function blockedFanMessage(error: unknown): string | null {
  if (error === "needs_ack") return NEEDS_ACK_MESSAGE;
  return error === "blocked" ? BLOCKED_FAN_MESSAGE : null;
}
