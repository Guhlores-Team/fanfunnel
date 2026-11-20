import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { getCreatorCrm } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Creator CRM: whales (top LTV) + dormant fans to win back (RLS-scoped).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "crm:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const crm = await getCreatorCrm();
    return NextResponse.json(crm);
  });
}
