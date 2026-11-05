import { NextResponse } from "next/server";
import { rateLimitShared } from "@/lib/rateLimit";
import { clientIp } from "@/lib/api/clientIp";
import { FAN_CLIENT_HEADER } from "@/lib/api/fanClientHeader";

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

const FAN_CLIENT_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Public reads that many fans poll from behind one shared address (carrier
 * NAT, a venue's Wi-Fi). A per-address window alone refused legitimate fans
 * there (A22, stress H10: 80 of 200 fans behind two addresses got 429).
 *   perClient   one address + fan token (or one address with no token, all
 *               such callers sharing it): the old per-address limit, so a
 *               single looping tab or scraper is capped exactly as before
 *   perAddress  every request from the address, any token: the ceiling a
 *               caller rotating forged tokens reaches, and no further
 */
export const SHARED_READ_LIMITS = {
  leaderboard: { perClient: 60, perAddress: 300, windowMs: 60_000 },
  recentWins: { perClient: 120, perAddress: 600, windowMs: 60_000 },
} as const;
export type SharedRead = keyof typeof SHARED_READ_LIMITS;

/**
 * Rate-limit a shared public read: the caller's own window first (a refused
 * request does not spend its neighbours' share of the address ceiling), then
 * the per-address ceiling. Returns a ready-to-send 429, or null.
 */
export async function limitSharedRead(req: Request, read: SharedRead): Promise<NextResponse | null> {
  const { perClient, perAddress, windowMs } = SHARED_READ_LIMITS[read];
  const ip = clientIp(req);
  const raw = req.headers.get(FAN_CLIENT_HEADER);
  const client = raw && FAN_CLIENT_TOKEN.test(raw) ? `fan:${raw}` : "anonymous";
  const own = await rateLimitOr429(`shared:${read}:${ip}:${client}`, perClient, windowMs);
  if (own) return own;
  return rateLimitOr429(`shared:${read}:${ip}`, perAddress, windowMs);
}
