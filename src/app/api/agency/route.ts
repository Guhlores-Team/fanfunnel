import { NextResponse } from "next/server";
import { getAgencyOverview } from "@/lib/data";

// The agency roll-up for the org the signed-in user owns or belongs to.
export async function GET() {
  const overview = await getAgencyOverview();
  return NextResponse.json(overview);
}
