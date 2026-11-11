import assert from "node:assert";
import { mock } from "node:test";

// GET /api/cron/retention: only Vercel Cron (Bearer CRON_SECRET) can trigger
// deletions. Negative cases: no secret configured (fails closed, 401 like a
// wrong one: WA-09), a short secret, a missing/wrong header → nothing runs.
// Positive: the RPC gets exactly the periods from src/lib/privacy/retention.ts
// and a summary is logged. OPS3-10: every step runs under its own deadline, a
// failed step is named and the run continues; RS-05 maxDuration = 300.

let passed = 0;
const check = (label: string, cond: unknown) => {
  assert.ok(cond, label);
  passed++;
};

const rpcCalls: { fn: string; args: Record<string, number> }[] = [];
const audits: Record<string, unknown>[] = [];
let deleted: Record<string, unknown> = { admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, app_errors: null };
let healthRuns = 0;
let healthOkay = true;
mock.module("@/lib/operations/runtime", { namedExports: { runOperationalChecks: async (source: string) => { assert.equal(source, "maintenance"); healthRuns++; return { ok: healthOkay }; } } });
let storageRuns = 0;
let storage = { completed: 0, pending: 0, failed: 0, reviewRequired: 0, accountsCompleted: 0, accountsPending: 0 };
mock.module("@/lib/storage/work", { namedExports: { processPendingStorageWork: async () => { storageRuns++; return storage; } } });

const pushResumed = 2;
mock.module("@/lib/supabase/server", {
  namedExports: {
    isSupabaseConfigured: () => true,
    createServiceClient: () => ({
      rpc: (fn: string, args: Record<string, number>) => {
        rpcCalls.push({ fn, args });
        const reply = { data: deleted, error: null };
        return Object.assign(Promise.resolve(reply), { abortSignal: async (signal: AbortSignal) => { assert.ok(signal instanceof AbortSignal, "the cleanup RPC carries a deadline"); return reply; } });
      },
      from: (table: string) => ({ update: () => ({ gte: async () => { assert.equal(table, "push_subscriptions"); return { count: pushResumed, error: null }; } }) }),
    }),
  },
});
mock.module("@/lib/data", {
  namedExports: { recordAudit: async (e: Record<string, unknown>) => void audits.push(e) },
});
// Failure alerts are covered by routeAlerts.test.ts; keep this file's RPC count exact.
mock.module("@/lib/monitoring/capture", { namedExports: { captureNow: async () => {}, flushAlertDigest: async () => "none" } });
// DB-04: what the route hands to the declined-applicant account deletion, and its answer.
const applicantCalls: unknown[] = [];
let applicants: { due: number; completed: number; pending: number; kept: number; failed: number } | "throw" = { due: 0, completed: 0, pending: 0, kept: 0, failed: 0 };
mock.module("@/lib/account/declinedApplicants", { namedExports: { deleteDeclinedApplicants: async (_svc: unknown, ids: unknown) => { applicantCalls.push(ids); if (applicants === "throw") throw new Error("boom"); return applicants; } } });
let deletionRuns = 0;
let deletions = { due: 0, resumed: 0, completed: 0, pending: 0, failed: 0, waiting: 0, needsAdmin: 0 };
mock.module("@/lib/account/deletionRetry", { namedExports: { retryPausedDeletions: async () => { deletionRuns++; return deletions; } } });

async function main() {
  const { GET } = await import("./route");
  const { RETENTION_DAYS } = await import("@/lib/privacy/retention");
  const call = (auth?: string) =>
    GET(new Request("http://localhost/api/cron/retention", { headers: auth ? { authorization: auth } : {} }));
  const SECRET = "s3cret-s3cret-s3cret-0123456789";

  delete process.env.CRON_SECRET;
  let res = await call(`Bearer ${SECRET}`);
  check("WA-09: no CRON_SECRET → 401 unauthorized (not a 503 that reveals it), nothing runs", res.status === 401 && (await res.json()).error === "unauthorized" && rpcCalls.length === 0);

  process.env.CRON_SECRET = "short";
  res = await call("Bearer short");
  check("a too-short secret is refused the same way", res.status === 401 && rpcCalls.length === 0);

  process.env.CRON_SECRET = SECRET;
  for (const h of [undefined, SECRET, `Bearer ${SECRET}x`, `bearer ${SECRET}`, "Bearer "]) {
    res = await call(h);
    check(`header ${JSON.stringify(h)?.slice(0, 20)} → 401`, res.status === 401);
  }
  check("nothing ran without the right header", rpcCalls.length === 0);
  check("unauthorized requests never process durable storage work", storageRuns === 0);
  check("unauthorized requests never run integrity checks", healthRuns === 0);
  check("unauthorized requests never resume paused account deletions", deletionRuns === 0);

  res = await call(`Bearer ${SECRET}`);
  check("right header → 200", res.status === 200 && /no-store/.test(res.headers.get("cache-control") ?? ""));
  const okBody = await res.json();
  check("OPS3-10: every step is reported ok with its duration", Array.isArray(okBody.steps) && okBody.steps.map((s: { step: string }) => s.step).join(",") === "cleanup,applicants,health,deletions,storage,push,digest" && okBody.steps.every((s: { status: string; ms: number }) => s.status === "ok" && Number.isFinite(s.ms)));
  check("OPS3-09: paused push devices were resumed", okBody.pushResumed === 2);
  check("OPS3-08: the heartbeat outcome is in the answer", okBody.heartbeat === "off");
  const routeModule = await import("./route");
  check("RS-05: maxDuration = 300 and every step is bounded", routeModule.maxDuration === 300 && routeModule.STEP_TIMEOUT_MS === 60_000);
  check("OPS3-10: overlap is the database's job (advisory lock in the cleanup, 0073): no app-side run lock", !("RUN_LOCK_TTL_MS" in routeModule) && okBody.error === undefined);
  check(
    "the RPC gets the documented periods",
    rpcCalls.length === 1 && rpcCalls[0].fn === "run_retention_cleanup" &&
      rpcCalls[0].args.p_audit_days === RETENTION_DAYS.adminAuditLog &&
      rpcCalls[0].args.p_notice_days === RETENTION_DAYS.creatorNotices &&
      rpcCalls[0].args.p_tombstone_days === RETENTION_DAYS.linkTombstones &&
      rpcCalls[0].args.p_app_error_days === RETENTION_DAYS.resolvedAppErrors &&
      rpcCalls[0].args.p_closed_invite_days === RETENTION_DAYS.closedAgencyInvites
  );
  check("a run that deleted nothing logs nothing", audits.length === 0);
  check("authorized retention also processes bounded storage retries", storageRuns === 1);
  check("authorized retention resumes paused account deletions (A18)", deletionRuns === 1);

  deleted = { push_log: 2, admin_audit_log: 3, creator_notices: 0, link_tombstones: 2, org_invites: 4, app_errors: null };
  res = await call(`Bearer ${SECRET}`);
  check("a run that deleted rows is logged with counts", audits.length === 1 && audits[0].action === "retention.cleanup" && (audits[0].details as { adminAuditLog?: number }).adminAuditLog === 3);
  check("push delivery log deletions are counted", (audits[0].details as { pushLog?: number }).pushLog === 2);
  check("closed agency invites are counted", (audits[0].details as { closedAgencyInvites?: number }).closedAgencyInvites === 4);
  check("app_errors before 0053 is reported as skipped (null)", (audits[0].details as { appErrors?: unknown }).appErrors === null);

  deleted = { push_log: 1, admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, org_invites: 0, app_errors: 0 };
  const priorAudits = audits.length;
  res = await call(`Bearer ${SECRET}`);
  check("push-only cleanup still produces its audit entry", res.status === 200 && audits.length === priorAudits + 1 && (audits.at(-1)?.details as { pushLog?: number }).pushLog === 1);

  // 0073: the cleanup's new keys. The applicants' ids go to the account
  // deletion and nowhere else: not the answer, not the audit log.
  const ID = "11111111-1111-4111-8111-111111111111";
  deleted = { admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, app_errors: 0, stale_spin_attempts: 3, declined_applications: 1, declined_applicant_ids: [ID] };
  applicants = { due: 1, completed: 1, pending: 0, kept: 0, failed: 0 };
  applicantCalls.length = 0;
  res = await call(`Bearer ${SECRET}`);
  let body = await res.json();
  const details = audits.at(-1)?.details as Record<string, unknown>;
  check("DB-04: the declined applicants' ids reach the account deletion", res.status === 200 && JSON.stringify(applicantCalls) === JSON.stringify([[ID]]));
  check("…and the answer carries counts, never the ids", body.declinedApplicants.completed === 1 && body.deleted.declined_applications === 1 && body.deleted.stale_spin_attempts === 3 && !JSON.stringify(body).includes(ID));
  check("the audit entry counts aged attempts, declined requests and deleted accounts without ids", details.staleSpinAttempts === 3 && details.declinedApplications === 1 && details.declinedApplicantAccountsDeleted === 1 && !JSON.stringify(details).includes(ID));
  applicants = { due: 1, completed: 0, pending: 1, kept: 0, failed: 0 };
  res = await call(`Bearer ${SECRET}`);
  check("an applicant deletion still in progress is 202 pending", res.status === 202 && (await res.json()).pending === true);
  applicants = { due: 1, completed: 0, pending: 0, kept: 0, failed: 1 };
  res = await call(`Bearer ${SECRET}`);
  check("an applicant account that could not be deleted is 503, never a silent success", res.status === 503);
  applicants = "throw";
  res = await call(`Bearer ${SECRET}`);
  body = await res.json();
  check("a crashing applicants step is named, counted as failed, and the run continues", res.status === 503 && body.steps.find((s: { step: string }) => s.step === "applicants")?.status === "failed" && body.declinedApplicants.failed === 1 && body.steps.length === 7);
  applicants = { due: 0, completed: 0, pending: 0, kept: 0, failed: 0 };
  deleted = { admin_audit_log: 0, creator_notices: 0, link_tombstones: 0, app_errors: 0, declined_applicant_ids: [] };
  const auditsBefore = audits.length;
  res = await call(`Bearer ${SECRET}`);
  check("an empty id list is not counted as a deletion (no audit entry, 200)", res.status === 200 && audits.length === auditsBefore);

  storage = { ...storage, accountsPending: 1, reviewRequired: 1 };
  res = await call(`Bearer ${SECRET}`);
  check("unresolved work returns202 with honest pending status", res.status === 202 && (await res.json()).pending === true);
  storage = { ...storage, accountsPending: 0, failed: 1 };
  res = await call(`Bearer ${SECRET}`);
  check("retry failures are reported503 rather than completed cleanup", res.status === 503 && (await res.json()).ok === false);
  storage = { ...storage, failed: 0 };
  deletions = { ...deletions, waiting: 1 };
  res = await call(`Bearer ${SECRET}`);
  check("a paused deletion waiting out its backoff is reported 202, never complete", res.status === 202 && (await res.json()).deletions.waiting === 1);
  deletions = { ...deletions, waiting: 0, failed: 1 };
  res = await call(`Bearer ${SECRET}`);
  check("a failed deletion resume is reported 503", res.status === 503 && (await res.json()).ok === false);
  deletions = { ...deletions, failed: 0 }; healthOkay = false;
  res = await call(`Bearer ${SECRET}`);
  check("integrity failure returns503 with honest health status", res.status === 503 && (await res.json()).health.ok === false);
  console.log(`retention cron route: ${passed} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
