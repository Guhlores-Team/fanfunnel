import { NextResponse } from "next/server";
import { getReferralStats } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Creator-side referral rollup (RLS-scoped).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "referrals/stats:GET");
  if (rateLimited) return rateLimited;
  const stats = await getReferralStats();
  return NextResponse.json(stats);
}
