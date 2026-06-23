import { NextResponse } from "next/server";
import { ackFan } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A fan acknowledges the age-gate / ToS. Token-gated (fans aren't authed).
export async function POST(req: Request) {
  const limited = rateLimitOr429("ack:" + clientIp(req), 20, 60_000);
  if (limited) return limited;

  const body = await parseJsonBody<{ token?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || !body.token) {
    return badRequest();
  }
  const result = await ackFan(body.token);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
