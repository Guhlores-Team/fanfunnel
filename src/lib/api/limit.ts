import { NextResponse } from "next/server";
import { rateLimitShared } from "@/lib/rateLimit";
import { clientIp } from "@/lib/api/clientIp";

/**
 * Apply a fixed-window rate limit. Returns a ready-to-send 429 response when the
 * caller is over the limit, or null when the request may proceed.
 *
 * Backed by `rateLimitShared`: a shared Upstash store when configured (hard
 * cross-instance limit), otherwise the in-process limiter (best-effort).
 */
export async function rateLimitOr429(
  key: string,
  limit: number,
  windowMs: number,
): Promise<NextResponse | null> {
  const { ok, retryAfter } = await rateLimitShared(key, limit, windowMs);
  if (ok) return null;
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfter / 1000)) } },
  );
}

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

/**
 * Rate-limit one route handler call per client IP and route scope. Returns a
 * ready-to-send 429, or null when the request may proceed:
 *
 *   const limited = await limitRoute(req, "campaigns:list");
 *   if (limited) return limited;
 */
export function limitRoute(req: Request, scope: string, tier: RouteTier = "account"): Promise<NextResponse | null> {
  const { limit, windowMs } = ROUTE_TIERS[tier];
  return rateLimitOr429(`route:${scope}:${clientIp(req)}`, limit, windowMs);
}
