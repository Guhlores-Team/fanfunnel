import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getOverview } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Creator dashboard data: metrics + the prize fulfilment queue.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "overview:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const overview = await getOverview();
    return NextResponse.json(overview);
  });
}
