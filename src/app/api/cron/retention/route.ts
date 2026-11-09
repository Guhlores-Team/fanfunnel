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
import { rateLimitShared, sharedRateLimitStoreMissing } from "@/lib/rateLimit";
import { limitRoute } from "@/lib/api/limit";
import { pingHeartbeat } from "@/lib/operations/heartbeat";

// Authenticated maintenance entry point: retention, integrity, storage retry,
// paused account deletions (A18, with backoff) and the pending error digest (A27).
// A scheduler must be configured separately; this route does not prove it runs.
// Vercel sends
// `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with no
// CRON_SECRET set the route refuses everything (fails closed), so nobody can
// trigger deletions from outside. The periods come from
// src/lib/privacy/retention.ts; the SQL side (run_retention_cleanup, 0054) is
// server-only and never touches fans, spins or redemptions.

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

export async function GET(req: Request) {
  // L6: cap per client before anything else (the scheduler calls once a day).
  const limited = await limitRoute(req, "cron/retention:GET", "costly");
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
    await loudOncePerWindow("not_configured", `Retention cron is not configured: set CRON_SECRET (at least ${MIN_CRON_SECRET_LENGTH} characters)`);
    return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE_HEADERS });
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

  const svc = createServiceClient();
  const { data, error } = await svc.rpc("run_retention_cleanup", {
    p_audit_days: RETENTION_DAYS.adminAuditLog,
    p_notice_days: RETENTION_DAYS.creatorNotices,
    p_tombstone_days: RETENTION_DAYS.linkTombstones,
    p_app_error_days: RETENTION_DAYS.resolvedAppErrors,
    p_closed_invite_days: RETENTION_DAYS.closedAgencyInvites,
  });
  if (error) {
    console.error("retention cleanup failed", error.message);
    await loud("Retention cleanup failed: run_retention_cleanup returned an error");
    return NextResponse.json({ error: "cleanup_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }

  const health = await runOperationalChecks("maintenance", svc);
  // Resume paused deletions first so a resumed job's storage work is processed
  // in this same run.
  const deletions = await retryPausedDeletions(svc);
  const storage = await processPendingStorageWork(svc);
  const deleted = (data ?? {}) as Record<string, number | null>;
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
  const digest = await flushAlertDigest();
  const pending = storage.pending > 0 || storage.accountsPending > 0 || deletions.pending > 0 || deletions.waiting > 0 || deletions.needsAdmin > 0;
  const status = !health.ok || storage.failed > 0 || deletions.failed > 0 ? 503 : pending ? 202 : 200;
  // OPS-02: tell the external monitor this run succeeded (work still queued
  // for the next run is not a failure). Silence there is the alert.
  if (status < 500) await pingHeartbeat();
  return NextResponse.json({ ok: health.ok && !pending && storage.failed === 0 && deletions.failed === 0, health, pending, storage, deletions, digest, rateLimitStore, deleted, periods: RETENTION_DAYS }, {
    status, headers: NO_STORE_HEADERS,
  });
}
