import { completeReadResponse } from "@/lib/api/completeRead";
import { NextResponse } from "next/server";
import { listFans } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// The creator's persistent fan accounts, so the Fans tab survives a refresh.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "fans:GET");
  if (rateLimited) return rateLimited;
  return completeReadResponse(async () => {
    const fans = await listFans();
    return NextResponse.json({ fans });
  });
}
