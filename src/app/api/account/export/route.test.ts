import assert from "node:assert";
import { mock } from "node:test";

// GET /api/account/export: the signed-in creator's own data, built by the data
// layer on the creator's session client. Negative cases: signed out → 401; a
// two-factor user on a password-only session → 403 before any export; rate
// limit → 429. The route never builds a service client. Downloads are no-store.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const tok = (aal: string) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
let configured = true;
let user: { id: string; factors?: { status: string }[] } | null = { id: "u1" };
let aal = "aal1";
let limited = false;
let exports = 0;

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => configured,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user } }),
        getSession: async () => ({ data: { session: { access_token: tok(aal) } } }),
      },
    }),
    createServiceClient: () => {
      throw new Error("the creator export must not use the service role");
    },
  },
});
mock.module("@/lib/data", {
  namedExports: {
    exportCreatorData: async () => {
      exports++;
      return { format: "fanfunnel.creator-data.v1", sections: {} };
    },
  },
});
mock.module("@/lib/api/limit", {
  namedExports: {
    rateLimitOr429: async (key: string) => {
      assert.ok(key.startsWith("creatorexport:"), key);
      return limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null;
    },
  },
});

async function main() {
  const { GET } = await import("./route");

  user = null;
  let res = await GET();
  check("signed out → 401", res.status === 401 && exports === 0);

  user = { id: "u1", factors: [{ status: "verified" }] };
  res = await GET();
  check("2FA user on aal1 → 403 mfa_required, no export", res.status === 403 && (await res.json()).error === "mfa_required" && exports === 0);

  aal = "aal2";
  res = await GET();
  check("2FA user on aal2 → 200", res.status === 200 && exports === 1);
  check("download headers", /attachment; filename="fanfunnel-account-data-/.test(res.headers.get("content-disposition") ?? "") && /no-store/.test(res.headers.get("cache-control") ?? ""));

  user = { id: "u1" };
  aal = "aal1";
  res = await GET();
  check("no 2FA enrolled → aal1 is fine", res.status === 200);

  limited = true;
  res = await GET();
  check("rate limited → 429", res.status === 429 && exports === 2);
  limited = false;

  configured = false;
  res = await GET();
  check("demo mode exports the demo account", res.status === 200 && exports === 3);

  console.log(`account export route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
