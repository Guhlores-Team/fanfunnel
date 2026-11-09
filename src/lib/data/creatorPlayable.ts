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
