import { NextResponse } from "next/server";
import { takeBreak } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { PLAY_ROUTE_LIMIT, PLAY_ROUTE_WINDOW_MS } from "@/lib/play/config";
import { breakDurationMs } from "@/lib/play/playGuard";

// RM-6: a fan takes a break. Body: { token, duration: "24h" | "7d" | "30d" }.
// The end time is computed on the server from that fixed menu (the client never
// sends a time), and a break in force is never shortened: asking for less keeps
// the longer one. claim_spin refuses every spin until it ends.
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown; duration?: unknown }>(
    req,
    { scope: "fan-break", limit: PLAY_ROUTE_LIMIT, windowMs: PLAY_ROUTE_WINDOW_MS },
    async (token, body) => {
      const ms = breakDurationMs(body.duration);
      if (ms === null) return badRequest();
      const result = await takeBreak(token, ms);
      if ("error" in result) return errorResponse(result.error);
      return NextResponse.json({ breakUntil: result.breakUntil });
    },
  );
}
