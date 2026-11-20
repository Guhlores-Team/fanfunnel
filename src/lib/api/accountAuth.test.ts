import assert from "node:assert";

// Batch 6 N1: with Supabase configured, an anonymous call (no session cookie)
// to a signed-in dashboard API answers 401 before any work, instead of 200 with
// empty data. Public and costly tiers, and the demo, are unchanged.

let passed = 0;
function check(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed++;
}

async function main() {
  const { limitRoute, hasSessionCookie } = await import("./limit");
  const req = (cookie?: string, ip = "10.6.0.1") =>
    new Request("http://x/api/fans", { headers: { "x-real-ip": ip, ...(cookie ? { cookie } : {}) } });

  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  check("demo mode: an anonymous dashboard call still proceeds", (await limitRoute(req(), "fans:GET")) === null);

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ref.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  const anon = await limitRoute(req(), "fans:GET");
  check("configured: no session cookie → 401", anon?.status === 401 && (await anon.json()).error === "unauthorized" && anon.headers.get("Cache-Control") === "no-store");
  check("…an unrelated cookie is not a session", (await limitRoute(req("theme=dark; sb-ref-auth-token="), "fans:GET"))?.status === 401);
  check("…a session cookie proceeds to the route's own check", (await limitRoute(req("theme=dark; sb-ref-auth-token=base64-abc"), "fans:GET")) === null);
  check("…a chunked session cookie too", hasSessionCookie(req("sb-ref-auth-token.0=base64-abc")));
  check("public tier: anonymous is fine", (await limitRoute(req(undefined, "10.6.0.2"), "leaderboard:GET", "public")) === null);
  check("costly tier is not the dashboard tier", (await limitRoute(req(undefined, "10.6.0.3"), "x:POST", "costly")) === null);

  // A real dashboard route answers 401 with no data work.
  const { GET } = await import("@/app/api/overview/route");
  const r = await GET(req(undefined, "10.6.0.4"));
  check("/api/overview anonymous → 401", r.status === 401);
  const { GET: agency } = await import("@/app/api/agency/route");
  check("/api/agency anonymous → 401", (await agency(req(undefined, "10.6.0.5"))).status === 401);

  console.log(`accountAuth.test: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
