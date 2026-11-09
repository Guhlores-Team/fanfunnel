/**
 * Default per-client ceilings for route handlers (A22). They sit in front of
 * every route that has no stricter limiter of its own; the authoritative
 * guards (auth, RLS, can_act_for, the database's per-fan windows) still apply.
 *   public   unauthenticated reads (teasers, share cards, leaderboards)
 *   account  signed-in dashboard reads/writes (generous: a busy tab polls)
 *   costly   work that fans out or stores bulk input (DNS lookups, pastes)
 */
export const ROUTE_TIERS = {
  public: { limit: 120, windowMs: 60_000 },
  account: { limit: 300, windowMs: 60_000 },
  costly: { limit: 30, windowMs: 60_000 },
} as const;
export type RouteTier = keyof typeof ROUTE_TIERS;
