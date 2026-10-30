import assert from "node:assert/strict";
import { mock } from "node:test";
import { CANARY_CREATOR, CANARY_PRIZE, CANARY_TEXT, INVARIANT_KEYS } from "./config";
import { rewardCodeFingerprint, sealReward } from "../rewards/crypto";
let latched: string | null = null;
let clients = 0, rpcCalls = 0, cleanedAlerts = 0;
const writes: string[] = [];
let anchor: unknown = null;
const svc = { rpc(name: string, params?: Record<string, unknown>) {
  rpcCalls++;
  const result = name === "read_reward_crypto_canary" ? { data: anchor, error: null }
    : name === "run_reward_ledger_invariants" ? { data: { status: "healthy", counts: Object.fromEntries(INVARIANT_KEYS.map(key => [key, 0])), rowLimit: 100_000 }, error: null }
    : name === "record_system_health_check" ? (() => {
      const source = String(params?.p_source), status = String(params?.p_canary_status);
      writes.push(`${source}:${status}`);
      // Exact canary_failure_at CASE semantics from migration0063 lines268-269.
      if (status !== "healthy") latched = "2026-10-28T00:00:00Z";
      else if (source === "manual") latched = null;
      return { data: { canaryStatus: status, canaryCheckedAt: "2026-10-28T00:00:00Z", canaryFailureAt: latched, invariantsStatus: "healthy", invariantCounts: {}, invariantsCheckedAt: null, lastMaintenanceAt: null }, error: null };
    })() : (() => { throw new Error("unexpected mocked RPC"); })();
  return { abortSignal: async () => result };
} };
mock.module("@/lib/supabase/server", { namedExports: { createServiceClient: () => { clients++; return svc; }, isSupabaseConfigured: () => true } });
mock.module("@/lib/monitoring/capture", { namedExports: { cleanError: () => { cleanedAlerts++; return null; }, storeError: async () => null, alertFor: async () => undefined } });
function resetInstance() { delete (globalThis as { __ffOperationalStartup?: Promise<void> }).__ffOperationalStartup; }
async function main() {
  const { registerOperationalChecks } = await import("./startup");
  const { runOperationalChecks } = await import("./runtime");
  delete process.env.REWARD_ENCRYPTION_KEY; delete process.env.REWARD_ENCRYPTION_KEY_VERSION; delete process.env.REWARD_CODE_FINGERPRINT_KEY;
  process.env.NEXT_RUNTIME = "nodejs"; delete process.env.NEXT_PHASE;
  process.env.CI = "true"; process.env.GITHUB_ACTIONS = "true"; delete process.env.VERCEL;
  delete process.env.VERCEL_ENV; delete process.env.VERCEL_URL;
  process.env.FANFUNNEL_CI_LOCAL_SERVER = "1";
  resetInstance(); await registerOperationalChecks();
  assert.equal(clients, 0); assert.equal(rpcCalls, 0); assert.equal(cleanedAlerts, 0);
  assert.deepEqual(writes, []); assert.equal(latched, null, "local CI creates no deployment-health state");
  process.env.VERCEL = "1";
  resetInstance(); await registerOperationalChecks();
  assert.deepEqual(writes, ["startup:configuration_missing"], "real Vercel startup still persists missing configuration even with every CI-local flag set");
  assert.notEqual(latched, null, "0063 persistence contract latches the failure");
  // Invented test material only; no environment credential is read or reported.
  process.env.REWARD_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString("base64");
  process.env.REWARD_CODE_FINGERPRINT_KEY = Buffer.alloc(32, 93).toString("base64");
  anchor = { ...sealReward(CANARY_TEXT, CANARY_CREATOR), fingerprint: rewardCodeFingerprint(CANARY_TEXT, CANARY_CREATOR, CANARY_PRIZE) };
  process.env.VERCEL = "1";
  resetInstance(); await registerOperationalChecks();
  assert.deepEqual(writes, ["startup:configuration_missing", "startup:healthy"]);
  assert.notEqual(latched, null, "a later real healthy startup cannot clear the existing latch");
  const maintenance = await runOperationalChecks("maintenance");
  assert.equal(maintenance.canary.status, "healthy"); assert.equal(maintenance.ok, false, "maintenance remains non-green because of previous local CI startup");
  const manual = await runOperationalChecks("manual"); assert.equal(manual.ok, true); assert.equal(latched, null);
  console.log("Startup isolation: explicit local CI has zero client/RPC/alert I/O; actual Vercel startup with identical CI flags records missing configuration; healthy startup and maintenance retain latch; manual recovery alone clears. Real functions, mocked service only; no hosted calls or real keys.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
