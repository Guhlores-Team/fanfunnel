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
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({ rpc: async () => ({ data: rpcError ? null : {}, error: rpcError }) }),
  },
});
mock.module("@/lib/data", { namedExports: { recordAudit: async () => {} } });

async function main() {
  const { GET } = await import("./route");
  const SECRET = "s3cret-s3cret-s3cret-0123456789";
  const call = (headers: Record<string, string> = {}) => GET(new Request("http://localhost/api/cron/retention", { headers }));

  delete process.env.CRON_SECRET;
  check("no secret → 503", (await call({ authorization: `Bearer ${SECRET}` })).status === 503);
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
  check("a failed cleanup → 500", (await call({ authorization: `Bearer ${SECRET}` })).status === 500);
  check("…is alerted with a fixed message", captured.length === 1 && captured[0].message === "Retention cleanup failed: run_retention_cleanup returned an error");
  rpcError = null;

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
