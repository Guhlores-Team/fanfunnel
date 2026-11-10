import { NextResponse } from "next/server";
import { updateFanLink } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// PR-13: switch one of a fan's links off or on, and/or set when it expires,
// without blocking the fan. Body: { token, active?, expiresAt? } with at
// least one of the two; `expiresAt` is an ISO time in the future (at most a
// year out) or null for "never". The data layer checks the session and
// can_act_for(creator, 'grant'); RLS scopes the write to the creator's rows.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ fanId: string }> }
) {
  const rateLimited = await limitRoute(req, "fans/[fanId]/links:POST");
  if (rateLimited) return rateLimited;
  const { fanId } = await params;
  const body = await parseJsonBody<{ token?: unknown; active?: unknown; expiresAt?: unknown }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (typeof body.token !== "string") return badRequest();
  if (body.active === undefined && body.expiresAt === undefined) return badRequest();
  if (body.active !== undefined && typeof body.active !== "boolean") return badRequest();
  if (body.expiresAt !== undefined && body.expiresAt !== null && (typeof body.expiresAt !== "string" || body.expiresAt.length > 40)) return badRequest();
  const result = await updateFanLink(fanId, body.token, {
    ...(typeof body.active === "boolean" ? { active: body.active } : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt as string | null } : {}),
  });
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
