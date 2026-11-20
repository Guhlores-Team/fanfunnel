import assert from "node:assert";
import { mock } from "node:test";

// WG-16 / WU-20: POST /api/account/sessions signs the account out everywhere
// else, with the caller's own session (scope "others", no service key), after
// the normal session check and the two-factor step for an enrolled account.

let passed = 0;
function check(label: string, cond: unknown) {
  assert.ok(cond, label);
  passed++;
}
let user: { id: string; factors?: { status: string }[] } | null = { id: "u1" };
let aal = "aal1";
let signOutError: { message: string } | null = null;
const signOuts: unknown[] = [];
const client = {
  auth: {
    getUser: async () => ({ data: { user } }),
    getSession: async () => ({ data: { session: { access_token: `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s` } }, error: null }),
    signOut: async (opts: unknown) => {
      signOuts.push(opts);
      return { error: signOutError };
    },
  },
};
let serviceCalls = 0;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => client,
    createServiceClient: () => { serviceCalls++; throw new Error("no service role here"); },
  },
});
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

async function main() {
  const { POST } = await import("./route");
  let res = await POST();
  check("a plain creator signs out the other sessions", res.status === 200 && signOuts.length === 1 && (signOuts[0] as { scope: string }).scope === "others");
  check("…with their own session, never the service key", serviceCalls === 0);
  user = { id: "u1", factors: [{ status: "verified" }] };
  res = await POST();
  check("an enrolled creator at aal1 must enter a code first", res.status === 403 && (await res.json()).error === "mfa_required" && signOuts.length === 1);
  aal = "aal2";
  res = await POST();
  check("…and at aal2 it works", res.status === 200 && signOuts.length === 2);
  signOutError = { message: "boom" };
  res = await POST();
  check("a provider failure is reported, not hidden", res.status === 502 && (await res.json()).error === "signout_failed");
  signOutError = null;
  user = null;
  res = await POST();
  check("signed out → 401, nothing revoked", res.status === 401 && signOuts.length === 3);
  console.log(`sessions route: ${passed} checks passed`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
