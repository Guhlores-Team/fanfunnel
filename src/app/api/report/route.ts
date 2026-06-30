import { NextResponse } from "next/server";
import { reportCreator } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A fan reports the creator behind their token (predatory / rule-breaking).
export async function POST(req: Request) {
  const limited = await rateLimitOr429("report:" + clientIp(req), 5, 60_000);
  if (limited) return limited;

  const body = await parseJsonBody<{ token?: string; reason?: string; detail?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (
    typeof body.token !== "string" ||
    typeof body.reason !== "string" ||
    !body.token ||
    !body.reason ||
    body.reason.length > 200 ||
    (body.detail !== undefined &&
      (typeof body.detail !== "string" || body.detail.length > 2000))
  ) {
    return badRequest();
  }
  const result = await reportCreator(body.token, body.reason, body.detail);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
