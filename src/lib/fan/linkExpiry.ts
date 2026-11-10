// PR-13 (0073): fan_passes.expires_at (null = never). An expired link answers
// like a switched-off one everywhere: the ledger refuses its spins in SQL, and
// the fan page and the token-keyed fan routes check it with these helpers.

/** Pure: whether a link with this expiry has ended at `now`. */
export function linkExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now;
}
