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
  // Public and uncached: cap per-IP reads (scraping / enumeration).
  const limited = await rateLimitOr429("board:" + clientIp(req), 60, 60_000);
  if (limited) return limited;
  const { creatorId } = await params;
  const view = await getLeaderboard(creatorId);
  return NextResponse.json(view);
}
