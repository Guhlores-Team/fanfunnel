import { NextResponse } from "next/server";
import { getProfitSummary } from "@/lib/data";

// Revenue − prize cost = profit, over a window. The honest bottom line.
export async function GET(req: Request) {
  const days = Number(new URL(req.url).searchParams.get("days") ?? "90");
  const summary = await getProfitSummary(days);
  return NextResponse.json({ summary });
}
