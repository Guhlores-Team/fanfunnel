import assert from "node:assert/strict";
import { mock } from "node:test";
let calls = 0, persisted = 0, alerts = 0, schemaReads = 0;
let reportedSchema: unknown = null;
mock.module("@/lib/supabase/server", { namedExports: { createServiceClient: () => ({}), isSupabaseConfigured: () => true } });
mock.module("./canary", { namedExports: { bootstrapEmptyCanary: async () => { calls++; return { status: "mismatch" }; } } });
mock.module("./runtime", { namedExports: { persistHealth: async () => { persisted++; }, readSchemaVersion: async () => { schemaReads++; return { status: "behind", applied: 66, expected: 67 }; }, reportOperationalFailure: async (_canary: unknown, _invariants: unknown, schema: unknown) => { alerts++; reportedSchema = schema; } } });
async function main() {
  const { startupChecksEnabled, registerOperationalChecks } = await import("./startup");
  assert.equal(startupChecksEnabled({ NEXT_RUNTIME: "edge" }), false);
  assert.equal(startupChecksEnabled({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build" }), false);
  assert.equal(startupChecksEnabled({ NEXT_RUNTIME: "nodejs" }), true);
  const localCI = { NEXT_RUNTIME: "nodejs", CI: "true", GITHUB_ACTIONS: "true", FANFUNNEL_CI_LOCAL_SERVER: "1" };
  assert.equal(startupChecksEnabled(localCI), false, "explicit GitHub local server does not report deployment health");
  assert.equal(startupChecksEnabled({ NEXT_RUNTIME: "nodejs", FANFUNNEL_CI_LOCAL_SERVER: "1" }), true, "marker alone is insufficient");
  assert.equal(startupChecksEnabled({ NEXT_RUNTIME: "nodejs", CI: "true", GITHUB_ACTIONS: "true" }), true, "generic CI flags do not disable checks");
  assert.equal(startupChecksEnabled({ ...localCI, CI: undefined }), true);
  assert.equal(startupChecksEnabled({ ...localCI, GITHUB_ACTIONS: undefined }), true);
  assert.equal(startupChecksEnabled({ ...localCI, CI: "false" }), true);
  assert.equal(startupChecksEnabled({ ...localCI, GITHUB_ACTIONS: "1" }), true);
  assert.equal(startupChecksEnabled({ ...localCI, FANFUNNEL_CI_LOCAL_SERVER: "true" }), true);
  for (const marker of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) {
    for (const value of ["1", "", "preview"]) {
      assert.equal(startupChecksEnabled({ ...localCI, [marker]: value }), true, "even an empty/present Vercel marker keeps checks enabled");
    }
  }
  process.env.NEXT_RUNTIME = "nodejs"; process.env.NEXT_PHASE = "phase-production-build";
  await registerOperationalChecks(); assert.equal(calls, 0, "build does not access the database");
  delete process.env.NEXT_PHASE;
  await Promise.all([registerOperationalChecks(), registerOperationalChecks(), registerOperationalChecks()]);
  await registerOperationalChecks();
  assert.equal(calls, 1, "concurrent startup registrations run once, never per request");
  assert.equal(persisted, 1); assert.equal(alerts, 1);
  assert.equal(schemaReads, 1, "A39: startup reads the schema version once");
  assert.deepEqual(reportedSchema, { status: "behind", applied: 66, expected: 67 }, "A39: a database behind the code is reported at startup");
  console.log("operational startup: original7 +17 CI-isolation checks passed; no build-time remote effects or real alerts");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
