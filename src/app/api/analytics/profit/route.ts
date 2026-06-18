import { NextResponse } from "next/server";
import { getProfitSummary } from "@/lib/data";

// Revenue − prize cost = profit, over a window. The honest bottom line.
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days =
    Number.isFinite(raw) && raw > 0
      ? Math.min(90, Math.max(1, Math.floor(raw)))
      : 90;
  const summary = await getProfitSummary(days);
  return NextResponse.json({ summary });
}
