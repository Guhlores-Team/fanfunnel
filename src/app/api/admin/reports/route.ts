import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { listReports, reviewReport, decodeReportCursor } from "@/lib/data/reports";
import { recordAudit } from "@/lib/data/audit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { REPORT_NOTE_MAX, REPORT_REASONS, REPORT_STATUSES, type ReportStatus } from "@/lib/reports/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_STATUSES: readonly string[] = [...REPORT_STATUSES, "all"];

// Admin › Reports: the fan safety queue. Both handlers check is_admin() (role,
// is_active and a two-factor session) first; the data layer then reads and
// updates with the caller's own client, so the admin-only RLS policy on
// creator_reports applies as a second gate. The service role is never used.

// GET ?status=open|resolved|dismissed|all&reason=<a known reason>&before=<cursor>
export async function GET(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "open";
  const reason = url.searchParams.get("reason") || undefined;
  const before = url.searchParams.get("before");
  if (!LIST_STATUSES.includes(status)) return badRequest();
  if (reason !== undefined && !(REPORT_REASONS as readonly string[]).includes(reason)) return badRequest();
  if (before !== null && !decodeReportCursor(before)) return badRequest();
  const page = await listReports({ status: status as ReportStatus | "all", reason }, before);
  if ("error" in page) return NextResponse.json({ error: page.error }, { status: 500, headers: NO_STORE_HEADERS });
  return NextResponse.json(page, { headers: NO_STORE_HEADERS });
}

// POST { id, status: "resolved" | "dismissed" | "open", note? } — review one report.
export async function POST(req: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = await parseJsonBody<{ id?: unknown; status?: unknown; note?: unknown }>(req);
  if (body === BAD_REQUEST || !body || typeof body !== "object" || Array.isArray(body)) return badRequest();
  const { id, status, note } = body;
  if (typeof id !== "string" || !UUID.test(id)) return badRequest();
  if (typeof status !== "string" || !(REPORT_STATUSES as readonly string[]).includes(status)) return badRequest();
  if (note !== undefined && note !== null && typeof note !== "string") return badRequest();
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length > REPORT_NOTE_MAX) return badRequest("note_too_long");

  const result = await reviewReport(id, status as ReportStatus, trimmed || null, admin.userId);
  if ("error" in result) {
    return result.error === "not_found"
      ? errorResponse("not_found")
      : NextResponse.json({ error: result.error }, { status: 500 });
  }
  await recordAudit({
    actorId: admin.userId,
    action: status === "resolved" ? "report.resolve" : status === "dismissed" ? "report.dismiss" : "report.reopen",
    targetType: "report",
    targetId: id,
    // The reason is a fixed menu value; the note and what the fan wrote stay out of the log.
    details: { urgent: result.report.urgent, withNote: trimmed.length > 0 },
  });
  return NextResponse.json({ ok: true, report: result.report });
}
