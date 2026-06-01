import { NextResponse } from "next/server";
import { claimAdmin } from "@/lib/data";

// One-time admin bootstrap: promotes the signed-in user to admin IF their email
// is in the ADMIN_EMAILS env allowlist. Safe no-op otherwise.
export async function POST() {
  const result = await claimAdmin();
  if ("error" in result) {
    const status =
      result.error === "unauthorized"
        ? 401
        : result.error === "not_allowed" || result.error === "not_configured"
          ? 403
          : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json(result);
}
