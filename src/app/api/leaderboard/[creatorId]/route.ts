import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";

// Public leaderboard for a creator. Returns enabled:false when the creator
// hasn't turned it on. Only opted-in fans' handles ever appear.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  return completeReadResponse(async () => {
    // Public and uncached: cap per-IP reads (scraping / enumeration).
    const limited = await rateLimitOr429("board:" + clientIp(req), 60, 60_000);
    if (limited) return limited;
    const { creatorId } = await params;
    const view = await getLeaderboard(creatorId);
    // L5: an unknown, suspended or unapproved creator has no board.
    if (!view) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(view);
  });
}
