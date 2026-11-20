import assert from "node:assert/strict";
import { mock } from "node:test";

// OPS-04: the Supabase query the Activity filter and "Load older" build.
const calls: [string, unknown[]][] = [];
const chain: Record<string, (...a: unknown[]) => unknown> = {};
for (const name of ["from", "select", "or", "in", "lt", "order", "eq"]) chain[name] = (...a: unknown[]) => { calls.push([name, a]); return chain; };
chain.limit = (...a: unknown[]) => { calls.push(["limit", a]); return Promise.resolve({ data: [], error: null }); };
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => true, createClient: async () => chain, createServiceClient: () => chain } });
mock.module("@/lib/auth/adminCheck", { namedExports: { isActiveAdmin: async () => true } });

let passed = 0;
const check = (label: string, ok: unknown) => { assert.ok(ok, label); passed++; };
const used = (name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);
async function main() {
  const { listAuditLog } = await import("./audit");
  await listAuditLog(51, { action: "suspend", before: "2026-11-09T10:00:00.123456+00:00" });
  check("code text: ilike on the code OR the matching known codes", JSON.stringify(used("or")) === JSON.stringify([["action.ilike.*suspend*,action.in.(account.suspend)"]]));
  check("cursor: strictly older than the last entry shown", JSON.stringify(used("lt")) === JSON.stringify([["created_at", "2026-11-09T10:00:00.123456+00:00"]]));
  check("newest first, page + 1", JSON.stringify(used("limit")) === "[[51]]");
  calls.length = 0;
  await listAuditLog(51, { action: "two-factor" });
  check("label text: only the codes whose label matches", JSON.stringify(used("in")) === JSON.stringify([["action", ["account.mfa_reset", "mfa.factor_removed"]]]) && used("or").length === 0);
  calls.length = 0;
  check("label text with no match: empty, no request sent", (await listAuditLog(51, { action: "zz zz" }))?.length === 0 && used("limit").length === 0);
  console.log(`audit filter query: ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
