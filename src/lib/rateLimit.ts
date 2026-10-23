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

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): { ok: boolean; retryAfter: number } {
  const t = now();
  const existing = store.get(key);

  if (!existing || t >= existing.resetAt) {
    store.set(key, { count: 1, resetAt: t + windowMs });
    return { ok: true, retryAfter: 0 };
  }

  if (existing.count >= limit) {
    return { ok: false, retryAfter: existing.resetAt - t };
  }

  existing.count += 1;
  return { ok: true, retryAfter: 0 };
}

// --- Serverless-safe variant ------------------------------------------------
// On Vercel/multi-instance, the in-memory limiter above is per-instance. When
// UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, counters live in
// Upstash Redis (shared across every instance) instead. Unconfigured — or if the
// store call fails — it transparently falls back to the in-memory limiter, so a
// Redis blip can never take a route down.

function upstashEnv(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
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
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const out = (await res.json()) as { result: number }[];
  const count = Number(out[0]?.result ?? 0);
  const pttl = Number(out[2]?.result ?? windowMs);
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
      return await rateLimitUpstash(env, key, limit, windowMs);
    } catch {
      // fall through to the in-memory limiter below
    }
  }
  return rateLimit(key, limit, windowMs);
}
