import { NextResponse } from "next/server";
import { listFans } from "@/lib/data";

// The creator's persistent fan accounts, so the Fans tab survives a refresh.
export async function GET() {
  const fans = await listFans();
  return NextResponse.json({ fans });
}
