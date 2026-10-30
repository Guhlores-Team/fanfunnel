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
}

// Mirror the mock store's globalThis pattern so the map is shared across every
// Next.js entry point.
const g = globalThis as unknown as { __ffRateLimit?: Map<string, Window> };
const store: Map<string, Window> = g.__ffRateLimit ?? (g.__ffRateLimit = new Map());

// Bound memory even when many different tokens or addresses hit one instance.
// Never evict a live counter: that would let new keys reset existing limits.
const MAX_WINDOWS = 10_000;
let nextSweep = 0;
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

  if (store.size >= MAX_WINDOWS && t >= nextSweep) {
    for (const [storedKey, window] of store) {
      if (t >= window.resetAt) store.delete(storedKey);
    }
    nextSweep = t + 1000;
  }

  if (!existing || t >= existing.resetAt) {
    if (!existing && store.size >= MAX_WINDOWS) {
      // At capacity, refuse a new identity briefly rather than allocate without
      // a bound or discard another identity's still-active counter.
      return { ok: false, retryAfter: Math.max(1, Math.min(windowMs, 1000)) };
    }
    store.set(privateKey, { count: 1, resetAt: t + windowMs });
    return { ok: true, retryAfter: 0 };
  }

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
function upstashEnv(): { url: string; token: string } | null {
  const e = process.env;
  if (e.UPSTASH_REDIS_REST_URL && e.UPSTASH_REDIS_REST_TOKEN) {
    return { url: e.UPSTASH_REDIS_REST_URL, token: e.UPSTASH_REDIS_REST_TOKEN };
  }
  if (e.KV_REST_API_URL && e.KV_REST_API_TOKEN) {
    return { url: e.KV_REST_API_URL, token: e.KV_REST_API_TOKEN };
  }
  return null;
}

// Preview and Production share one store, so namespace the counters: testing on
// a Preview must never use up a visitor's limit on the live site.
function storeKey(key: string): string {
  // Callers include fan bearer tokens and IP addresses. Do not send either as
  // readable Redis keys. This is a pseudonymous digest, not anonymization.
  return `rl:${process.env.VERCEL_ENV || "local"}:${digestKey(key)}`;
}

async function rateLimitUpstash(
  env: { url: string; token: string },
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; retryAfter: number }> {
  // One round-trip pipeline: increment this window's counter, arm its expiry only
  // if it has none (NX), and read the remaining TTL for the Retry-After header.
  const res = await fetch(`${env.url}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", key],
      ["PEXPIRE", key, String(windowMs), "NX"],
      ["PTTL", key],
    ]),
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const out = (await res.json()) as { result?: unknown; error?: unknown }[];
  if (!Array.isArray(out) || out.length !== 3 || out.some((entry) => !entry || entry.error)) {
    throw new Error("invalid rate limit pipeline");
  }
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
  if (env) {
    try {
      return await rateLimitUpstash(env, storeKey(key), limit, windowMs);
    } catch {
      // fall through to the in-memory limiter below
    }
  }
  return rateLimit(key, limit, windowMs);
}
