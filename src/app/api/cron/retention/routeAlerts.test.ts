import assert from "node:assert";
import { mock } from "node:test";

// A23: the retention cron must not fail silently. A missing/short CRON_SECRET,
// the scheduler presenting the wrong secret, a failed cleanup RPC and failed
// storage work each record one fixed, redacted error for Admin › Errors (which
// e-mails ALERT_EMAIL_TO on first occurrence). Random unauthenticated probes
// do not, and a healthy run records nothing.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const captured: { source: string; message: string; route?: string | null }[] = [];
let digestRuns = 0;
let digestOrder: number[] = [];
mock.module("@/lib/monitoring/capture", {
  namedExports: {
    captureNow: async (e: { source: string; message: string; route?: string | null }) => void captured.push(e),
    // A27: the cron flushes the pending digest after its own alerts.
    flushAlertDigest: async () => { digestRuns++; digestOrder.push(captured.length); return "none"; },
  },
});
let needsAdmin = 0;
mock.module("@/lib/account/deletionRetry", {
  namedExports: { retryPausedDeletions: async () => ({ due: 0, resumed: 0, completed: 0, pending: 0, failed: 0, waiting: 0, needsAdmin }) },
});
// 0063 operational checks alert through their own fixed messages (runtime.test.ts);
// keep them healthy here so only the retention route's own alerts are counted.
mock.module("@/lib/operations/runtime", { namedExports: { runOperationalChecks: async () => ({ ok: true }) } });
let rpcError: { message: string } | null = null;
let storageFailed = 0;
mock.module("@/lib/storage/work", {
  namedExports: {
    processPendingStorageWork: async () => ({ completed: 0, pending: 0, failed: storageFailed, reviewRequired: 0, accountsCompleted: 0, accountsPending: 0 }),
  },
});
let pushError: { message: string } | null = null;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({
      rpc: () => { const reply = { data: rpcError ? null : {}, error: rpcError }; return Object.assign(Promise.resolve(reply), { abortSignal: async () => reply }); },
      from: () => ({ update: () => ({ gte: async () => ({ count: pushError ? null : 0, error: pushError }) }) }),
    }),
  },
});
let heartbeat: "sent" | "failed" | "off" = "off";
mock.module("@/lib/operations/heartbeat", { namedExports: { pingHeartbeat: async () => heartbeat } });
const opsCaptured: string[] = [];
mock.module("@/lib/monitoring/opsAlerts", { namedExports: {
  reportHeartbeatFailed: () => { opsCaptured.push("heartbeat"); },
  maintenanceStepFailedMessage: (step: string, how: string) => `Maintenance step ${how === "timed_out" ? "timed out" : "failed"}: ${step} (the rest of the run continued)`,
} });
mock.module("@/lib/data", { namedExports: { recordAudit: async () => {} } });

async function main() {
  const { GET } = await import("./route");
  const SECRET = "s3cret-s3cret-s3cret-0123456789";
  const call = (headers: Record<string, string> = {}) => GET(new Request("http://localhost/api/cron/retention", { headers }));

  delete process.env.CRON_SECRET;
  check("no secret → 401 (WA-09: indistinguishable from a wrong one)", (await call({ authorization: `Bearer ${SECRET}` })).status === 401);
  check("…and it is recorded loudly", captured.length === 1 && /CRON_SECRET/.test(captured[0].message) && captured[0].source === "server" && captured[0].route === "/api/cron/retention");
  check("the alert never contains a secret value", !captured.some((c) => c.message.includes(SECRET)));

  process.env.CRON_SECRET = SECRET;
  captured.length = 0;
  check("a random probe → 401", (await call({ authorization: "Bearer guess", "user-agent": "curl/8" })).status === 401);
  check("…which is not alerted", captured.length === 0);
  check("the scheduler with the wrong secret → 401", (await call({ authorization: "Bearer stale-secret", "user-agent": "vercel-cron/1.0" })).status === 401);
  check("…which is alerted", captured.length === 1 && /does not match/.test(captured[0].message));

  captured.length = 0;
  check("a healthy run → 200", (await call({ authorization: `Bearer ${SECRET}` })).status === 200);
  check("…records nothing", captured.length === 0);

  rpcError = { message: "relation does not exist" };
  let failedRun = await call({ authorization: `Bearer ${SECRET}` });
  check("a failed cleanup → 500", failedRun.status === 500);
  check("…is alerted with a fixed message", captured.length === 1 && captured[0].message === "Retention cleanup failed: run_retention_cleanup returned an error");
  let failedBody = await failedRun.json();
  check("OPS3-10: the run continued past the failed step and still pinged the heartbeat", failedBody.steps[0].status === "failed" && failedBody.steps.length === 6 && failedBody.heartbeat === "off" && failedBody.error === "cleanup_failed");
  rpcError = null;

  // OPS3-10: a step that throws or exceeds its deadline is named, the run continues.
  captured.length = 0;
  pushError = { message: "permission denied" };
  failedRun = await call({ authorization: `Bearer ${SECRET}` });
  failedBody = await failedRun.json();
  check("a failed push-resume step → 503, named in a fixed alert, every other step still ran", failedRun.status === 503 && captured.length === 1 && captured[0].message === "Maintenance step failed: push (the rest of the run continued)" && failedBody.steps.filter((s: { status: string }) => s.status === "ok").length === 5);
  pushError = null;

  // OPS3-08: a refused heartbeat ping is recorded as its own fixed row.
  captured.length = 0; opsCaptured.length = 0;
  heartbeat = "failed";
  check("a healthy run whose ping was refused is still 200, with the ping failure recorded", (await call({ authorization: `Bearer ${SECRET}` })).status === 200 && opsCaptured.length === 1 && captured.length === 0);
  heartbeat = "sent";
  const sentBody = await (await call({ authorization: `Bearer ${SECRET}` })).json();
  check("…and an accepted ping says sent", sentBody.heartbeat === "sent" && opsCaptured.length === 1);
  heartbeat = "off";

  captured.length = 0;
  storageFailed = 2;
  check("failed storage work → 503", (await call({ authorization: `Bearer ${SECRET}` })).status === 503);
  check("…is alerted", captured.length === 1 && /storage cleanup failed/.test(captured[0].message));

  storageFailed = 0;

  // A18: deletions that exhausted their automatic retries are alerted (Admin shows them).
  captured.length = 0;
  needsAdmin = 1;
  check("deletions waiting for an admin → 202 (outstanding work)", (await call({ authorization: `Bearer ${SECRET}` })).status === 202);
  check("…is alerted with a fixed message", captured.length === 1 && /Account deletions are paused/.test(captured[0].message));
  needsAdmin = 0;

  // A22: production without a shared rate-limit store is reported (fixed
  // message, no env values), without changing the run's status.
  captured.length = 0;
  process.env.VERCEL_ENV = "production";
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  let res = await call({ authorization: `Bearer ${SECRET}` });
  check("production without a shared rate-limit store still completes (200)", res.status === 200 && (await res.json()).rateLimitStore === "per_instance");
  check("…and is alerted with a fixed message", captured.length === 1 && /Rate limits are per instance in production/.test(captured[0].message));
  process.env.KV_REST_API_URL = "https://kv.example.invalid"; process.env.KV_REST_API_TOKEN = "fixture-token";
  captured.length = 0;
  res = await call({ authorization: `Bearer ${SECRET}` });
  check("with a shared store nothing is alerted", res.status === 200 && (await res.json()).rateLimitStore === "ok" && captured.length === 0);
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  delete process.env.VERCEL_ENV;

  // A27: every authorized run flushes the digest, after the run's own alerts;
  // refused runs never do.
  digestRuns = 0; digestOrder = [];
  captured.length = 0;
  storageFailed = 1;
  await call({ authorization: `Bearer ${SECRET}` });
  check("an authorized run flushes the pending error digest once", digestRuns === 1);
  check("…after recording the run's own alerts (so the digest can include them)", digestOrder[0] === captured.length && captured.length === 1);
  storageFailed = 0;
  digestRuns = 0;
  await call({ authorization: "Bearer guess" });
  delete process.env.CRON_SECRET;
  await call({ authorization: `Bearer ${SECRET}` });
  check("refused or unconfigured runs never flush the digest", digestRuns === 0);

  console.log(`retention cron alerts: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
