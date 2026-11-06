import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getCohortRetention } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// #19 Cohort retention: fans cohorted by their first grant's campaign.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "analytics/cohorts:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const rows = await getCohortRetention();
    return NextResponse.json({ rows });
  });
}
