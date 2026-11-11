import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextResponse } from "next/server";
let allowed = false, denial = 401, configured = true, reads = 0, runs = 0, inits = 0, factories = 0, audits = 0;
let initialized = { status: "healthy", outcome: "initialized", inventoryRows: 2 };
mock.module("@/lib/auth/admin", { namedExports: { requireAdminRoute: async () => allowed ? { ok: true, userId: "00000000-0000-4000-8000-000000000001" } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: denial }) } } });
mock.module("@/lib/supabase/server", { namedExports: { isSupabaseConfigured: () => configured, createClient: async () => ({ rpc: async () => ({ data: "11111111-1111-4111-8111-111111111111", error: null }) }), createServiceClient: () => { factories++; return {}; } } });
mock.module("@/lib/operations/canary", { namedExports: { readCanary: async () => { reads++; return { status: "missing" }; }, initializeCanaryForAdmin: async () => { inits++; return initialized; } } });
let schemaReads = 0;
mock.module("@/lib/operations/runtime", { namedExports: { readHealthSummary: async () => null, readSchemaVersion: async () => { schemaReads++; return { status: "behind", applied: 66, expected: 67 }; }, reportOperationalFailure: async () => undefined, runOperationalChecks: async () => { runs++; return { ok: false, canary: { status: "mismatch" } }; } } });
mock.module("@/lib/api/limit", { namedExports: { rateLimitOr429: async () => null, limitRoute: async () => null } });
mock.module("@/lib/data/audit", { namedExports: { recordAudit: async () => { audits++; } } });
let passed = 0;
const check = (label: string, value: unknown) => { assert.ok(value, label); passed++; };
async function main() {
  const { GET: get, POST } = await import("./route");
  const GET = () => get(new Request("http://localhost/api/admin/system-health"));
  const post = (body: unknown) => POST(new Request("http://localhost/api/admin/system-health", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  for (const status of [401, 403]) {
    denial = status;
    const read = await GET(), write = await post({ action: "initialize-canary", keysBackedUp: true });
    check(`denied${status} read/write never touch service or crypto`, read.status === status && write.status === status && factories === 0 && reads === 0 && inits === 0 && runs === 0 && schemaReads === 0);
    check(`denied${status} is not cached`, /no-store/.test(read.headers.get("cache-control") ?? "") && /no-store/.test(write.headers.get("cache-control") ?? ""));
  }
  allowed = true;
  for (const body of ["{", [], {}, { action: "initialize-canary", key: "synthetic-should-be-rejected" }, { action: "other" }, "x".repeat(1025)]) check("invalid body rejected before crypto", (await post(body)).status === 400 && inits === 0);
  check("backup confirmation required", (await post({ action: "initialize-canary" })).status === 400 && inits === 0);
  const read = await GET(), data = await read.json();
  check("A39: the status read flags a database behind the code's migration", data.schema?.status === "behind" && data.schema.applied === 66 && data.schema.expected === 67 && schemaReads === 1);
  check("status endpoint only returns state and summary", read.status === 200 && data.canary.status === "missing" && Object.keys(data.canary).join() === "status" && /no-store/.test(read.headers.get("cache-control") ?? ""));
  const init = await post({ action: "initialize-canary", keysBackedUp: true });
  check("verified initialization audited once", init.status === 200 && inits === 1 && audits === 1);
  initialized = { ...initialized, status: "missing", outcome: "recovery_required" };
  check("unverifiable tombstones are not healthy or audited", (await post({ action: "initialize-canary", keysBackedUp: true })).status === 409 && audits === 1);
  const run = await post({ action: "run-checks" });
  check("manual health mismatch returns503", run.status === 503 && runs === 1 && (await run.json()).canary.status === "mismatch");
  configured = false;
  check("demo status cannot claim real protection", (await (await GET()).json()).demo === true);
  check("demo initialization cannot write", (await post({ action: "initialize-canary", keysBackedUp: true })).status === 409 && inits === 2);
  console.log(`system health admin route: ${passed} checks passed; guard denials and writes isolated`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
