import { NextResponse } from "next/server";
import { createServiceClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { recordAudit } from "@/lib/data";
import { RETENTION_DAYS } from "@/lib/privacy/retention";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { cronAuthorized, MIN_CRON_SECRET_LENGTH } from "@/lib/privacy/cron";

// Daily data-retention cleanup, run by Vercel Cron (vercel.json). Vercel sends
// `Authorization: Bearer $CRON_SECRET`; anything else is refused, and with no
// CRON_SECRET set the route refuses everything (fails closed), so nobody can
// trigger deletions from outside. The periods come from
// src/lib/privacy/retention.ts; the SQL side (run_retention_cleanup, 0054) is
// server-only and never touches fans, spins or redemptions.

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
    return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE_HEADERS });
  }
  if (!cronAuthorized(req.headers.get("authorization"), secret)) {
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
  });
  if (error) {
    console.error("retention cleanup failed", error.message);
    return NextResponse.json({ error: "cleanup_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }

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
        appErrors: deleted.app_errors === null ? null : Number(deleted.app_errors) || 0,
      },
    });
  }
  return NextResponse.json({ ok: true, deleted, periods: RETENTION_DAYS }, { headers: NO_STORE_HEADERS });
}
