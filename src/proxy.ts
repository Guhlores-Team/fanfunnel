import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { needsSessionRefresh, updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed the `middleware` file convention to `proxy` (same behavior).
// This refreshes the Supabase session before the auth pages render. It runs
// only where `needsSessionRefresh` says a refresh is needed. The extra percent
// matcher rejects malformed encoding before Next's dynamic routing can turn it
// into an unmonitored 500. Valid public/API paths never refresh auth here.
// Security headers come from next.config.ts, not from here.
export async function proxy(request: NextRequest, event: NextFetchEvent) {
  try {
    decodeURIComponent(request.nextUrl.pathname);
  } catch {
    // Never send attacker-controlled paths, queries, headers or tokens to the
    // monitor. waitUntil is Next16's supported Proxy background-work hook.
    event.waitUntil(import("@/lib/monitoring/capture").then(({ captureServerError }) =>
      captureServerError(new Error("Malformed URL encoding rejected"), {}, { routePath: "/[invalid-encoding]", routeType: "proxy" })
    ).catch(() => { /* monitoring cannot change the safe response */ }));
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (!needsSessionRefresh(request.nextUrl.pathname)) return NextResponse.next();
  return await updateSession(request);
}

export const config = {
  // Auth routes must match `needsSessionRefresh` (src/proxy.test.ts). The
  // percent-only matcher adds encoding validation without auth on public paths.
  // Must be literals: Next reads these statically.
  matcher: [
    "/(.*%.*)",
    "/dashboard/:path*",
    "/admin/:path*",
    "/agency/:path*",
    "/pending",
    "/login",
    "/signup",
    "/mfa",
  ],
};
