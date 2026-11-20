import { NextResponse } from "next/server";
import { getFanRewardHistory } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { REWARD_VIEW_LIMIT, REWARD_VIEW_WINDOW_MS } from "@/lib/rewards/config";
import { decodeRewardHistoryCursor } from "@/lib/rewards/history";

export async function POST(req: Request) {
  const response = await withFanToken<{ token?: unknown; cursor?: unknown }>(req,
    { scope: "fan-reward-history", limit: REWARD_VIEW_LIMIT, windowMs: REWARD_VIEW_WINDOW_MS },
    async (token, body) => {
      if (body.cursor !== undefined && !decodeRewardHistoryCursor(body.cursor)) return badRequest();
      const result = await getFanRewardHistory(token, body.cursor as string | undefined);
      if ("error" in result) return errorResponse(result.error);
      return NextResponse.json(result);
    });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
