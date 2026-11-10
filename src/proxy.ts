import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { needsSessionRefresh, updateSession } from "@/lib/supabase/middleware";
import { buildCsp, createNonce, usesStrictCsp } from "@/lib/security/csp";
import { isCrossOriginWrite } from "@/lib/security/sameOrigin";
import { limitRoute } from "@/lib/api/limit";
import { MAINTENANCE_HEADERS, maintenanceBlocksWrite, maintenanceOn } from "@/lib/ops/maintenance";
import { tooManyRequestsPage } from "@/lib/api/tooManyPage";

// Next 16 renamed the `middleware` file convention to `proxy` (same behavior).
// This refreshes the Supabase session before the auth pages render. It runs
// only where `needsSessionRefresh` says a refresh is needed. The extra percent
// matcher rejects malformed encoding before Next's dynamic routing can turn it
// into an unmonitored 500. Valid public/API paths never refresh auth here.
// Security headers come from next.config.ts; on the auth pages this also
// swaps in the strict per-request nonce CSP (src/lib/security/csp.ts).
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
  const path = request.nextUrl.pathname;
  // WA-08: a hand-made path such as `/\admin` (browsers never send one) is
  // what the URL layer hands us as `//admin`: no route has an empty segment,
  // and Vercel's routing of the built app answered such paths with an
  // unmonitored 500. Refuse it like malformed encoding, before anything runs.
  if (path.includes("//")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // I4: a cookie-carrying write to the API must come from this origin. Only
  // cookie-carrying /api requests reach here (matcher); they never refresh
  // the session here, so a slow Supabase can't delay the API.
  if (path.startsWith("/api/")) {
    // OPS-12: while paused, a signed-in API write is refused here; reads
    // (dashboard polls) and /api/admin/* pass. Cookieless calls and pages are
    // rewritten by next.config.ts (src/lib/ops/maintenance.ts explains why).
    if (maintenanceOn() && maintenanceBlocksWrite(path, request.method)) {
      return NextResponse.json({ error: "maintenance" }, { status: 503, headers: MAINTENANCE_HEADERS });
    }
    if (isCrossOriginWrite({ method: request.method, path, headers: request.headers, allowedOrigins: [process.env.NEXT_PUBLIC_SITE_URL], onVercel: process.env.VERCEL === "1" })) {
      return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.next();
  }
  // M1: the public leaderboard page is uncached and unauthenticated; cap it
  // per client like its API (the page itself can't answer 429).
  if (path.startsWith("/leaderboard/")) {
    const limited = await limitRoute(request, "leaderboard-page:GET", "public");
    if (!limited) return NextResponse.next();
    // WF-05: a fan asked for a PAGE; raw JSON is not an answer. Same status and
    // Retry-After as the API, as a branded "try again in N s" page.
    const retryAfter = limited.headers.get("Retry-After") ?? "60";
    return new NextResponse(tooManyRequestsPage(Number(retryAfter)), {
      status: 429,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": retryAfter },
    });
  }
  if (!needsSessionRefresh(path)) return NextResponse.next();
  if (!usesStrictCsp(path)) return await updateSession(request);
  // These pages are dynamically rendered, so Next reads the nonce from the
  // request's CSP header and puts it on its scripts. updateSession forwards
  // the request headers on NextResponse.next({ request }).
  const csp = buildCsp({
    mode: "strict",
    nonce: createNonce(),
    dev: process.env.NODE_ENV === "development",
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  request.headers.set("content-security-policy", csp);
  const response = await updateSession(request);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Auth routes must match `needsSessionRefresh` (src/proxy.test.ts). The
  // percent-only matcher adds encoding validation without auth on public paths.
  // API requests run it only when they carry a cookie (the origin check, I4);
  // the leaderboard page for its rate limit. Neither refreshes the session.
  // Must be literals: Next reads these statically.
  matcher: [
    "/(.*%.*)",
    "/(/.*)",
    "/(.*//.*)",
    { source: "/api/:path*", has: [{ type: "header", key: "cookie" }] },
    "/leaderboard/:path*",
    "/dashboard/:path*",
    "/admin/:path*",
    "/agency/:path*",
    "/pending",
    "/login",
    "/signup",
    "/mfa",
    "/auth/confirm",
  ],
};
