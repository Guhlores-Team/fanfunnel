import { NextResponse } from "next/server";
import { myAgencyImpact } from "@/lib/data/agencyAdmin";
import { limitRoute } from "@/lib/api/limit";
import { NO_STORE_HEADERS } from "@/lib/privacy/respond";

// WG-04: what closing the signed-in account would do to the agency it owns
// (seat and creator counts), for the Close-account warning. The caller's
// own id only; null when they own no agency.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "agency/impact:GET");
  if (rateLimited) return rateLimited;
  const impact = await myAgencyImpact();
  return NextResponse.json({ impact }, { headers: NO_STORE_HEADERS });
}
