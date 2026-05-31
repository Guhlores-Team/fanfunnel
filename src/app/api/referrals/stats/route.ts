import { NextResponse } from "next/server";
import { getReferralStats } from "@/lib/data";

// Creator-side referral rollup (RLS-scoped).
export async function GET() {
  const stats = await getReferralStats();
  return NextResponse.json(stats);
}
