import { NextResponse } from "next/server";
import { listMySeatCreators } from "@/lib/data/seatScope";
import { errorResponse } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// A19: the creators the signed-in user's agency seat may act for, and which
// jobs (inbox / fulfilment). Server-derived from org_members + can_act_for.
// `?job=manage` also says which of them the seat may run campaigns for (A28).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "agency/seats:GET");
  if (rateLimited) return rateLimited;
  const seats = await listMySeatCreators({ manage: new URL(req.url).searchParams.get("job") === "manage" });
  if ("error" in seats) return errorResponse(seats.error);
  return NextResponse.json({ seats }, { headers: NO_STORE_HEADERS });
}
