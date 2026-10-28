import assert from "node:assert";
import { mock } from "node:test";

// The admin activity log: entries hold ids and small facts only (no emails,
// names, tokens), writes go through the service role and never throw, reads
// need an active admin (the session client + RLS do the rest).

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const inserts: Record<string, unknown>[] = [];
let insertError: { message: string } | null = null;
let throwOnInsert = false;
let activeAdmin = true;
let fromCalls: string[] = [];

mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({
      from: (t: string) => {
        assert.equal(t, "admin_audit_log");
        return {
          insert: async (row: Record<string, unknown>) => {
            if (throwOnInsert) throw new Error("network");
            inserts.push(row);
            return { error: insertError };
          },
        };
      },
    }),
    createClient: async () => ({
      from: (t: string) => {
        fromCalls.push(t);
        if (t === "admin_audit_log") {
          return {
            select: () => ({
              order: () => ({
                limit: async () => ({
                  data: [
                    { id: "e1", actor_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action: "account.delete", target_type: "profile", target_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", details: { role: "creator" }, created_at: "2026-01-01T00:00:00Z" },
                  ],
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            in: async () => ({ data: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com" }] }),
          }),
        };
      },
    }),
  },
});
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => activeAdmin } });

async function main() {
  const { recordAudit, listAuditLog, sanitizeAuditDetails } = await import("./audit");
  const { auditActionLabel, auditDetailsSummary, shortId } = await import("@/components/admin/auditLabels");

  // sanitize
  const s = sanitizeAuditDetails({
    role: "admin",
    fanLinks: 3,
    factorsRemoved: 2,
    wasAdmin: true,
    appErrors: null,
    email: "x@example.com",
    fanName: "Jo",
    token: "abc",
    ip: "1.2.3.4",
    note: "reach me at x@example.com",
    long: "x".repeat(65),
    "bad key": 1,
    features: { spinWheel: true, raffles: false },
  } as never);
  check("plain facts kept", s.role === "admin" && s.fanLinks === 3 && s.factorsRemoved === 2 && s.wasAdmin === true && s.appErrors === null);
  check("PII keys dropped", !("email" in s) && !("fanName" in s) && !("token" in s) && !("ip" in s));
  check("values containing @ dropped", !("note" in s));
  check("long strings and odd keys dropped", !("long" in s) && !("bad key" in s));
  check("feature flags kept as booleans", JSON.stringify(s.features) === JSON.stringify({ spinWheel: true, raffles: false }));
  check("retention counters are not mistaken for PII", Object.keys(sanitizeAuditDetails({ adminAuditLog: 1, creatorNotices: 1, linkTombstones: 1, by: "self" })).length === 4);

  // record
  await recordAudit({ actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", action: "account.delete", targetType: "profile", targetId: "not-a-uuid", details: { email: "x@y.z", role: "creator" } as never });
  check("written via the service role", inserts.length === 1);
  check("non-uuid target → null", inserts[0].target_id === null && inserts[0].actor_id === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  check("details sanitized before the write", JSON.stringify(inserts[0].details) === JSON.stringify({ role: "creator" }));
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a);
  insertError = { message: "boom" };
  await recordAudit({ actorId: null, action: "retention.cleanup" });
  throwOnInsert = true;
  await recordAudit({ actorId: null, action: "retention.cleanup" });
  console.error = orig;
  check("a failed or throwing write is logged, never thrown", errs.length === 2);

  // read
  activeAdmin = false;
  fromCalls = [];
  check("non-admin → null, the table is never queried", (await listAuditLog()) === null && fromCalls.length === 0);
  activeAdmin = true;
  const rows = await listAuditLog(10);
  check("admin → entries labelled with the current email", rows?.length === 1 && rows[0].actorLabel === "admin@example.com" && rows[0].targetLabel === null);

  // labels
  check("known action label", auditActionLabel("account.mfa_reset") === "reset two-factor");
  check("unknown action falls back to its code", auditActionLabel("x.y") === "x.y");
  check("shortId", shortId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") === "bbbb…bbbb" && shortId(null) === "");
  check("details summary", auditDetailsSummary({ role: "admin", features: { raffles: true }, skip: null }) === "role: admin · features: raffles on");

  console.log(`audit log: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
