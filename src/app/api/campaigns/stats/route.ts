import { NextResponse } from "next/server";
import { getCampaignStats, getUncategorizedStats } from "@/lib/data";

// Per-campaign comparison stats + an "uncategorized" rollup for spins/revenue
// not attributed to any campaign (so nothing sits in limbo).
export async function GET() {
  const [stats, uncategorized] = await Promise.all([
    getCampaignStats(),
    getUncategorizedStats(),
  ]);
  return NextResponse.json({ stats, uncategorized });
}
