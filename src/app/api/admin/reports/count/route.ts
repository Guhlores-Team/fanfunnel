import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/auth/admin";
import { countOpenReports } from "@/lib/data/reports";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// The open-report count behind the Admin nav badge. Admin only (is_admin(),
// two-factor session); RLS on creator_reports is the second gate.
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const openCount = await countOpenReports();
  if (openCount === null) return NextResponse.json({ error: "load_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  return NextResponse.json({ openCount }, { headers: NO_STORE_HEADERS });
}
