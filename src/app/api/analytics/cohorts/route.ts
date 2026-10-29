import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getCohortRetention } from "@/lib/data";

// #19 Cohort retention: fans cohorted by their first grant's campaign.
export async function GET() {
  return completeReadResponse(async () => {
    const rows = await getCohortRetention();
    return NextResponse.json({ rows });
  });
}
