import { NextResponse } from "next/server";
import { getMyInvites, respondToOrgInvite } from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";
import { limitRoute } from "@/lib/api/limit";

// Pending agency invites for the signed-in creator.
export async function GET(req: Request) {
  const rateLimited = await limitRoute(req, "invites:GET");
  if (rateLimited) return rateLimited;
  const invites = await getMyInvites();
  return NextResponse.json({ invites });
}

// Accept or decline an invite. Body: { inviteId, accept }.
export async function POST(req: Request) {
  const rateLimited = await limitRoute(req, "invites:POST", "costly");
  if (rateLimited) return rateLimited;
  const body = await parseJsonBody<{ inviteId?: string; accept?: boolean }>(req);
  if (body === BAD_REQUEST) return badRequest();
  if (!body.inviteId) return badRequest();
  const result = await respondToOrgInvite(body.inviteId, Boolean(body.accept));
  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
