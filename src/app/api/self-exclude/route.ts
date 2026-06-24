import { NextResponse } from "next/server";
import { selfExclude } from "@/lib/data";
import { clientIp, rateLimitOr429 } from "@/lib/api/limit";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// A fan pauses their own spin link. Body: { token }.
export async function POST(req: Request) {
  const limited = await rateLimitOr429("selfexclude:" + clientIp(req), 10, 60_000);
  if (limited) return limited;

  const body = await parseJsonBody<{ token?: string }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || !body.token) {
    return badRequest();
  }
  const result = await selfExclude(body.token);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
