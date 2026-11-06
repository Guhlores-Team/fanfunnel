import { NextResponse } from "next/server";
import { getMyAccount } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// The signed-in creator's account settings (display name, email, notify prefs).
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "account:GET");
  if (rateLimited) return rateLimited;
  const account = await getMyAccount();
  return NextResponse.json(account, { headers: { "Cache-Control": "no-store" } });
}
