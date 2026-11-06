import { NextResponse } from "next/server";
import { getFanReward, isShareIdShape } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { REWARD_VIEW_LIMIT, REWARD_VIEW_WINDOW_MS } from "@/lib/rewards/config";

// #26: a fan reopens an instant reward they won. Body: { token, shareId }.
// The link token is the only credential (F5): the spin must belong to the
// token's own fan, and anything else (another fan's win, an unknown share id)
// is a plain 404, so a share id alone reveals nothing. A paused or blocked
// link is 403. Every view is logged for the creator, and the value is never
// cached. Rate-limited per IP + token.
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown; shareId?: unknown }>(
    req,
    { scope: "fan-reward", limit: REWARD_VIEW_LIMIT, windowMs: REWARD_VIEW_WINDOW_MS },
    async (token, body) => {
      if (!isShareIdShape(body.shareId)) return badRequest();
      const result = await getFanReward(token, body.shareId);
      if ("error" in result) {
        if (result.error === "unavailable") {
          return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        return errorResponse(result.error);
      }
      return NextResponse.json(
        { reward: result.reward, views: result.views },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
  );
}
