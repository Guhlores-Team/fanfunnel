import { NextResponse } from "next/server";
import { getMyAccount } from "@/lib/data";

// The signed-in creator's account settings (display name, email, notify prefs).
export async function GET() {
  const account = await getMyAccount();
  return NextResponse.json(account);
}
