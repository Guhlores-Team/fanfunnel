import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseUrl } from "./url";

// Refreshes the Supabase auth session on every request and guards the
// dashboard. When Supabase isn't configured the app runs in demo mode, so this
// is a pass-through and the dashboard stays open.
export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  let response = NextResponse.next({ request });
  if (!url || !anon) return response; // demo mode — no auth

  // Only the auth-relevant routes need a Supabase round-trip. Landing, fan spin
  // links, share/verify, and API routes must NEVER depend on auth here — that
  // way a slow or paused Supabase can't 504 the whole site (esp. fans' spin
  // pages). Everything else short-circuits before touching the network.
  const path = request.nextUrl.pathname;
  const needsAuth =
    path.startsWith("/dashboard") || path === "/login" || path === "/signup";
  if (!needsAuth) return response;

  const supabase = createServerClient(supabaseUrl(), anon, {
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
  let user: { id?: string } | null = null;
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

  if (!user && path.startsWith("/dashboard")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.searchParams.set("next", path);
    return NextResponse.redirect(redirect);
  }

  // Suspended accounts (profiles.is_active=false) lose dashboard access — RLS
  // already blocks their writes; this is the matching UI gate. Bounded + fail
  // OPEN: a slow/erroring read must never lock out every creator (RLS stays the
  // hard backstop), so we only act on a definitive `false`.
  let active = true;
  if (user?.id) {
    try {
      const result = await Promise.race([
        supabase.from("profiles").select("is_active").eq("id", user.id).maybeSingle(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("is_active timeout")), 2000)
        ),
      ]);
      if ((result as { data: { is_active?: boolean } | null })?.data?.is_active === false) {
        active = false;
      }
    } catch {
      active = true; // never hang / lock out on a slow read
    }
  }

  if (user && !active && path.startsWith("/dashboard")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.search = "";
    redirect.searchParams.set("suspended", "1");
    return NextResponse.redirect(redirect);
  }

  // Already signed in (and active)? Skip the auth pages.
  if (user && active && (path === "/login" || path === "/signup")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/dashboard";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}
