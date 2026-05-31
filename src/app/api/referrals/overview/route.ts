import { NextResponse } from "next/server";
import { getReferralOverview } from "@/lib/data";

// A fan's referral summary (code, counts, cap, bonus). Token-gated.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const overview = await getReferralOverview(token);
  return NextResponse.json(overview);
}
