import { NextResponse } from "next/server";
import { getAgencyOverview } from "@/lib/data";
import { getManagedOrgState } from "@/lib/data/admin";
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
  // WG-03: `?org=<id>` picks which of the caller's agencies to show.
  const requested = new URL(req.url).searchParams.get("org");
  if (requested !== null && requested.length > 64) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const overview = await getAgencyOverview({ orgId: requested });
  if (overview) return NextResponse.json(overview);
  // A45: a creator an agency manages has no console of its own; the page
  // explains what the agency can do instead of offering to start one, and
  // offers to leave it (the caller's own profiles.org_id; org_leave acts on
  // the caller's own rows only, so the id grants nothing).
  const standing = await getAgencyStanding();
  if (!standing?.inAgency) return NextResponse.json(null);
  // WG-13: say when the agency's owner is suspended (orgs.owner_active, 0073).
  const state = await getManagedOrgState(standing.creatorOrgId);
  return NextResponse.json({ org: null, managed: true, orgId: standing.creatorOrgId, orgName: state.orgName, ownerActive: state.ownerActive });
}
