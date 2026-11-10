import assert from "node:assert";
import { mock } from "node:test";
import { NextRequest } from "next/server";

// WU-01 / WG-01: the proxy no longer bounces a suspended creator from the
// dashboard to a blank /login?suspended=1 (where nothing explained it, and
// signing in again looped). They reach the dashboard, which renders read-only
// with the suspension notice; the database refuses the writes. Signed-out
// users are still sent to sign in, and a signed-in one on /login or /signup
// to the dashboard.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let user: { id: string; factors?: { status: string }[] } | null = { id: "u1" };
let profileReads = 0;
mock.module("@supabase/ssr", {
  namedExports: {
    createServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user } }),
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
  user = { id: "u1", factors: [{ status: "verified" }] };
  check("two-factor still gates the dashboard", (await go("/dashboard"))?.startsWith("https://app.example/mfa?next=") === true);
  user = null;
  check("signed out → sign in with next", (await go("/dashboard")) === "https://app.example/login?next=%2Fdashboard");
  console.log(`middleware.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
