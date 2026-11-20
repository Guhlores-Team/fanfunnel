import assert from "node:assert";
import { mock } from "node:test";

// RS-10: POST /auth/signout is outside /api/, so the proxy's origin check
// never runs for it; the handler applies the same check itself. A same-site
// form (the dashboard's) still signs out; a cross-site one is refused.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let signOuts = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({ auth: { signOut: async () => { signOuts++; return { error: null }; } } }),
  },
});

async function main() {
  const { POST } = await import("./route");
  const post = (headers: Record<string, string>) =>
    POST(new Request("https://app.example/auth/signout", { method: "POST", headers: { cookie: "sb-x-auth-token=1", host: "app.example", ...headers } }));

  let res = await post({ "sec-fetch-site": "same-origin" });
  check("same-origin form → 303 to /login", res.status === 303 && res.headers.get("location") === "https://app.example/login" && signOuts === 1);
  res = await post({ origin: "https://app.example" });
  check("an Origin naming this host → signed out", res.status === 303 && signOuts === 2);
  res = await post({ origin: "https://evil.example" });
  check("a cross-site Origin → 403, not signed out", res.status === 403 && signOuts === 2);
  res = await post({ "sec-fetch-site": "cross-site", origin: "https://app.example" });
  check("Sec-Fetch-Site cross-site → 403 even with a matching Origin", res.status === 403 && signOuts === 2);
  res = await post({ "sec-fetch-site": "same-site" });
  check("a sibling subdomain (same-site) → 403", res.status === 403 && signOuts === 2);
  res = await POST(new Request("https://app.example/auth/signout", { method: "POST", headers: { origin: "https://evil.example" } }));
  check("without a cookie there is nothing to protect → 303", res.status === 303);
  console.log(`signout route: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
