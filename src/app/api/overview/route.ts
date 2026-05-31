import { NextResponse } from "next/server";
import { getOverview } from "@/lib/data";

// Creator dashboard data: metrics + the prize fulfilment queue.
export async function GET() {
  const overview = await getOverview();
  return NextResponse.json(overview);
}
