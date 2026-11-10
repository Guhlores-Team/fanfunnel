import { createHash } from "node:crypto";

// Fixed-window rate limiter.
//
// NOTE: This is best-effort and single-instance only. The window state lives
// in process memory (pinned to globalThis so it survives Next.js's separate
// route-handler bundles). On serverless / multi-instance deployments each
// instance keeps its own counters, so the effective limit is per-instance and
// resets on cold starts. For hard guarantees use a shared store (Redis, etc.).

interface Window {
  count: number;
  resetAt: number;
  /** The limit this window was counted against (to tell blocked from open). */
  limit: number;
}

// Mirror the mock store's globalThis pattern so the map is shared across every
// Next.js entry point.
const g = globalThis as unknown as { __ffRateLimit?: Map<string, Window> };
const store: Map<string, Window> = g.__ffRateLimit ?? (g.__ffRateLimit = new Map());

// Bound memory even when many different tokens or addresses hit one instance.
// At capacity the limiter fails OPEN on capacity, never on the count: refusing
// every new key until a window expired turned a full table (about 150 route
// scopes x client IPs, A22) into a 429 for legitimate first requests. Instead
// expired windows are swept, then a batch is evicted, chosen to cost the least
// protection: expired ones first, then windows still under their limit (forgetting
// them only restores allowance a caller had anyway), then the soonest to reset.
// A blocked caller therefore stays blocked unless the whole table is blocked.
export const RATE_LIMIT_MAX_WINDOWS = 10_000;
/** Live windows dropped per eviction, so a flood of new keys costs one sort per batch. */
export const RATE_LIMIT_EVICT_BATCH = 500;
let nextSweep = 0;

function makeRoom(t: number): void {
  if (t >= nextSweep) {
    for (const [storedKey, window] of store) {
      if (t >= window.resetAt) store.delete(storedKey);
    }
    nextSweep = t + 1000;
  }
  if (store.size < RATE_LIMIT_MAX_WINDOWS) return;
  const victims = [...store.entries()]
    .sort(([, a], [, b]) => Number(t < a.resetAt) - Number(t < b.resetAt) || Number(a.count >= a.limit) - Number(b.count >= b.limit) || a.resetAt - b.resetAt)
    .slice(0, Math.max(1, store.size - RATE_LIMIT_MAX_WINDOWS + RATE_LIMIT_EVICT_BATCH));
  for (const [storedKey] of victims) store.delete(storedKey);
}
function digestKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): { ok: boolean; retryAfter: number } {
  const t = now();
  const privateKey = digestKey(key);
  const existing = store.get(privateKey);

  if (!existing || t >= existing.resetAt) {
    if (!existing && store.size >= RATE_LIMIT_MAX_WINDOWS) makeRoom(t);
    store.set(privateKey, { count: 1, resetAt: t + windowMs, limit });
    return { ok: true, retryAfter: 0 };
  }

  existing.limit = limit;
  if (existing.count >= limit) {
    return { ok: false, retryAfter: existing.resetAt - t };
  }

  existing.count += 1;
  return { ok: true, retryAfter: 0 };
}

// --- Serverless-safe variant ------------------------------------------------
// On Vercel/multi-instance, the in-memory limiter above is per-instance. When an
// Upstash REST URL + token are set, counters live in Upstash Redis (shared across
// every instance) instead. Unconfigured — or if the store call fails — it
// transparently falls back to the in-memory limiter, so a Redis blip can never
// take a route down.

// Upstash's own names, or the KV_REST_API_* names Vercel's Upstash integration
// injects. Taken as a pair so a URL is never sent with the other store's token.
// RS-08: a URL pasted with a trailing slash would build `//pipeline` and fall
// back forever; strip it.
const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");
export function upstashEnv(e: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) {
    return { url: trimUrl(e.UPSTASH_REDIS_REST_URL), token: e.UPSTASH_REDIS_REST_TOKEN };
  }
  if (e.KV_REST_API_URL && e.KV_REST_API_TOKEN) {
    return { url: trimUrl(e.KV_REST_API_URL), token: e.KV_REST_API_TOKEN };
  }
  return null;
}

/** Whether counters are shared across instances (a configured Upstash/KV store). */
export function hasSharedRateLimitStore(env: Record<string, string | undefined> = process.env): boolean {
  return upstashEnv(env) !== null;
}

/**
 * Production without a shared store: every limit is per serverless instance,
 * so a flood spread over instances (or cold starts) multiplies it. Reported by
 * the maintenance cron and shown in Admin › System health.
 */
export function sharedRateLimitStoreMissing(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production" && !hasSharedRateLimitStore(env);
}

// Preview and Production share one store, so namespace the counters: testing on
// a Preview must never use up a visitor's limit on the live site.
function storeKey(key: string): string {
  // Callers include fan bearer tokens and IP addresses. Do not send either as
  // readable Redis keys. This is a pseudonymous digest, not anonymization.
  return `rl:${process.env.VERCEL_ENV || "local"}:${digestKey(key)}`;
}

/**
 * OPS-10: how long one shared-store call may take before the in-memory limiter
 * answers instead. Upstash normally replies in tens of milliseconds; a fan's
 * shared read makes two calls in a row, so an outage costs at most twice this.
 */
export const RATE_LIMIT_STORE_TIMEOUT_MS = 800;
/** At most one alertable capture per instance per window while the store fails. */
export const RATE_LIMIT_FALLBACK_ALERT_WINDOW_MS = 60 * 60 * 1000;

/**
 * RS-06: after a store failure this instance skips the store for this long
 * (every request paid the full timeout for the whole outage before), then
 * tries once more; a success ends the cooldown, a failure starts another.
 */
export const RATE_LIMIT_STORE_COOLDOWN_MS = 30_000;

const fallbackState = globalThis as unknown as { __ffRateLimitFallbackAt?: number; __ffRateLimitSkipUntil?: number };

/** When this instance last fell back from the shared store (ISO), or null. Shown in System health. */
export function rateLimitStoreLastFallbackAt(): string | null {
  const at = fallbackState.__ffRateLimitFallbackAt;
  return typeof at === "number" ? new Date(at).toISOString() : null;
}

/** Milliseconds until this instance tries the shared store again, or 0. */
export function rateLimitStoreSkipFor(now = Date.now()): number {
  const until = fallbackState.__ffRateLimitSkipUntil;
  return typeof until === "number" && until > now ? until - now : 0;
}

/** Test seam: end the cooldown. */
export function resetRateLimitStoreCooldown(): void {
  delete fallbackState.__ffRateLimitSkipUntil;
}

/**
 * Raises the alertable capture. Imported lazily because the capture pipeline
 * itself uses this module; an object so rateLimitFallback.test.ts can swap
 * it without module mocking (a lazily imported module is not reliably mockable).
 */
export const fallbackReporter = {
  report: async (): Promise<void> => (await import("@/lib/monitoring/opsAlerts")).reportRateLimitFallback(),
};

function noteStoreFallback(): void {
  const now = Date.now();
  fallbackState.__ffRateLimitFallbackAt = now;
  fallbackState.__ffRateLimitSkipUntil = now + RATE_LIMIT_STORE_COOLDOWN_MS;
  if (!rateLimit("ops-alert:rate-limit-fallback", 1, RATE_LIMIT_FALLBACK_ALERT_WINDOW_MS).ok) return;
  void fallbackReporter.report().catch(() => undefined);
}

async function pipeline(env: { url: string; token: string }, commands: string[][]): Promise<{ result?: unknown; error?: unknown }[]> {
  const res = await fetch(`${env.url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
    cache: "no-store",
    signal: AbortSignal.timeout(RATE_LIMIT_STORE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const out = (await res.json()) as { result?: unknown; error?: unknown }[];
  if (!Array.isArray(out) || out.length !== commands.length || out.some((entry) => !entry || entry.error)) {
    throw new Error("invalid rate limit pipeline");
  }
  return out;
}

async function rateLimitUpstash(
  env: { url: string; token: string },
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfter: number }> {
  // One round-trip pipeline: increment this window's counter, arm its expiry only
  // if it has none (NX), and read the remaining TTL for the Retry-After header.
  const out = await pipeline(env, [
    ["INCR", key],
    ["PEXPIRE", key, String(windowMs), "NX"],
    ["PTTL", key],
  ]);
  const count = Number(out[0]?.result);
  const pttl = Number(out[2]?.result);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(pttl)) {
    throw new Error("invalid rate limit counter");
  }
  if (count <= limit) return { ok: true, retryAfter: 0 };
  return { ok: false, retryAfter: pttl > 0 ? pttl : windowMs };
}

/**
 * Serverless-safe rate limit. Uses a shared Upstash Redis store when configured
 * (so the limit holds across all instances), otherwise the in-memory limiter.
 * Always resolves: a store error degrades to in-memory rather than 500ing.
 */
export async function rateLimitShared(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfter: number }> {
  const env = upstashEnv();
  if (env && rateLimitStoreSkipFor() === 0) {
    try {
      return await rateLimitUpstash(env, storeKey(key), limit, windowMs);
    } catch {
      // fall through to the in-memory limiter below, visibly (OPS-10), and
      // skip the store for RATE_LIMIT_STORE_COOLDOWN_MS (RS-06)
      noteStoreFallback();
    }
  }
  return rateLimit(key, limit, windowMs);
}
