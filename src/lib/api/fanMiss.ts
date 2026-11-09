import { NextResponse } from "next/server";
import { rateLimitShared } from "@/lib/rateLimit";
import { clientIp } from "@/lib/api/clientIp";
import { ROUTE_TIERS } from "@/lib/api/routeTiers";

/**
 * C2 (batch 6 attack audit): fan routes are keyed on the link token, so a
 * caller sending a fresh random token every time never met a limit, and each
 * request was a service-role lookup. This caps the lookups that MISS (an
 * unknown, ended or invalid token: the 404) per client address, across every
 * fan route and page, at the `public` tier (ROUTE_TIERS.public).
 *
 *   - A hit is never counted and costs nothing extra: the only check before
 *     the lookup is this instance's in-memory block list (no network).
 *   - A miss counts in the shared limiter. Once an address is over its budget
 *     the miss answers 429, and this instance refuses that address before any
 *     lookup until the window resets. Other instances learn it on their next
 *     miss from it, so at most one extra lookup per instance gets through.
 */
export const FAN_MISS_LIMIT = ROUTE_TIERS.public;

const MAX_BLOCKED = 10_000;
const g = globalThis as unknown as { __ffFanMissBlocked?: Map<string, number> };
const blocked = (g.__ffFanMissBlocked ??= new Map<string, number>());

function tooMany(retryMs: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryMs / 1000))) } },
  );
}

/** Milliseconds this address stays refused on this instance, or 0. */
export function fanMissBlockedFor(ip: string, now = Date.now()): number {
  const until = blocked.get(ip);
  if (until === undefined) return 0;
  if (until <= now) {
    blocked.delete(ip);
    return 0;
  }
  return until - now;
}

/** Count one miss for this address; true when it is now over its budget. */
export async function noteFanMiss(ip: string, now = Date.now()): Promise<{ over: boolean; retryAfter: number }> {
  const { ok, retryAfter } = await rateLimitShared(`fanmiss:${ip}`, FAN_MISS_LIMIT.limit, FAN_MISS_LIMIT.windowMs);
  if (ok) return { over: false, retryAfter: 0 };
  if (blocked.size >= MAX_BLOCKED) {
    for (const [k, until] of blocked) if (until <= now) blocked.delete(k);
    if (blocked.size >= MAX_BLOCKED) blocked.delete(blocked.keys().next().value as string);
  }
  blocked.set(ip, now + (retryAfter || FAN_MISS_LIMIT.windowMs));
  return { over: true, retryAfter: retryAfter || FAN_MISS_LIMIT.windowMs };
}

/**
 * Run a fan route's token lookup under the miss budget: refused up front while
 * this address is blocked, otherwise a 404 answer counts as a miss (and turns
 * into a 429 once the address is over its budget). Any other answer is
 * returned untouched and uncounted.
 */
export async function withFanMissLimit<R extends Response>(req: Request, run: () => Promise<R>): Promise<R | NextResponse> {
  const ip = clientIp(req);
  const wait = fanMissBlockedFor(ip);
  if (wait > 0) return tooMany(wait);
  const res = await run();
  if (res.status !== 404) return res;
  const { over, retryAfter } = await noteFanMiss(ip);
  return over ? tooMany(retryAfter) : res;
}

/** Test seam: forget every block on this instance. */
export function resetFanMissBlocks(): void {
  blocked.clear();
}
