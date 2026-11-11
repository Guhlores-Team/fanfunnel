import { NextResponse } from "next/server";
import { claimAdmin } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// One-time admin bootstrap: promotes the signed-in user to admin IF their email
// is in the ADMIN_EMAILS env allowlist. Safe no-op otherwise.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "admin/claim:POST", "costly");
  if (rateLimited) return rateLimited;
  const result = await claimAdmin();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
