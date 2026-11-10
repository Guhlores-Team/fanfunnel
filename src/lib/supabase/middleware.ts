import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseUrl } from "./url";
import { serverRequestProtocol, sessionCookieOptions } from "./cookies";
import { aalFromAccessToken, hasVerifiedFactor } from "@/lib/auth/assurance";

/**
 * Pages that need the Supabase session refreshed here, before they render.
 * Server Components can read the session but can't write cookies, so a token
 * refreshed during render would be lost (and the rotated refresh token
 * burned): every server-rendered page that calls `auth.getUser()` belongs here.
 * Route Handlers (`/api/*`, `/auth/*`) write their own refreshed cookies and
 * client pages use the browser client, so neither needs the proxy.
 *
 * The auth matchers in src/proxy.ts cover these paths (src/proxy.test.ts).
 * A separate percent-path matcher validates encoding, then skips this session
 * refresh entirely for valid public/API routes.
 */
export function needsSessionRefresh(path: string): boolean {
  return (
    ["/dashboard", "/admin", "/agency"].some(
      (p) => path === p || path.startsWith(p + "/")
    ) ||
    path === "/pending" ||
    path === "/login" ||
    path === "/signup" ||
    path === "/mfa"
  );
}

/** Pages a user with a verified two-factor factor may only open on an aal2
 *  session (after entering a code); everything else about them is unchanged. */
export function needsTwoFactorStep(path: string): boolean {
  return ["/dashboard", "/admin", "/agency"].some((p) => path === p || path.startsWith(p + "/"));
}

// Refreshes the Supabase auth session and guards the dashboard. When Supabase
// isn't configured the app runs in demo mode, so this is a pass-through and the
// dashboard stays open.
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let response = NextResponse.next({ request });
  if (!url || !anon) return response; // demo mode — no auth

  // Only the auth-relevant routes need a Supabase round-trip. Landing, fan spin
  // links, share/verify, and API routes must NEVER depend on auth here — that
  // way a slow or paused Supabase can't 504 the whole site (esp. fans' spin
  // pages). The proxy matcher already limits us to these routes; this check
  // stays as a second guard.
  const path = request.nextUrl.pathname;
  if (!needsSessionRefresh(path)) return response;

  const supabase = createServerClient(supabaseUrl(), anon, {
    // Same attributes as server.ts/client.ts; see cookies.ts for why not httpOnly.
    // RS-09: the same first-hop rule as server.ts, so a multi-hop proxy
    // (`https,http`) never yields two cookies that disagree on Secure.
    cookieOptions: sessionCookieOptions(
      serverRequestProtocol(request.headers.get("x-forwarded-proto") || request.nextUrl.protocol)
    ),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // getUser() refreshes the token cookie, but bound by a hard timeout: if
  // Supabase is slow/unreachable we must NOT hang the middleware (that's what
  // 504 MIDDLEWARE_INVOCATION_TIMEOUT is). On timeout/error we treat the user
  // as unauthenticated and let the redirect logic below proceed normally.
  let user: { id?: string; factors?: { status?: unknown }[] | null } | null = null;
  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("supabase getUser timeout")), 3000)
      ),
    ]);
    user =
      (result as { data: { user: { id?: string } | null } })?.data?.user ?? null;
  } catch {
    user = null; // fail-fast, never hang the edge
  }

  if (!user && (path.startsWith("/dashboard") || path === "/mfa")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.searchParams.set("next", path);
    return NextResponse.redirect(redirect);
  }

  // A suspended creator (profiles.is_active=false) is NOT bounced here (WU-01 /
  // WG-01): the dashboard renders read-only with the suspension notice
  // (SuspendedBanner), exactly what the admin's confirm box promises, while
  // can_act_for() and current_user_active() refuse every write in the
  // database. The sign-in page still explains `?suspended=1` for old links.
  // Two-factor: a user who turned it on must enter a code (aal2) before the
  // dashboard, admin or agency pages. getUser() above verified the session and
  // returned its factors; the aal claim is read from that same session's token
  // (a local read, no extra round-trip). Fails closed: no readable aal = aal1.
  if (user && needsTwoFactorStep(path) && hasVerifiedFactor(user)) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (aalFromAccessToken(session?.access_token) !== "aal2") {
      const redirect = request.nextUrl.clone();
      redirect.pathname = "/mfa";
      redirect.search = "";
      redirect.searchParams.set("next", path + request.nextUrl.search);
      return NextResponse.redirect(redirect);
    }
  }

  // Already signed in? Skip the auth pages (a suspended creator too: the
  // dashboard is where the notice is).
  if (user && (path === "/login" || path === "/signup")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/dashboard";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}
