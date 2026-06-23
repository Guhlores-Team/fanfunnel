import { NextResponse } from "next/server";
import { claimAdmin } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// One-time admin bootstrap: promotes the signed-in user to admin IF their email
// is in the ADMIN_EMAILS env allowlist. Safe no-op otherwise.
export async function POST() {
  const result = await claimAdmin();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
