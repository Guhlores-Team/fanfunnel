import { NextResponse } from "next/server";
import { withFanMissLimit } from "@/lib/api/fanMiss";
import { ackFan } from "@/lib/data";
import { clientIp } from "@/lib/api/clientIp";
import { rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { tokenKey } from "@/lib/privacy/respond";
import { refuseCreatorSession } from "@/lib/fan/creatorGuard";
import { consentEvidence } from "@/lib/fan/consentEvidence";

// A fan acknowledges the age-gate / ToS. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  const body = await parseJsonBody<{ token?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || !body.token || body.token.length > 256) {
    return badRequest();
  }
  const token = body.token;
  // ATK-01: consent is the fan's own; the creator's session cannot stamp it.
  // First, so it never spends the fan's budgets below.
  const refused = await refuseCreatorSession(req, token);
  if (refused) return refused;
  return withFanMissLimit(req, async () => {
    // WF-03: keyed on the address AND the link, so a crowd behind one carrier
    // address (21 fans opening a drop together) is not one bucket.
    const limited = await rateLimitOr429(await tokenKey("ack:" + clientIp(req), token), 20, 60_000);
    if (limited) return limited;
    // TS-05: the acknowledgement keeps keyed digests of the address and
    // browser it came from (never the values), readable by admins only.
    const result = await ackFan(token, consentEvidence(req));
    if ("error" in result) return errorResponse(result.error);
    return NextResponse.json(result);
  });
}
