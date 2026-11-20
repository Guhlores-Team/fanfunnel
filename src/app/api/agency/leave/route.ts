import { NextResponse } from "next/server";
import { leaveOrg } from "@/lib/data";
import { isUuid } from "@/lib/data/shared";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// The signed-in user leaves an agency (its own seat, or the org it joined as a
// creator). org_leave (0071) acts on the caller's own rows only, so this route
// only validates and dispatches. Body: { orgId }.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "agency/leave:POST");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ orgId?: unknown }>(req);
  if (body === BAD_REQUEST || body === null || typeof body !== "object") return badRequest();
  if (typeof body.orgId !== "string" || !isUuid(body.orgId)) return badRequest("invalid_org");
  const result = await leaveOrg(body.orgId);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
