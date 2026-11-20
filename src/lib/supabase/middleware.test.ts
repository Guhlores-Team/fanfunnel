import assert from "node:assert";
import { mock } from "node:test";
import { NextRequest } from "next/server";

// WU-01 / WG-01: the proxy no longer bounces a suspended creator from the
// dashboard to a blank /login?suspended=1 (where nothing explained it, and
// signing in again looped). They reach the dashboard, which renders read-only
// with the suspension notice; the database refuses the writes. Signed-out
// users are still sent to sign in, and a signed-in one on /login or /signup
// to the dashboard.
// Review A6: a signed-in visitor sent to /login?error=auth_link… keeps the
// explanation (a dashboard notice, or the new-password page for a used reset
// or invitation link) instead of landing on a bare dashboard; a redirect for
// a signed-in visitor carries the cookies getUser() refreshed.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let user: { id: string; factors?: { status: string }[] } | null = { id: "u1" };
let profileReads = 0;
let refreshed = false;
type CookieOptions = { cookies: { setAll: (c: { name: string; value: string; options: Record<string, unknown> }[]) => void } };
mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: (_url: string, _key: string, options: CookieOptions) => ({
      auth: {
        getUser: async () => {
          // What @supabase/ssr does when the access token had to be refreshed.
          if (refreshed) options.cookies.setAll([{ name: "sb-example-auth-token", value: "rotated", options: { path: "/", sameSite: "lax" } }]);
          return { data: { user } };
        },
        getSession: async () => ({ data: { session: { access_token: "h.e30.s" } } }),
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { profileReads++; return { data: { is_active: false } }; } }) }) }),
    }),
  },
});
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";

async function main() {
  const { updateSession } = await import("./middleware");
  const go = async (path: string) => {
    const res = await updateSession(new NextRequest(`https://app.example${path}`));
    return res.headers.get("location");
  };
  check("a suspended creator reaches /dashboard (the banner lives there)", (await go("/dashboard")) === null);
  check("…and its sections", (await go("/dashboard?section=settings")) === null);
  check("the proxy does not read profiles.is_active at all any more", profileReads === 0);
  check("a signed-in user on /login goes to the dashboard", (await go("/login")) === "https://app.example/dashboard");
  check("…and on /signup", (await go("/signup")) === "https://app.example/dashboard");
  check("…other query parameters are not carried", (await go("/login?next=/admin&mode=signup")) === "https://app.example/dashboard");

  // A6: the failed-link explanation survives for a signed-in visitor.
  check("signed in + expired e-mail change → the dashboard notice", (await go("/login?error=auth_link&type=email_change&reason=expired")) === "https://app.example/dashboard?auth_link=expired&type=email_change");
  check("signed in + expired confirmation → the dashboard notice", (await go("/login?error=auth_link&type=signup&reason=expired")) === "https://app.example/dashboard?auth_link=expired&type=signup");
  check("signed in + used reset link → the new-password page decides", (await go("/login?error=auth_link&type=recovery&reason=expired")) === "https://app.example/reset-password");
  check("signed in + used invitation → the set-password page", (await go("/login?error=auth_link&type=invite&reason=expired")) === "https://app.example/set-password");
  check("signed in + a transient failure → the 'still good' notice", (await go("/login?error=auth_link&type=recovery&reason=busy")) === "https://app.example/dashboard?auth_link=busy&type=recovery");
  check("signed in + a malformed link → the notice", (await go("/login?error=auth_link&reason=malformed")) === "https://app.example/dashboard?auth_link=malformed");
  check("unknown type and reason values are never forwarded", (await go("/login?error=auth_link&type=%3Cscript%3E&reason=%3Cb%3E&next=//evil.example")) === "https://app.example/dashboard?auth_link=invalid");
  check("another error value is not a link failure", (await go("/login?error=other&type=recovery&reason=expired")) === "https://app.example/dashboard");
  check("/signup never carries a notice", (await go("/signup?error=auth_link&type=recovery&reason=expired")) === "https://app.example/dashboard");
  for (const target of ["/dashboard?auth_link=expired&type=email_change", "/dashboard?auth_link=busy&type=recovery&switched=1"]) {
    check(`${target} renders for a signed-in (even suspended) creator: no loop`, (await go(target)) === null);
  }
  refreshed = true;
  const res = await updateSession(new NextRequest("https://app.example/login?error=auth_link&type=email_change&reason=expired"));
  check("the redirect keeps the session cookie getUser() just refreshed", res.cookies.get("sb-example-auth-token")?.value === "rotated" && res.headers.get("location") === "https://app.example/dashboard?auth_link=expired&type=email_change");
  refreshed = false;
  user = { id: "u1", factors: [{ status: "verified" }] };
  check("two-factor still gates the dashboard", (await go("/dashboard"))?.startsWith("https://app.example/mfa?next=") === true);
  check("…and the notice flags ride along in next", (await go("/dashboard?auth_link=expired&type=email_change")) === "https://app.example/mfa?next=" + encodeURIComponent("/dashboard?auth_link=expired&type=email_change"));
  refreshed = true;
  const mfa = await updateSession(new NextRequest("https://app.example/dashboard"));
  check("the two-factor redirect keeps a refreshed session cookie too", mfa.cookies.get("sb-example-auth-token")?.value === "rotated");
  refreshed = false;
  user = null;
  check("signed out → sign in with next", (await go("/dashboard")) === "https://app.example/login?next=%2Fdashboard");
  check("signed out on /login?error=auth_link → the sign-in page itself explains", (await go("/login?error=auth_link&type=recovery&reason=expired")) === null);
  check("the e-mail link landing page is never redirected", (await go("/auth/confirm?token_hash=abcdef123456&type=recovery")) === null);
  console.log(`middleware.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
