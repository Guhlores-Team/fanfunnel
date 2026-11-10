import { NextResponse } from "next/server";
import { withFanMissLimit } from "@/lib/api/fanMiss";
import { selfExclude } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { refuseCreatorSession } from "@/lib/fan/creatorGuard";

// A fan pauses their own spin link. Body: { token }.
export async function POST(req: Request) {
  return withFanMissLimit(req, async () => {
    const limited = await rateLimitOr429("selfexclude:" + clientIp(req), 10, 60_000);
    if (limited) return limited;

    const body = await parseJsonBody<{ token?: string }>(req);
    if (body === BAD_REQUEST) return badRequest();
    if (typeof body.token !== "string" || !body.token) {
      return badRequest();
    }
    // ATK-01: only the fan pauses their own link for good.
    const refused = await refuseCreatorSession(body.token);
    if (refused) return refused;
    const result = await selfExclude(body.token);
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}
