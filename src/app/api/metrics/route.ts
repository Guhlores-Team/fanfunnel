import { NextResponse } from "next/server";
import { getMetricsExtra } from "@/lib/data";

// Dashboard extras: a daily spin trend + a link → spin → fulfilled funnel.
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(raw) && raw > 0 ? Math.min(90, Math.max(1, Math.floor(raw))) : 30;
  const metrics = await getMetricsExtra(days);
  return NextResponse.json(metrics);
}
