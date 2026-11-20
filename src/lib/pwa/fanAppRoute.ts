// Shared plumbing for the token-bearing install routes (/spin/<token>/manifest
// and /spin/<token>/icon/<variant>). The token is the fan's bearer credential:
// every response here is private to the browser, never indexed, and an unknown
// or inactive token is a plain 404 that says nothing about the link.
import "server-only";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { FAN_APP_CACHE_CONTROL, NOINDEX } from "./config";

/** Per-IP, so rotating tokens can't mint fresh buckets (a page + its icons ≈ 5 requests). */
export const FAN_APP_RATE_LIMIT = { limit: 240, windowMs: 60_000 };

export function fanAppHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": FAN_APP_CACHE_CONTROL,
    "X-Robots-Tag": NOINDEX,
  };
}

export function fanAppNotFound(): NextResponse {
  return NextResponse.json(
    { error: "not_found" },
    { status: 404, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": NOINDEX } }
  );
}

export function fanAppRateLimit(req: Request): Promise<NextResponse | null> {
  return rateLimitOr429("pwa:" + clientIp(req), FAN_APP_RATE_LIMIT.limit, FAN_APP_RATE_LIMIT.windowMs);
}
