import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getEngagementHeatmap } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// #17 Best-time heatmap: spins bucketed by (UTC weekday, UTC hour).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "analytics/heatmap:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const raw = Number(new URL(req.url).searchParams.get("days"));
    const days =
      Number.isFinite(raw) && raw > 0
        ? Math.min(90, Math.max(1, Math.floor(raw)))
        : 90;
    const heatmap = await getEngagementHeatmap(days);
    return NextResponse.json({ heatmap });
  });
}
