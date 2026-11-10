import { NextResponse } from "next/server";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/data";
import { RETENTION_DAYS } from "@/lib/privacy/retention";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { cronAuthorized, MIN_CRON_SECRET_LENGTH } from "@/lib/privacy/cron";
import { runOperationalChecks } from "@/lib/operations/runtime";
import { processPendingStorageWork } from "@/lib/storage/work";
import { captureNow, flushAlertDigest } from "@/lib/monitoring/capture";
import { retryPausedDeletions } from "@/lib/account/deletionRetry";
import { rateLimitShared, sharedRateLimitStoreMissing, tryAcquireSharedLock } from "@/lib/rateLimit";
import { limitRoute } from "@/lib/api/limit";
import { pingHeartbeat } from "@/lib/operations/heartbeat";
import { maintenanceStepFailedMessage, reportHeartbeatFailed, type MaintenanceStep } from "@/lib/monitoring/opsAlerts";
import { resumePausedPushDevices } from "@/lib/push/resume";

// Authenticated maintenance entry point: retention, integrity, storage retry,
// paused account deletions (A18, with backoff), paused push devices (OPS3-09)
// and the pending error digest (A27). A scheduler must be configured
// separately; this route does not prove it runs. Vercel sends
// `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with no
// CRON_SECRET set the route refuses everything (fails closed), so nobody can
// trigger deletions from outside. The periods come from
// src/lib/privacy/retention.ts; the SQL side (run_retention_cleanup, 0054) is
// server-only and never touches fans, spins or redemptions.

// RS-05: the run does a lot of sequential work; without this a platform
// default of 10-15 s would cut it mid-way and silence the heartbeat.
export const maxDuration = 300;
/** OPS3-10: no step may take longer than this; a slow one is cut and named. */
export const STEP_TIMEOUT_MS = 60_000;
/** OPS3-10: two runs never overlap; a stuck holder frees the lock after this. */
export const RUN_LOCK_TTL_MS = 300_000;

// A23: a cron that can't run must be loud, or the privacy policy's retention
// periods silently stop applying. Each problem is one fixed message, so Admin ›
// Errors groups repeats and e-mails ALERT_EMAIL_TO on the first occurrence.
const loud = (message: string) => captureNow({ source: "server", message, route: "/api/cron/retention" });

/**
 * L6: the two alerts an unauthenticated caller can provoke (no secret
 * configured; a refused call claiming to be the scheduler, whose User-Agent
 * anyone can send) fire at most once per window across all callers. One
 * alert per hour is enough to get the problem fixed; more is noise.
 */
const CRON_ALERT_WINDOW_MS = 60 * 60 * 1000;
async function loudOncePerWindow(kind: "not_configured" | "secret_mismatch", message: string) {
  const { ok } = await rateLimitShared(`cron-alert:retention:${kind}`, 1, CRON_ALERT_WINDOW_MS);
  if (ok) await loud(message);
}

export type StepOutcome = { step: MaintenanceStep; status: "ok" | "failed" | "timed_out"; ms: number };

/**
 * OPS3-10: run one step under its own deadline. A throw or a timeout never
 * stops the run: the step is recorded, alerted by name, and `fallback` stands
 * in for its value so the later steps (and the heartbeat) still happen.
 */
async function runStep<T>(step: MaintenanceStep, outcomes: StepOutcome[], work: () => Promise<T>, fallback: T, failed: (value: T) => boolean = () => false): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => { timer = setTimeout(() => resolve("timed_out"), STEP_TIMEOUT_MS); timer.unref?.(); });
  let status: StepOutcome["status"] = "ok";
  let value = fallback;
  try {
    const result = await Promise.race([work().then((v) => ({ v })), timeout]);
    if (result === "timed_out") status = "timed_out";
    else { value = result.v; if (failed(value)) status = "failed"; }
  } catch {
    status = "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
  outcomes.push({ step, status, ms: Date.now() - started });
  if (status !== "ok" && step !== "cleanup") await loud(maintenanceStepFailedMessage(step, status === "timed_out" ? "timed_out" : "failed"));
  return value;
}

export async function GET(req: Request) {
  // L6: cap per client before anything else (the scheduler calls once a day).
  const limited = await limitRoute(req, "cron/retention:GET", "costly");
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
    // WA-09: still alerted server-side, but to a caller a missing secret looks
    // exactly like a wrong one (never "this deployment cannot run its cron").
    await loudOncePerWindow("not_configured", `Retention cron is not configured: set CRON_SECRET (at least ${MIN_CRON_SECRET_LENGTH} characters)`);
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  if (!cronAuthorized(req.headers.get("authorization"), secret)) {
    // Only the scheduler's own calls are worth an alert; random probes are not.
    if (/^vercel-cron\//i.test(req.headers.get("user-agent") ?? "")) {
      await loudOncePerWindow("secret_mismatch", "Retention cron was refused: the scheduler's CRON_SECRET does not match");
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true, demo: true, periods: RETENTION_DAYS }, { headers: NO_STORE_HEADERS });
  }

  // OPS3-10: never two runs at once (a late scheduler retry, an operator's
  // manual call while the nightly run is still working).
  const lock = await tryAcquireSharedLock("cron:retention", RUN_LOCK_TTL_MS);
  if (!lock.ok) return NextResponse.json({ error: "already_running" }, { status: 409, headers: NO_STORE_HEADERS });
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

async function run() {
  const svc = createServiceClient();
  const steps: StepOutcome[] = [];

  const cleanup = await runStep("cleanup", steps, async () => {
    const { data, error } = await svc.rpc("run_retention_cleanup", {
      p_audit_days: RETENTION_DAYS.adminAuditLog,
      p_notice_days: RETENTION_DAYS.creatorNotices,
      p_tombstone_days: RETENTION_DAYS.linkTombstones,
      p_app_error_days: RETENTION_DAYS.resolvedAppErrors,
      p_closed_invite_days: RETENTION_DAYS.closedAgencyInvites,
    }).abortSignal(AbortSignal.timeout(STEP_TIMEOUT_MS));
    if (error) { console.error("retention cleanup failed", error.message); return { failed: true as const, deleted: {} as Record<string, number | null> }; }
    return { failed: false as const, deleted: (data ?? {}) as Record<string, number | null> };
  }, { failed: true as const, deleted: {} }, (v) => v.failed);
  if (cleanup.failed) await loud("Retention cleanup failed: run_retention_cleanup returned an error");

  const health = await runStep("health", steps, () => runOperationalChecks("maintenance", svc), { demo: false, ok: false, canary: { status: "unavailable" as const }, invariants: { status: "unavailable" as const, counts: {}, rowLimit: 0 }, summary: null });
  // Resume paused deletions first so a resumed job's storage work is processed
  // in this same run.
  const deletions = await runStep("deletions", steps, () => retryPausedDeletions(svc), { due: 0, resumed: 0, completed: 0, pending: 0, failed: 1, waiting: 0, needsAdmin: 0 });
  const storage = await runStep("storage", steps, () => processPendingStorageWork(svc), { completed: 0, pending: 0, failed: 1, reviewRequired: 0, accountsCompleted: 0, accountsPending: 0 });
  // OPS3-09: paused push devices get one more try per day.
  const push = await runStep("push", steps, () => resumePausedPushDevices(svc), { error: "db_error" as const }, (v) => "error" in v);
  const deleted = cleanup.deleted;
  const total = Object.values(deleted).reduce<number>((s, n) => s + (Number(n) || 0), 0);
  if (total > 0) {
    await recordAudit({
      actorId: null,
      action: "retention.cleanup",
      details: {
        adminAuditLog: Number(deleted.admin_audit_log) || 0,
        creatorNotices: Number(deleted.creator_notices) || 0,
        linkTombstones: Number(deleted.link_tombstones) || 0,
        closedAgencyInvites: Number(deleted.org_invites) || 0,
        pushLog: Number(deleted.push_log) || 0,
        appErrors: deleted.app_errors === null ? null : Number(deleted.app_errors) || 0,
      },
    });
  }
  if (storage.failed > 0) await loud("Retention storage cleanup failed for some items; they stay queued for retry");
  if (deletions.needsAdmin > 0) await loud("Account deletions are paused and need an admin; retry them in Admin");
  // A22: without a shared store every rate limit is per serverless instance.
  // Visible, not fatal: the run's status is unchanged.
  const rateLimitStore = sharedRateLimitStoreMissing() ? "per_instance" : "ok";
  if (rateLimitStore === "per_instance") await loud("Rate limits are per instance in production: configure a shared store (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)");
  // After every other alert above, so a digest sent now covers them too.
  const digest = await runStep("digest", steps, () => flushAlertDigest(), "failed" as const, (v) => v === "failed");
  const pending = storage.pending > 0 || storage.accountsPending > 0 || deletions.pending > 0 || deletions.waiting > 0 || deletions.needsAdmin > 0;
  const stepFailed = steps.some((s) => s.status !== "ok");
  const status = cleanup.failed ? 500 : !health.ok || storage.failed > 0 || deletions.failed > 0 || stepFailed ? 503 : pending ? 202 : 200;
  // OPS-02/OPS3-10: the heartbeat says "the daily job ran to the end". A step
  // that failed was alerted by name above; the ping still goes out, so the
  // monitor's silence means exactly one thing: the job did not run. A refused
  // ping is itself recorded (OPS3-08), so System health can show it.
  const heartbeat = await pingHeartbeat();
  if (heartbeat === "failed") reportHeartbeatFailed();
  return NextResponse.json({
    ok: status < 300 && !pending, steps, heartbeat, health, pending, storage, deletions,
    pushResumed: "resumed" in push ? push.resumed : null, digest, rateLimitStore, deleted, periods: RETENTION_DAYS,
    ...(cleanup.failed ? { error: "cleanup_failed" } : {}),
  }, { status, headers: NO_STORE_HEADERS });
}
