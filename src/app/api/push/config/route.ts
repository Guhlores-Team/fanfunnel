import { NextResponse } from "next/server";
import { getPushConfig } from "@/lib/data";
import { limitRoute } from "@/lib/api/limit";

// Is web push on for this deployment, and the VAPID PUBLIC key the browser
// subscribes with. Public by nature (it's in every subscription request); the
// private key never leaves the server. Keys unset → { available: false }.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "push/config:GET", "public");
  if (rateLimited) return rateLimited;
  return NextResponse.json(getPushConfig(), { headers: { "Cache-Control": "no-store" } });
}
