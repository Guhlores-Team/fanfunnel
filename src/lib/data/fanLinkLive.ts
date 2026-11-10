import { fanLinkExpired } from "./unavailable";

/**
 * PR-13: one liveness test for every token-keyed fan read. A link is live
 * while it is switched on (fan_passes.is_active) and not past its expiry
 * (fan_passes.expires_at, 0073; null = never). An expired link therefore
 * answers exactly like a switched-off one on every fan route: whatever the
 * route says for `is_active = false`, it says for an expired link.
 *
 * Select LINK_LIVE with the row and hand the row to fanLinkLive. The spin
 * RPCs apply the same test in SQL; the fan page reads use fanLinkExpired
 * directly (spins.ts readFanPassRow, privacy.ts getFanLinkStatus).
 */
export const LINK_LIVE = "is_active, expires_at";

export function fanLinkLive(
  row: { is_active?: boolean | null; expires_at?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  return !!row && row.is_active === true && !fanLinkExpired(row.expires_at, now);
}
