import { NextResponse } from "next/server";
import { getCreatorCrm } from "@/lib/data";

// Creator CRM: whales (top LTV) + dormant fans to win back (RLS-scoped).
export async function GET() {
  const crm = await getCreatorCrm();
  return NextResponse.json(crm);
}
