/**
 * FD-3: whether a creator's fan links may be played. The same test
 * prepare_spin_attempt applies under its locks (0071): an active profile that
 * is approved, or an admin. A missing profile is not playable.
 */
export function creatorCanHostPlay(
  creator: { is_active?: boolean | null; approval_status?: string | null; role?: string | null } | null | undefined,
): boolean {
  return !!creator && creator.is_active === true && (creator.approval_status === "approved" || creator.role === "admin");
}

/**
 * The embed a fan_passes read adds to learn that standing in the same round
 * trip; the row's `creator` then goes to creatorCanHostPlay.
 * A suspended creator is read-only (WU-01), and so is everything a fan's link
 * can do TO them: the page and every play already answer "link not active",
 * and so do the fan routes that write to the creator's account or reach their
 * devices (chat, the wishlist, the board, the visit check-in, the age gate).
 * What stays open is the fan's own: a break, pausing the link, a report, the
 * data download and deletion, reopening a reward already won.
 */
export const CREATOR_STANDING = "creator:profiles(is_active, approval_status, role)";
export type CreatorStanding = { is_active?: boolean | null; approval_status?: string | null; role?: string | null } | null;
