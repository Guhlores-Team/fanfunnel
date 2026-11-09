/**
 * T4: "oldest 3d" next to a creator's pending-prize count in Admin, so a
 * creator sitting on owed prizes stands out. Whole days, rounded down; under a
 * day reads "<1d". Null when there is no pending prize or the clock isn't known.
 */
export function pendingAgeLabel(oldestPendingAt: string | null | undefined, now: number | null): string | null {
  if (!oldestPendingAt || now === null) return null;
  const at = Date.parse(oldestPendingAt);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  return days < 1 ? "<1d" : `${days}d`;
}

/** Days after which an owed prize reads as overdue in Admin. */
export const PENDING_AGE_WARN_DAYS = 14;

export function pendingAgeOverdue(oldestPendingAt: string | null | undefined, now: number | null): boolean {
  if (!oldestPendingAt || now === null) return false;
  const at = Date.parse(oldestPendingAt);
  return Number.isFinite(at) && now - at >= PENDING_AGE_WARN_DAYS * 86_400_000;
}
