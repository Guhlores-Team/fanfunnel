// Which wheel pass a grant's spin-count edit moves. editGrant (Supabase + mock)
// applies it to change the balance, and getFanDetail applies it to report each
// grant's preview balance, so the drawer's preview and the server can't pick
// different passes.

export interface GrantPassCandidate {
  id: string;
  isActive: boolean;
}

/**
 * The grant's own pass (grants.fan_pass_id) while it exists and is active;
 * otherwise the fan's oldest active pass (the 0020 attribution convention);
 * null when the fan has no active pass (editGrant then refuses a spin change as
 * no_active_pass).
 *
 * `passesOldestFirst` is all of the fan's passes in creation order
 * (created_at, then id as the tie-break).
 */
export function pickGrantPass<P extends GrantPassCandidate>(
  passesOldestFirst: readonly P[],
  grantPassId: string | null | undefined
): P | null {
  if (grantPassId) {
    const own = passesOldestFirst.find((p) => p.id === grantPassId);
    if (own?.isActive) return own;
  }
  return passesOldestFirst.find((p) => p.isActive) ?? null;
}
