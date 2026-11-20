import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getCampaignStats, getUncategorizedStats } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Per-campaign comparison stats + an "uncategorized" rollup for spins/revenue
// not attributed to any campaign (so nothing sits in limbo).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "campaigns/stats:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const [stats, uncategorized] = await Promise.all([
      getCampaignStats(),
      getUncategorizedStats(),
    ]);
    return NextResponse.json({ stats, uncategorized });
  });
}
