import { NextResponse } from "next/server";
import { getAdminOverview } from "@/lib/data";
import { requireAdminRoute } from "@/lib/auth/admin";

// Cross-account overview. Returns 403 to non-admins.
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const overview = await getAdminOverview();
  if (!overview) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(overview);
}
