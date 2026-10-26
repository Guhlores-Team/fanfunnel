import { NextResponse } from "next/server";
import { markNotificationsSeen } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// Opening the bell marks everything in it as seen. Writes only the caller's own
// profiles.notifications_seen_at, via the SECURITY DEFINER
// set_notifications_seen() RPC (migration 0043). Signed out → 401.
export async function POST() {
  const result = await markNotificationsSeen();
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
