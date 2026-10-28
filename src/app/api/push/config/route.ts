import { NextResponse } from "next/server";
import { getPushConfig } from "@/lib/data";

// Is web push on for this deployment, and the VAPID PUBLIC key the browser
// subscribes with. Public by nature (it's in every subscription request); the
// private key never leaves the server. Keys unset → { available: false }.
export async function GET() {
  return NextResponse.json(getPushConfig(), { headers: { "Cache-Control": "no-store" } });
}
