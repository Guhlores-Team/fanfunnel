import { NextResponse } from "next/server";
import { withFanMissLimit } from "@/lib/api/fanMiss";
import { selfExclude } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { refuseCreatorSession } from "@/lib/fan/creatorGuard";

// A fan pauses their own spin link. Body: { token }.
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string }>(req);
  const token = body !== BAD_REQUEST && typeof body.token === "string" && body.token ? body.token : null;
  if (token) {
    // ATK-01: only the fan pauses their own link for good. First, so it never
    // spends the fan's budgets below.
    const refused = await refuseCreatorSession(req, token);
    if (refused) return refused;
  }
  return withFanMissLimit(req, async () => {
    const limited = await rateLimitOr429("selfexclude:" + clientIp(req), 10, 60_000);
    if (limited) return limited;
    if (!token) return badRequest();
    const result = await selfExclude(token);
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}
