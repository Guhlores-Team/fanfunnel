import { NextResponse } from "next/server";
import { setFanChatMute } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { PLAY_ROUTE_LIMIT, PLAY_ROUTE_WINDOW_MS } from "@/lib/play/config";

// TS-17: a fan mutes (or unmutes) the creator's messages. Body: { token, muted }.
// The link token is the only key (nothing in the body names a fan), the
// creator's own session is refused (the choice is the fan's), and a link that
// is not live answers 404 like the age gate's acknowledgement. While muted,
// the database refuses every creator-side message to this fan.
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown; muted?: unknown }>(
    req,
    // ATK-01 (fanOnly): muting is the fan's choice; the creator has their own controls.
    { scope: "fan-mute", limit: PLAY_ROUTE_LIMIT, windowMs: PLAY_ROUTE_WINDOW_MS, fanOnly: true },
    async (token, body) => {
      if (typeof body.muted !== "boolean") return badRequest();
      const result = await setFanChatMute(token, body.muted);
      if ("error" in result) return errorResponse(result.error);
      return NextResponse.json({ muted: result.muted }, { headers: { "Cache-Control": "private, no-store" } });
    },
  );
}
