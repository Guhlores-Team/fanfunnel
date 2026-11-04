import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { needsSessionRefresh, updateSession } from "@/lib/supabase/middleware";
import { buildCsp, createNonce } from "@/lib/security/csp";

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
  if (!needsSessionRefresh(request.nextUrl.pathname)) return NextResponse.next();
  // Every page here is dynamically rendered, so Next reads the nonce from the
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
