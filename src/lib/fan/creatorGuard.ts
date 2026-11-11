import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient, createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { mockTokenHasCreator } from "@/lib/data/mock";
import { clientIp } from "@/lib/api/clientIp";
import { ROUTE_TIERS } from "@/lib/api/routeTiers";
import { rateLimitShared } from "@/lib/rateLimit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

/**
 * ATK-01 / TS-05: the fan's own actions (age and terms acknowledgement,
 * leaderboard consent, pausing the link, reopening a reward, taking a break,
 * downloading or deleting their data) are keyed on the link token, which the
 * creator also holds. A creator (or a team member who can act for them)
 * signed in on the same browser must not be able to stamp consent or erase a
 * fan with that token. The request's session cookie is read with the normal
 * server client and checked with `can_act_for` (server-controlled roles,
 * AGENTS.md rules 1-2); nothing the client sends decides this.
 *
 * Cost for fans: zero. Without a Supabase session cookie nothing is looked up
 * and nothing is counted.
 *
 * Order: the guard answers BEFORE the fan's own limits (the miss budget of
 * fanMiss.ts and each route's windows). A request that carries a session never
 * spends the fan's budget, and the 403 does not depend on what that address or
 * link did earlier. Its lookups still need a cap (C2: a made-up cookie with a
 * fresh random token per request must not buy a service-role read each time),
 * so requests that carry a session cookie have a per-address budget of their
 * own, GUARD_LIMIT, counted before the lookup.
 */
export const GUARD_LIMIT = ROUTE_TIERS.public;
export const CREATOR_SESSION_ERROR = "creator_session";
export const CREATOR_SESSION_MESSAGE =
  "This is the fan's own action. You're signed in as a creator or team member for this fan's creator, so it can't be done from this account. Sign out, or open the fan's link in a private window to help them.";

// Supabase's auth cookie: sb-<project-ref>-auth-token, possibly chunked (.0, .1).
const AUTH_COOKIE = /^sb-[A-Za-z0-9_-]+-auth-token(\.\d+)?$/;

/** Does the request carry a Supabase session cookie at all? (No network.) */
export function isSessionCookieName(name: string): boolean {
  return AUTH_COOKIE.test(name);
}

async function hasSessionCookie(): Promise<boolean> {
  try {
    return (await cookies()).getAll().some((c) => isSessionCookieName(c.name));
  } catch {
    // Outside a request scope (unit tests, build): no cookie, no session.
    return false;
  }
}

/** The creator behind a fan token, whatever the pass's state; null for an unknown token. */
async function creatorOfToken(token: string): Promise<string | null> {
  if (!isSupabaseConfigured()) return mockTokenHasCreator(token) ? "demo" : null;
  const { data } = await createServiceClient().from("fan_passes").select("creator_id").eq("token", token).maybeSingle();
  return (data as { creator_id: string } | null)?.creator_id ?? null;
}

/** True when the request's signed-in user may act for the creator who owns this fan token. */
export async function creatorActsForFan(token: string): Promise<boolean> {
  if (!(await hasSessionCookie())) return false;
  const creatorId = await creatorOfToken(token);
  if (!creatorId) return false;
  // Demo mode has one creator, who owns every demo fan: a session cookie is them.
  if (!isSupabaseConfigured()) return true;
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return false;
  const { data, error } = await session.rpc("can_act_for", { target_creator: creatorId, perm: "view" });
  // A signed-in user whose permission could not be read is refused, not waved
  // through: the guard must not open when the check itself fails.
  return error ? true : data === true;
}

/**
 * The answer a fan-only route gives before anything else when the request
 * carries a session: 403 when that session may act for the fan's creator, 429
 * when this address is over the guard's own budget, else null (carry on as a
 * fan). Call it first, ahead of withFanMissLimit and every rateLimitOr429.
 */
export async function refuseCreatorSession(req: Request, token: string): Promise<NextResponse | null> {
  if (!(await hasSessionCookie())) return null;
  const { ok, retryAfter } = await rateLimitShared(`creatorguard:${clientIp(req)}`, GUARD_LIMIT.limit, GUARD_LIMIT.windowMs);
  if (!ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(Math.max(1, Math.ceil(retryAfter / 1000))) } },
    );
  }
  if (!(await creatorActsForFan(token))) return null;
  return NextResponse.json(
    { error: CREATOR_SESSION_ERROR, message: CREATOR_SESSION_MESSAGE },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}
