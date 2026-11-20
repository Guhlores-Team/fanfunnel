import { createHash } from "node:crypto";
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
 * ATK-04 (batch 7): the budget counts misses ONLY and never refuses a request
 * before its token lookup. Fans on carrier-grade NAT or venue Wi-Fi share one
 * address, so an up-front refusal let one hostile neighbour lock every real
 * fan behind that address out of spinning, acking the age gate or reading
 * chat. Now:
 *   - a hit is never counted and never refused, whatever its address did;
 *   - a miss counts in the shared limiter; once the address is over its
 *     budget, its misses answer 429 (after the lookup that proved the miss);
 *   - this instance remembers over-budget addresses so a repeat miss from one
 *     answers 429 without another shared-store round trip, and remembers
 *     tokens that resolved (a short LRU of digests, never the tokens) so a
 *     known-good link skips the miss bookkeeping entirely.
 * The remaining cost of a flood from an over-budget address is one indexed
 * token lookup per request, bounded further by each route's own limiter.
 */
export const FAN_MISS_LIMIT = ROUTE_TIERS.public;

const MAX_BLOCKED = 10_000;
/** Resolved-token digests remembered per instance, and for how long. */
export const FAN_HIT_CACHE_MAX = 10_000;
export const FAN_HIT_CACHE_TTL_MS = 60_000;

const g = globalThis as unknown as { __ffFanMissBlocked?: Map<string, number>; __ffFanHits?: Map<string, number> };
const blocked = (g.__ffFanMissBlocked ??= new Map<string, number>());
const hits = (g.__ffFanHits ??= new Map<string, number>());

function tooMany(retryMs: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryMs / 1000))) } },
  );
}

/**
 * Milliseconds this address's MISSES stay refused on this instance, or 0.
 * Consulted only after a lookup answered 404: never before one.
 */
export function fanMissBlockedFor(ip: string, now = Date.now()): number {
  const until = blocked.get(ip);
  if (until === undefined) return 0;
  if (until <= now) {
    blocked.delete(ip);
    return 0;
  }
  return until - now;
}

function evictExpired<K>(map: Map<K, number>, max: number, now: number): void {
  if (map.size < max) return;
  for (const [k, until] of map) if (until <= now) map.delete(k);
  if (map.size >= max) map.delete(map.keys().next().value as K);
}

/** Count one miss for this address; true when it is now over its budget. */
export async function noteFanMiss(ip: string, now = Date.now()): Promise<{ over: boolean; retryAfter: number }> {
  const wait = fanMissBlockedFor(ip, now);
  if (wait > 0) return { over: true, retryAfter: wait };
  const { ok, retryAfter } = await rateLimitShared(`fanmiss:${ip}`, FAN_MISS_LIMIT.limit, FAN_MISS_LIMIT.windowMs);
  if (ok) return { over: false, retryAfter: 0 };
  evictExpired(blocked, MAX_BLOCKED, now);
  blocked.set(ip, now + (retryAfter || FAN_MISS_LIMIT.windowMs));
  return { over: true, retryAfter: retryAfter || FAN_MISS_LIMIT.windowMs };
}

const digest = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");

/** Remember that this token resolved (its digest only), for FAN_HIT_CACHE_TTL_MS. */
export function noteFanHit(token: string, now = Date.now()): void {
  evictExpired(hits, FAN_HIT_CACHE_MAX, now);
  hits.set(digest(token), now + FAN_HIT_CACHE_TTL_MS);
}

/** Whether this token resolved recently on this instance. */
export function fanTokenKnownGood(token: string, now = Date.now()): boolean {
  const until = hits.get(digest(token));
  if (until === undefined) return false;
  if (until <= now) {
    hits.delete(digest(token));
    return false;
  }
  return true;
}

/**
 * Run a fan route's token lookup under the miss budget: the lookup ALWAYS
 * runs; a 404 answer counts as a miss for the client address (and turns into
 * a 429 once the address is over its budget). Any other answer is returned
 * untouched and uncounted. With `token`, a link that resolved recently skips
 * the bookkeeping, and a resolving one is remembered.
 */
export async function withFanMissLimit<R extends Response>(req: Request, run: () => Promise<R>, token?: string): Promise<R | NextResponse> {
  const known = token !== undefined && fanTokenKnownGood(token);
  const res = await run();
  if (res.status !== 404) {
    if (token !== undefined && !known) noteFanHit(token);
    return res;
  }
  if (known) hits.delete(digest(token));
  const { over, retryAfter } = await noteFanMiss(clientIp(req));
  return over ? tooMany(retryAfter) : res;
}

/** Test seam: forget every block and remembered token on this instance. */
export function resetFanMissBlocks(): void {
  blocked.clear();
  hits.clear();
}
