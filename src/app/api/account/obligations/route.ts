import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getCreatorObligations } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// What fans are still owed (prizes, unplayed tipped spins), read before a
// data wipe or account close. One SQL call with 0073; a complete read before.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "account/obligations:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const obligations = await getCreatorObligations();
    if (!obligations) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json(obligations, { headers: { "Cache-Control": "no-store" } });
  });
}
