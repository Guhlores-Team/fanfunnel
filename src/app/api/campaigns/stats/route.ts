import { NextResponse } from "next/server";
import { getCampaignStats } from "@/lib/data";

// Per-campaign comparison stats (spins, unique fans, fulfilled, top prize).
export async function GET() {
  const stats = await getCampaignStats();
  return NextResponse.json({ stats });
}
