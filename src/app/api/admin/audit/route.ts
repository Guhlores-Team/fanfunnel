import { NextResponse } from "next/server";
import { listAuditLog } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// Admin activity log (newest first). Admins on a two-factor session only: the
// route guard, the data layer's isActiveAdmin() and RLS (is_admin() needs aal2)
// each refuse anyone else.
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const entries = await listAuditLog(200);
  if (!entries) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE_HEADERS });
  }
  return NextResponse.json({ entries }, { headers: NO_STORE_HEADERS });
}
