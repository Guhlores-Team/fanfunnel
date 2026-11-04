import { NextResponse } from "next/server";
import { getAgencyOverview } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// The agency roll-up for the org the signed-in user owns or belongs to.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "agency:GET");
  if (rateLimited) return rateLimited;
  const overview = await getAgencyOverview();
  return NextResponse.json(overview);
}
