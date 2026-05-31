import { NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/data";

// Public leaderboard for a creator. Returns enabled:false when the creator
// hasn't turned it on. Only opted-in fans' handles ever appear.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  const { creatorId } = await params;
  const view = await getLeaderboard(creatorId);
  return NextResponse.json(view);
}
