import assert from "node:assert";
import { mock } from "node:test";

// POST /api/account/mfa/unenroll: turning two-factor OFF needs a session that
// used two-factor (aal2), so a stolen password alone can't remove it. Negative
// cases remove nothing; the success path is recorded in the activity log.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const tok = (aal: string) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const FACTOR = "33333333-3333-4333-8333-333333333333";
let user: { id: string; factors: { status: string }[] } | null = { id: "44444444-4444-4444-8444-444444444444", factors: [{ status: "verified" }] };
let aal = "aal1";
const unenrolled: string[] = [];
const audits: Record<string, unknown>[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user } }),
        getSession: async () => ({ data: { session: { access_token: tok(aal) } } }),
        mfa: {
          unenroll: async ({ factorId }: { factorId: string }) => {
            unenrolled.push(factorId);
            return { data: { id: factorId }, error: null };
          },
        },
      },
    }),
    createServiceClient: () => {
      throw new Error("removing your own factor must not use the service role");
    },
  },
});
mock.module("@/lib/data", {
  namedExports: { recordAudit: async (e: Record<string, unknown>) => void audits.push(e) },
});
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null } });

async function main() {
  const { POST } = await import("./route");
  const call = (body: unknown) =>
    POST(new Request("http://localhost/api/account/mfa/unenroll", { method: "POST", body: JSON.stringify(body) }));

  let res = await call({ factorId: FACTOR });
  check("aal1 → 403 mfa_required", res.status === 403 && (await res.json()).error === "mfa_required");
  check("nothing removed on aal1", unenrolled.length === 0);

  aal = "aal2";
  res = await call({ factorId: "not-a-uuid" });
  check("bad factor id → 400", res.status === 400 && unenrolled.length === 0);

  res = await call({ factorId: FACTOR });
  check("aal2 → 200 and the factor is removed", res.status === 200 && unenrolled.join() === FACTOR);
  check("logged as mfa.factor_removed by the user, factor id only", audits.length === 1 && audits[0].action === "mfa.factor_removed" && audits[0].targetId === FACTOR && audits[0].actorId === user!.id);

  user = null;
  res = await call({ factorId: FACTOR });
  check("signed out → 401", res.status === 401 && unenrolled.length === 1);

  console.log(`mfa unenroll route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
