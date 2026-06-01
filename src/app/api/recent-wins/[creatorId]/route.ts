import { NextResponse } from "next/server";
import { getRecentWins } from "@/lib/data";

// Recent rare+ wins for a creator (handle-only, opt-in fans only). Empty when
// the creator's leaderboard is off.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ creatorId: string }> }
) {
  const { creatorId } = await params;
  const wins = await getRecentWins(creatorId);
  return NextResponse.json({ wins });
}
