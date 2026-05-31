import { NextResponse } from "next/server";
import { getPrizeRoi } from "@/lib/data";

// #18 Prize ROI: per-prize win counts joined to the creator's fulfilment cost.
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("days"));
  const days =
    Number.isFinite(raw) && raw > 0
      ? Math.min(90, Math.max(1, Math.floor(raw)))
      : 90;
  const rows = await getPrizeRoi(days);
  return NextResponse.json({ rows });
}
