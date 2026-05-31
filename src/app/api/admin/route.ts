import { NextResponse } from "next/server";
import { getAdminOverview } from "@/lib/data";

// Cross-account overview. Returns 403 to non-admins.
export async function GET() {
  const overview = await getAdminOverview();
  if (!overview) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(overview);
}
