import { NextResponse } from "next/server";
import { getAgencyOverview } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";
import { getAgencyStanding } from "@/lib/data/seatScope";
import { isSupabaseConfigured } from "@/lib/supabase/server";

// The agency roll-up for the org the signed-in user owns or belongs to.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "agency:GET");
  if (rateLimited) return rateLimited;
  // A36: the demo has no agencies; the page says so rather than offering a
  // create form that keeps nothing.
  if (!isSupabaseConfigured()) return NextResponse.json({ org: null, demo: true });
  const overview = await getAgencyOverview();
  if (overview) return NextResponse.json(overview);
  // A45: a creator an agency manages has no console of its own; the page
  // explains what the agency can do instead of offering to start one.
  const standing = await getAgencyStanding();
  return NextResponse.json(standing?.inAgency ? { org: null, managed: true } : null);
}
