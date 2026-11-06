import assert from "node:assert";
import { mock } from "node:test";

// POST /api/admin/account/mfa-reset (aal2 admin only; the refusals for aal1
// admins and creators are in src/lib/security/adminMfa.test.ts). Here: an
// admin can't reset their own factors, a bad id is refused, and a reset
// removes every factor of the TARGET and is logged with ids and a count.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const aal2 = `h.${Buffer.from(JSON.stringify({ aal: "aal2" })).toString("base64url")}.s`;
const deleted: { userId: string; id: string }[] = [];
const listed: string[] = [];
const audits: Record<string, unknown>[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: { id: ADMIN, factors: [{ status: "verified" }] } } }),
        getSession: async () => ({ data: { session: { access_token: aal2 } } }),
      },
      rpc: async () => ({ data: true, error: null }),
      from: () => {
        throw new Error("is_admin() answered");
      },
    }),
    createServiceClient: () => ({
      auth: {
        admin: {
          mfa: {
            listFactors: async ({ userId }: { userId: string }) => {
              listed.push(userId);
              return { data: { factors: [{ id: "f1" }, { id: "f2" }] }, error: null };
            },
            deleteFactor: async (p: { userId: string; id: string }) => {
              deleted.push(p);
              return { data: { id: p.id }, error: null };
            },
          },
        },
      },
    }),
  },
});
mock.module("@/lib/data", {
  namedExports: { recordAudit: async (e: Record<string, unknown>) => void audits.push(e) },
});

async function main() {
  const { POST } = await import("./route");
  const call = (body: unknown) =>
    POST(new Request("http://localhost/api/admin/account/mfa-reset", { method: "POST", body: JSON.stringify(body) }));

  let res = await call({ id: ADMIN });
  check("own account → 400 cannot_reset_self", res.status === 400 && (await res.json()).error === "cannot_reset_self");
  res = await call({ id: "nope" });
  check("bad id → 400", res.status === 400);
  check("nothing listed or deleted yet", listed.length === 0 && deleted.length === 0);

  res = await call({ id: TARGET });
  const body = await res.json();
  check("reset → 200 with the count", res.status === 200 && body.removed === 2);
  check("only the target's factors were deleted", listed.join() === TARGET && deleted.every((d) => d.userId === TARGET) && deleted.length === 2);
  check(
    "logged: actor, target, count — no PII",
    audits.length === 1 && audits[0].action === "account.mfa_reset" && audits[0].actorId === ADMIN && audits[0].targetId === TARGET &&
      (audits[0].details as { factorsRemoved?: number }).factorsRemoved === 2
  );

  console.log(`admin mfa-reset route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
