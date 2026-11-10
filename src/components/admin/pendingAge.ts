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

/** WG-18: how long an access request has waited, in whole days ("today", "1 day ago", "9 days ago"). */
export function requestAgeLabel(createdAt: string | null | undefined, now: number | null): string | null {
  if (!createdAt || now === null) return null;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at)) return null;
  const days = Math.floor(Math.max(0, now - at) / 86_400_000);
  return days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

/** Days after which a waiting access request is flagged in Admin. */
export const REQUEST_AGE_WARN_DAYS = 7;

export function requestOverdue(createdAt: string | null | undefined, now: number | null): boolean {
  if (!createdAt || now === null) return false;
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && now - at >= REQUEST_AGE_WARN_DAYS * 86_400_000;
}

/** WG-18: accounts shown before "Show more" in Admin. */
export const ADMIN_ACCOUNTS_PAGE = 25;

/** WG-18: accounts whose name or e-mail contains the search text (case-insensitive). */
export function filterAccounts<T extends { displayName?: string | null; email?: string | null }>(accounts: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...accounts];
  return accounts.filter((a) => (a.displayName ?? "").toLowerCase().includes(q) || (a.email ?? "").toLowerCase().includes(q));
}

/** Days after which an owed prize reads as overdue in Admin. */
export const PENDING_AGE_WARN_DAYS = 14;

export function pendingAgeOverdue(oldestPendingAt: string | null | undefined, now: number | null): boolean {
  if (!oldestPendingAt || now === null) return false;
  const at = Date.parse(oldestPendingAt);
  return Number.isFinite(at) && now - at >= PENDING_AGE_WARN_DAYS * 86_400_000;
}
