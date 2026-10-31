import { NextResponse } from "next/server";
import { getAgencyOverview } from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase/server";

// The agency roll-up for the org the signed-in user owns or belongs to.
export async function GET() {
  // A36: the demo has no agencies; the page says so rather than offering a
  // create form that keeps nothing.
  if (!isSupabaseConfigured()) return NextResponse.json({ org: null, demo: true });
  const overview = await getAgencyOverview();
  return NextResponse.json(overview);
}
