import { NextResponse } from "next/server";
import { rateLimitShared } from "@/lib/rateLimit";

/** Best-effort client identifier from the proxy header (falls back to "local"). */
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

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
