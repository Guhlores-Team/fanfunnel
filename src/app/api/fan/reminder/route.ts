import { NextResponse } from "next/server";
import { setPlayReminder } from "@/lib/data";
import { withFanToken } from "@/lib/api/fanToken";
import { badRequest, errorResponse } from "@/lib/api/handler";
import { PLAY_ROUTE_LIMIT, PLAY_ROUTE_WINDOW_MS } from "@/lib/play/config";
import { isPlayReminder } from "@/lib/play/playGuard";

// RM-6: a fan sets (or turns off) their own daily play reminder.
// Body: { token, daily: 20 | 50 | 100 | null }. Soft by design: it only makes
// the fan page ask "Want a breather?" before the next spin.
export async function POST(req: Request) {
  return withFanToken<{ token?: unknown; daily?: unknown }>(
    req,
    { scope: "fan-reminder", limit: PLAY_ROUTE_LIMIT, windowMs: PLAY_ROUTE_WINDOW_MS },
    async (token, body) => {
      const daily = body.daily;
      if (!isPlayReminder(daily)) return badRequest();
      const result = await setPlayReminder(token, daily);
      if ("error" in result) return errorResponse(result.error);
      return NextResponse.json({ reminder: result.reminder });
    },
  );
}
