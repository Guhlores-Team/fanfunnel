import { NextResponse } from "next/server";
import { setFanLinkActive } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// PR-13: switch one of a fan's links off or on without blocking the fan.
// Body: { token, active }. The data layer checks the session and
// can_act_for(creator, 'grant'); RLS scopes the write to the creator's rows.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "fans/[fanId]/links:POST");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const body = await parseJsonBody<{ token?: unknown; active?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string" || typeof body.active !== "boolean") return badRequest();
  const result = await setFanLinkActive(fanId, body.token, body.active);
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
