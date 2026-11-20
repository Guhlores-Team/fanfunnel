import { NextResponse } from "next/server";
import { listAuditLog } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";
import { AUDIT_FILTER } from "@/components/admin/auditLabels";

// Admin activity log (newest first). Admins on a two-factor session only: the
// route guard, the data layer's isActiveAdmin() and RLS (is_admin() needs aal2)
// each refuse anyone else.
// OPS-04: ?action=<text> filters by action code or label; ?before=<createdAt
// of the last entry shown> loads the next older page. `more` says one exists.
export const AUDIT_PAGE = 50;
const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

export async function GET(req?: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const params = req ? new URL(req.url).searchParams : new URLSearchParams();
  const action = params.get("action")?.trim() || undefined;
  const before = params.get("before") || undefined;
  if ((action && !AUDIT_FILTER.test(action)) || (before && !CURSOR.test(before))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const rows = await listAuditLog(AUDIT_PAGE + 1, { action, before });
  if (!rows) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json({ entries: rows.slice(0, AUDIT_PAGE), more: rows.length > AUDIT_PAGE }, { headers: NO_STORE_HEADERS });
}
