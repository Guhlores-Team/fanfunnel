import { NextResponse } from "next/server";
import { getNotifications } from "@/lib/data";
import { errorResponse } from "@/lib/api/handler";

// The notification bell's feed (RD-7): derived from the signed-in creator's own
// pending wins, unread fan messages, low prize stock and fans who ran out of
// spins, plus the unread count. Signed out → 401 (demo mode has no auth).
export async function GET() {
  const feed = await getNotifications();
  if (!feed) return errorResponse("unauthorized");
  return NextResponse.json(feed, { headers: { "Cache-Control": "no-store" } });
}
