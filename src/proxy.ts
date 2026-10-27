import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Next 16 renamed the `middleware` file convention to `proxy` (same behavior).
// This refreshes the Supabase session before the auth pages render. It runs
// only where `needsSessionRefresh` says a refresh is needed, so public pages
// (landing, /c, /spin, /share, /verify, /leaderboard) and API routes skip it.
// Security headers come from next.config.ts, not from here.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Must match `needsSessionRefresh` in src/lib/supabase/middleware.ts
  // (enforced by src/proxy.test.ts). Must be literals: Next reads it statically.
  matcher: [
    "/dashboard/:path*",
    "/admin/:path*",
    "/agency/:path*",
    "/pending",
    "/login",
    "/signup",
    "/mfa",
  ],
};
