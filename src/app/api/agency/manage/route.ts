import { NextResponse } from "next/server";
import {
  createOrg,
  inviteOrgCreator,
  revokeOrgInvite,
  removeOrgCreator,
  addOrgMember,
  removeOrgMember,
  scopeOrgCreator,
  type OrgRole,
} from "@/lib/data";
import { BAD_REQUEST, badRequest, errorResponse, parseJsonBody } from "@/lib/api/handler";

// Owner-guarded agency mutations. Each RPC re-checks ownership server-side, so
// this route only dispatches. Body: { action, ...args }.
export async function POST(req: Request) {
  const body = await parseJsonBody<Record<string, unknown>>(req);
  if (body === BAD_REQUEST) return badRequest();
  const action = body.action as string;
  const s = (k: string) => String(body[k] ?? "");

  let result: { ok: true } | { error: string };
  switch (action) {
    case "create_org":
      result = await createOrg(s("name"));
      break;
    case "add_creator": // sends an invite; the creator must accept
      result = await inviteOrgCreator(s("orgId"), s("email"));
      break;
    case "revoke_invite":
      result = await revokeOrgInvite(s("inviteId"));
      break;
    case "remove_creator":
      result = await removeOrgCreator(s("orgId"), s("creatorId"));
      break;
    case "add_member":
      result = await addOrgMember(s("orgId"), s("email"), s("role") as OrgRole);
      break;
    case "remove_member":
      result = await removeOrgMember(s("memberId"));
      break;
    case "scope_creator":
      result = await scopeOrgCreator(s("memberId"), s("creatorId"), Boolean(body.on));
      break;
    default:
      return badRequest("unknown_action");
  }

  if ("error" in result) return errorResponse(result.error);
  return NextResponse.json(result);
}
